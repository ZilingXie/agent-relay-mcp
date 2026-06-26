#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
loadDotEnv(envPath);

const baseUrl = normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || "https://server.stellarix.space/agentrelay/api");
const wsBaseUrl = normalizeBaseUrl(process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl));
const agentId = process.env.AGENTRELAY_AGENT_ID || "";
const username = process.env.AGENTRELAY_USERNAME || "";
const token = process.env.AGENTRELAY_TOKEN || "";
const inboxDir = resolveHome(process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox"));
const hookCommand = process.env.AGENTRELAY_LISTENER_HOOK || "";
const reconnectMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONNECT_MS || "5000", 10);
const once = process.argv.includes("--once");

if (!agentId || !username || !token) {
  fail("Missing AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, or AGENTRELAY_TOKEN in .env");
}

await mkdir(inboxDir, { recursive: true });
console.error(`[agentrelay-listener] inbox: ${inboxDir}`);
console.error(`[agentrelay-listener] connecting as ${agentId} to ${wsBaseUrl}`);

while (true) {
  try {
    await listenOnce();
  } catch (error) {
    console.error(`[agentrelay-listener] disconnected: ${error.message}`);
  }
  if (once) break;
  await delay(reconnectMs);
}

async function listenOnce() {
  const socket = await connectWebSocket(`${wsBaseUrl}/workers/${encodeURIComponent(agentId)}/events/ws`, relayHeaders());
  try {
    while (true) {
      const frame = await readJsonFrame(socket);
      if (frame.type === "hello") {
        console.error(`[agentrelay-listener] hello ${frame.agentId}`);
        continue;
      }
      if (frame.type === "heartbeat") {
        console.error(`[agentrelay-listener] heartbeat ${frame.serverTime}`);
        continue;
      }
      if (frame.type === "task.pending") {
        const enriched = await enrichPendingEvent(frame).catch((error) => ({ event: frame, taskFetchError: error.message }));
        const eventPath = await writeInboxEvent(enriched);
        console.log(JSON.stringify({ ok: true, received: "task.pending", taskId: frame.taskId, eventId: frame.eventId, path: eventPath }));
        if (hookCommand) await runHook(eventPath);
        if (once) return;
        continue;
      }
      const eventPath = await writeInboxEvent({ event: frame });
      console.log(JSON.stringify({ ok: true, received: frame.type || "event", eventId: frame.eventId, path: eventPath }));
      if (hookCommand) await runHook(eventPath);
      if (once) return;
    }
  } finally {
    socket.destroy();
  }
}

async function enrichPendingEvent(event) {
  const taskResponse = await relayRequest("GET", `/tasks/${encodeURIComponent(event.taskId)}`);
  return { event, task: taskResponse.task };
}

async function writeInboxEvent(payload) {
  const safeEventId = String(payload.event?.eventId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeEventId}.json`;
  const eventPath = resolve(inboxDir, fileName);
  await writeFile(eventPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...payload }, null, 2)}\n`, { mode: 0o600 });
  return eventPath;
}

async function runHook(eventPath) {
  await new Promise((resolveHook) => {
    const child = spawn(hookCommand, [eventPath], { shell: true, stdio: "inherit", env: process.env });
    child.on("close", (code) => {
      if (code !== 0) console.error(`[agentrelay-listener] hook exited with ${code}`);
      resolveHook();
    });
    child.on("error", (error) => {
      console.error(`[agentrelay-listener] hook failed: ${error.message}`);
      resolveHook();
    });
  });
}

async function relayRequest(method, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...relayHeaders() },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

function connectWebSocket(url, headers) {
  return new Promise((resolveConnect, rejectConnect) => {
    const parsed = new URL(url);
    const isSecure = parsed.protocol === "wss:";
    const port = Number(parsed.port || (isSecure ? 443 : 80));
    const socket = isSecure
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
      : net.connect({ host: parsed.hostname, port });
    socket.setTimeout(15000);
    socket.once("error", rejectConnect);
    socket.once("timeout", () => rejectConnect(new Error("WebSocket connection timed out")));
    socket.once(isSecure ? "secureConnect" : "connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const lines = [
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        ""
      ];
      socket.write(lines.join("\r\n"));
    });
    let response = Buffer.alloc(0);
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      socket.off("error", rejectConnect);
      socket.setTimeout(0);
      const header = response.subarray(0, headerEnd).toString("utf8");
      if (!header.startsWith("HTTP/1.1 101") && !header.startsWith("HTTP/1.0 101")) {
        rejectConnect(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        socket.destroy();
        return;
      }
      const remaining = response.subarray(headerEnd + 4);
      socket.agentRelayReadBuffer = remaining;
      resolveConnect(socket);
    };
    socket.on("data", onData);
  });
}

async function readJsonFrame(socket) {
  const header = await readExact(socket, 2);
  const opcode = header[0] & 0x0f;
  const masked = Boolean(header[1] & 0x80);
  let length = header[1] & 0x7f;
  if (length === 126) length = (await readExact(socket, 2)).readUInt16BE(0);
  if (length === 127) length = Number((await readExact(socket, 8)).readBigUInt64BE(0));
  const mask = masked ? await readExact(socket, 4) : null;
  const payload = Buffer.from(await readExact(socket, length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  if (opcode === 8) throw new Error("received close frame");
  if (opcode !== 1) throw new Error(`expected text frame, got opcode ${opcode}`);
  return JSON.parse(payload.toString("utf8"));
}

function readExact(socket, size) {
  const buffered = socket.agentRelayReadBuffer || Buffer.alloc(0);
  if (buffered.length >= size) {
    const needed = buffered.subarray(0, size);
    socket.agentRelayReadBuffer = buffered.subarray(size);
    return Promise.resolve(needed);
  }
  const initial = buffered.length ? [buffered] : [];
  socket.agentRelayReadBuffer = Buffer.alloc(0);
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [...initial];
    let total = buffered.length;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total < size) return;
      cleanup();
      const data = Buffer.concat(chunks, total);
      const needed = data.subarray(0, size);
      const rest = data.subarray(size);
      socket.agentRelayReadBuffer = rest;
      resolveRead(needed);
    };
    const onEnd = () => {
      cleanup();
      rejectRead(new Error("socket closed"));
    };
    const onError = (error) => {
      cleanup();
      rejectRead(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function relayHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    "X-AgentRelay-Agent-Id": agentId,
    "X-AgentRelay-Username": username
  };
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function deriveWsUrl(value) {
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  return value;
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

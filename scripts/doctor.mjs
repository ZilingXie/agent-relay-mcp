#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { syncCurrentProtocol } from "./protocol-sync.mjs";
import { listenerStatusHealth, readJsonFrame } from "./agentrelay-listener-core.mjs";

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configPath = resolveHome(getArg("--config") || "~/.codex/config.toml");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
loadDotEnv(envPath);
const baseUrl = (process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const wsBaseUrl = (process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl)).replace(/\/+$/, "");
const inboxDir = resolveHome(process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox"));
const stateDir = resolveHome(process.env.AGENTRELAY_STATE_DIR || resolve(repoRoot, "state"));
const listenerStatusPath = resolveHome(process.env.AGENTRELAY_LISTENER_STATUS_PATH || resolve(inboxDir, "..", "listener-status.json"));
const listenerInactivityMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_INACTIVITY_MS || "90000", 10);
const inboxUiHost = process.env.AGENTRELAY_INBOX_UI_HOST || "127.0.0.1";
const inboxUiPort = process.env.AGENTRELAY_INBOX_UI_PORT || "8787";
let ok = true;

check("Node.js >= 18", Number.parseInt(process.versions.node.split(".")[0], 10) >= 18, `found ${process.versions.node}`);
check("mcp/server.mjs exists", existsSync(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
check("node_modules installed", existsSync(resolve(repoRoot, "node_modules/@modelcontextprotocol/sdk")), "run npm install if missing");
check("AgentRelay .env exists", existsSync(envPath), envPath);
check("AGENTRELAY_AGENT_ID configured", Boolean(process.env.AGENTRELAY_AGENT_ID), process.env.AGENTRELAY_AGENT_ID || "missing");
check("AGENTRELAY_USERNAME configured", Boolean(process.env.AGENTRELAY_USERNAME), process.env.AGENTRELAY_USERNAME || "missing");
check("AGENTRELAY_TOKEN configured", Boolean(process.env.AGENTRELAY_TOKEN), process.env.AGENTRELAY_TOKEN ? "present" : "missing");
check("Local inbox event directory exists", existsSync(inboxDir), inboxDir);
check("Local inbox state exists", existsSync(resolve(stateDir, "issues.json")), resolve(stateDir, "issues.json"));
check("Local inbox listener hook configured", Boolean(process.env.AGENTRELAY_LISTENER_HOOK), process.env.AGENTRELAY_LISTENER_HOOK ? "present" : "missing");

try {
  const listenerStatus = JSON.parse(await readFile(listenerStatusPath, "utf8"));
  const health = listenerStatusHealth(listenerStatus, { staleAfterMs: Math.max(listenerInactivityMs * 2, 180000) });
  check("Local listener connection is fresh", health.healthy, health.healthy ? `${health.ageMs}ms since activity` : health.reason);
} catch (error) {
  check("Local listener status exists", false, `${error.message} at ${listenerStatusPath}`);
}

if (existsSync(configPath)) {
  const config = await readFile(configPath, "utf8");
  check("Codex config contains agentrelay MCP", config.includes("[mcp_servers.agentrelay]"), configPath);
  check("Codex config points at this checkout", config.includes(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
  check("Codex config points at env file", config.includes(envPath), envPath);
} else {
  check("Codex config exists", false, `${configPath} not found`);
}

try {
  const response = await fetch(`${baseUrl}/health`, { headers: relayHeaders() });
  const health = await readJsonResponse(response);
  check("AgentRelay HTTP health", response.ok, `${response.status} ${response.statusText} at ${baseUrl}`);
  const protocol = health.protocol || {};
  check("AgentRelay protocol published", Boolean(protocol.version && protocol.schema_digest), `${protocol.version || "missing"} ${protocol.schema_digest || ""}`.trim());
} catch (error) {
  check("AgentRelay HTTP health", false, `${error.message} at ${baseUrl}`);
}

try {
  const result = await syncCurrentProtocol({ baseUrl, log: null });
  check("AgentRelay protocol bundle sync", true, `${result.version} ${result.schema_digest} -> ${result.cache_dir}`);
} catch (error) {
  check("AgentRelay protocol bundle sync", false, error.message);
}

try {
  const response = await fetch(`${baseUrl}/agents`, { headers: relayHeaders() });
  check("AgentRelay authenticated agents", response.ok, `${response.status} ${response.statusText} at ${baseUrl}/agents`);
} catch (error) {
  check("AgentRelay authenticated agents", false, `${error.message} at ${baseUrl}/agents`);
}

try {
  const hello = await websocketHello(`${wsBaseUrl}/workers/${encodeURIComponent(process.env.AGENTRELAY_AGENT_ID || "")}/events/ws`);
  check("AgentRelay WebSocket hello", hello.type === "hello" && hello.agentId === process.env.AGENTRELAY_AGENT_ID, `${wsBaseUrl} as ${process.env.AGENTRELAY_AGENT_ID}`);
} catch (error) {
  check("AgentRelay WebSocket hello", false, `${error.message} at ${wsBaseUrl}`);
}

try {
  const response = await fetch(`http://${inboxUiHost}:${inboxUiPort}/`);
  check("Local inbox UI", response.ok, `http://${inboxUiHost}:${inboxUiPort}/`);
} catch (error) {
  check("Local inbox UI", false, `${error.message} at http://${inboxUiHost}:${inboxUiPort}/`);
}

if (!ok) {
  process.exit(1);
}

function relayHeaders() {
  const headers = {};
  if (process.env.AGENTRELAY_TOKEN) headers.Authorization = `Bearer ${process.env.AGENTRELAY_TOKEN}`;
  if (process.env.AGENTRELAY_AGENT_ID) headers["X-AgentRelay-Agent-Id"] = process.env.AGENTRELAY_AGENT_ID;
  if (process.env.AGENTRELAY_USERNAME) headers["X-AgentRelay-Username"] = process.env.AGENTRELAY_USERNAME;
  headers["X-AgentRelay-Envelope"] = "v0.3";
  return headers;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text);
}

function websocketHello(url) {
  return new Promise((resolveHello, rejectHello) => {
    const parsed = new URL(url);
    const isSecure = parsed.protocol === "wss:";
    const port = Number(parsed.port || (isSecure ? 443 : 80));
    const socket = isSecure
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
      : net.connect({ host: parsed.hostname, port });
    socket.setTimeout(15000);
    socket.once("error", rejectHello);
    socket.once("timeout", () => rejectHello(new Error("WebSocket connection timed out")));
    socket.once(isSecure ? "secureConnect" : "connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const lines = [
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(relayHeaders()).map(([name, value]) => `${name}: ${value}`),
        "",
        ""
      ];
      socket.write(lines.join("\r\n"));
    });
    let response = Buffer.alloc(0);
    const onData = async (chunk) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      const header = response.subarray(0, headerEnd).toString("utf8");
      if (!header.startsWith("HTTP/1.1 101") && !header.startsWith("HTTP/1.0 101")) {
        socket.destroy();
        rejectHello(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        return;
      }
      const remaining = response.subarray(headerEnd + 4);
      socket.agentRelayReadBuffer = remaining;
      try {
        const hello = await readJsonFrame(socket, { inactivityMs: 15000 });
        socket.destroy();
        resolveHello(hello);
      } catch (error) {
        socket.destroy();
        rejectHello(error);
      }
    };
    socket.on("data", onData);
  });
}

function deriveWsUrl(value) {
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  return value;
}

function check(name, condition, detail) {
  const mark = condition ? "ok" : "fail";
  console.log(`${mark} - ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) ok = false;
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

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

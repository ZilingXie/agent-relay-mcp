#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { buildPendingEventPayload, readJsonFrame, reconcileAgentEvents, reconcileAgentEventsV05, reconcilePendingTasks } from "./agentrelay-listener-core.mjs";
import { recoverPendingTaskSyncs } from "./agentrelay-task-context-sync.mjs";
import { ensureTaskWorkspaceState } from "./agentrelay-task-workspace.mjs";
import { PROTOCOL_V05 } from "./agentrelay-v05.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
loadDotEnv(envPath);

const baseUrl = normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || "https://server.stellarix.space/agentrelay/api");
const wsBaseUrl = normalizeBaseUrl(process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl));
const agentId = process.env.AGENTRELAY_AGENT_ID || "";
const username = process.env.AGENTRELAY_USERNAME || "";
const token = process.env.AGENTRELAY_TOKEN || "";
const protocolVersion = process.env.AGENTRELAY_PROTOCOL_VERSION || "agent-collab-v0.3";
const isV05 = protocolVersion === PROTOCOL_V05;
const inboxDir = resolveHome(process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox"));
const stateRoot = resolveHome(process.env.AGENTRELAY_STATE_DIR || resolve(repoRoot, "state"));
const hookCommand = process.env.AGENTRELAY_LISTENER_HOOK || "";
const reconnectMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONNECT_MS || "5000", 10);
const inactivityMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_INACTIVITY_MS || "90000", 10);
const reconcileIntervalMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONCILE_MS || "300000", 10);
const statusPath = resolveHome(process.env.AGENTRELAY_LISTENER_STATUS_PATH || resolve(inboxDir, "..", "listener-status.json"));
const once = process.argv.includes("--once");
const readinessPublishMs = Number.parseInt(process.env.AGENTRELAY_READINESS_PUBLISH_MS || "60000", 10);
let lastReconciledAt = 0;
let lastReadinessPublishedAt = 0;
let listenerIdentity = null;
const listenerStatus = {
  version: 1,
  agentId,
  state: "starting",
  startedAt: new Date().toISOString()
};

if (!agentId || !username || !token) {
  fail("Missing AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, or AGENTRELAY_TOKEN in .env");
}

await mkdir(inboxDir, { recursive: true });
await mkdir(dirname(statusPath), { recursive: true });
if (isV05) await initializeV05Listener();
await updateListenerStatus({ state: "connecting" });
console.error(`[agentrelay-listener] inbox: ${inboxDir}`);
console.error(`[agentrelay-listener] connecting as ${agentId} to ${wsBaseUrl}`);

while (true) {
  try {
    await listenOnce();
  } catch (error) {
    console.error(`[agentrelay-listener] disconnected: ${error.message}`);
    await updateListenerStatus({ state: "disconnected", disconnectedAt: new Date().toISOString(), lastError: error.message });
    if (isV05 && listenerIdentity) await publishV05Readiness(false).catch(() => {});
  }
  if (once) break;
  await delay(reconnectMs);
}

async function listenOnce() {
  await updateListenerStatus({ state: "connecting", connectionStartedAt: new Date().toISOString() });
  const wsQuery = isV05
    ? `?${new URLSearchParams({ listener_instance_id: listenerIdentity.instanceId, readiness_epoch: String(listenerIdentity.epoch) })}`
    : "";
  const socket = await connectWebSocket(`${wsBaseUrl}/workers/${encodeURIComponent(agentId)}/events/ws${wsQuery}`, relayHeaders());
  try {
    while (true) {
      const frame = await readJsonFrame(socket, { inactivityMs });
      if (frame.type === "hello") {
        if (isV05 && (frame.listenerInstanceId !== listenerIdentity.instanceId || Number(frame.readinessEpoch) !== listenerIdentity.epoch)) {
          throw new Error("v0.5 hello does not match the registered Listener epoch");
        }
        console.error(`[agentrelay-listener] hello ${frame.agentId}`);
        await tryReconcilePending();
        if (isV05) await publishV05Readiness(true);
        await updateListenerStatus({ state: "connected", connectedAt: new Date().toISOString(), lastError: null, ready: isV05 ? true : undefined });
        continue;
      }
      if (frame.type === "heartbeat") {
        console.error(`[agentrelay-listener] heartbeat ${frame.serverTime}`);
        await updateListenerStatus({ state: "connected", lastHeartbeatAt: new Date().toISOString(), serverTime: frame.serverTime });
        if (Date.now() - lastReconciledAt >= reconcileIntervalMs) await tryReconcilePending();
        if (isV05 && Date.now() - lastReadinessPublishedAt >= readinessPublishMs) await publishV05Readiness(true);
        continue;
      }
      if (frame.type === "task.pending") {
        const eventPath = await writeInboxEvent(buildPendingEventPayload(frame));
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

async function tryReconcilePending() {
  try {
    const result = isV05 ? { discovered: 0, persisted: 0, failures: [] } : await reconcilePendingTasks({
      agentId,
      relayGet: (path) => relayRequest("GET", path),
      persist: async (payload) => {
        const eventPath = await writeInboxEvent(payload, { stableName: true });
        console.log(JSON.stringify({
          ok: true,
          received: "task.pending",
          recovered: true,
          taskId: payload.event.taskId,
          eventId: payload.event.eventId,
          path: eventPath
        }));
        if (hookCommand) await runHook(eventPath);
      }
    });
    const persistRecoveredEvent = async (payload) => {
      const eventPath = await writeInboxEvent(payload, { stableName: true });
      if (hookCommand) await runHook(eventPath);
    };
    const eventRecovery = isV05
      ? await reconcileAgentEventsV05({
          agentId,
          listenerInstanceId: listenerIdentity.instanceId,
          readinessEpoch: listenerIdentity.epoch,
          relayGet: (path) => relayRequest("GET", path),
          persist: persistRecoveredEvent
        })
      : await reconcileAgentEvents({
          agentId,
          relayGet: (path) => relayRequest("GET", path),
          persist: persistRecoveredEvent
        });
    const localRecovery = await recoverPendingTaskSyncs({
      stateRoot,
      fetchTask: (taskId) => relayRequest("GET", `/tasks/${encodeURIComponent(taskId)}`),
      localAgentId: agentId,
      maxAttempts: 2,
      retryDelayMs: Number(process.env.AGENTRELAY_CONTEXT_SYNC_RETRY_MS || 250)
    });
    lastReconciledAt = Date.now();
    await updateListenerStatus({
      lastReconciliationAt: new Date().toISOString(),
      reconciliationDiscovered: result.discovered,
      reconciliationPersisted: result.persisted,
      reconciliationFailed: result.failures.length,
      eventRecoveryDiscovered: eventRecovery.discovered,
      eventRecoveryPersisted: eventRecovery.persisted,
      eventRecoveryFailed: eventRecovery.failures.length,
      localSyncRecoveryDiscovered: localRecovery.discovered,
      localSyncRecoveryReady: localRecovery.ready,
      localSyncRecoveryFailed: localRecovery.failed,
      lastReconciliationError: null
    });
    console.error(`[agentrelay-listener] reconciliation discovered=${result.discovered} persisted=${result.persisted} failed=${result.failures.length}`);
    for (const failure of result.failures) {
      console.error(`[agentrelay-listener] recovery failed task=${failure.taskId || "(missing)"}: ${failure.error}`);
    }
  } catch (error) {
    console.error(`[agentrelay-listener] reconciliation failed: ${error.message}`);
    await updateListenerStatus({ lastReconciliationError: error.message });
  }
}

async function updateListenerStatus(patch) {
  Object.assign(listenerStatus, patch, { updatedAt: new Date().toISOString() });
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(listenerStatus, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statusPath);
  } catch (error) {
    console.error(`[agentrelay-listener] status write failed: ${error.message}`);
  }
}

async function writeInboxEvent(payload, { stableName = false } = {}) {
  const safeEventId = String(payload.event?.eventId || payload.event?.event_id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const fileName = stableName
    ? `${safeEventId}.json`
    : `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeEventId}.json`;
  const eventPath = resolve(inboxDir, fileName);
  await writeFile(eventPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...payload }, null, 2)}\n`, { mode: 0o600 });
  return eventPath;
}

async function runHook(eventPath) {
  await new Promise((resolveHook) => {
    const child = spawn(hookCommand, [eventPath], {
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(listenerIdentity ? {
          AGENTRELAY_LISTENER_INSTANCE_ID: listenerIdentity.instanceId,
          AGENTRELAY_READINESS_EPOCH: String(listenerIdentity.epoch)
        } : {})
      }
    });
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

async function initializeV05Listener() {
  if (!hookCommand || process.env.AGENTRELAY_ACK_ON_INBOX_RECEIVED !== "1") {
    throw new Error("Protocol v0.5 readiness requires the durable inbox hook and AGENTRELAY_ACK_ON_INBOX_RECEIVED=1");
  }
  const manifest = await relayRequest("GET", "/protocols/agent-collab/v0.5/manifest");
  if (manifest.version !== PROTOCOL_V05) throw new Error("Relay did not return the Protocol v0.5 manifest");
  await ensureTaskWorkspaceState({ stateRoot, workspaceVersion: 2 });
  const instanceId = `listener-${agentId}-${crypto.randomUUID()}`;
  const registered = await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness/register`, {
    listener_instance_id: instanceId,
    client_version: "0.5.0",
    workspace_version: "2",
    transport: "websocket"
  });
  const readiness = registered.readiness || registered.data?.readiness;
  if (!readiness?.readiness_epoch) throw new Error("Relay readiness registration is missing readiness_epoch");
  listenerIdentity = { instanceId, epoch: Number(readiness.readiness_epoch) };
  await publishV05Readiness(false);
  await updateListenerStatus({
    protocolVersion,
    listenerInstanceId: listenerIdentity.instanceId,
    readinessEpoch: listenerIdentity.epoch,
    workspaceVersion: 2,
    ready: false
  });
}

async function publishV05Readiness(ready) {
  await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness`, {
    listener_instance_id: listenerIdentity.instanceId,
    readiness_epoch: listenerIdentity.epoch,
    ready
  });
  lastReadinessPublishedAt = Date.now();
  await updateListenerStatus({ ready, readinessPublishedAt: new Date().toISOString() });
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

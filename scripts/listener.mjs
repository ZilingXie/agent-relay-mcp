#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import {
  buildPendingEventPayload,
  isStaleReadinessEpochError,
  parseHttpResponseHead,
  parseJsonResponseBody,
  probeV05DeliveryEndpoints,
  readJsonFrame,
  reconcileAgentEvents,
  reconcileAgentEventsV05,
  reconcileAgentEventsV06,
  reconcilePendingTasks,
  relayResponseError
} from "./agentrelay-listener-core.mjs";
import { recoverPendingTaskSyncs } from "./agentrelay-task-context-sync.mjs";
import { verifyWorkspaceV2Ready } from "./agentrelay-task-workspace.mjs";
import { PROTOCOL_V05 } from "./agentrelay-v05.mjs";
import { PROTOCOL_V06 } from "./agentrelay-v06.mjs";

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
const isV06 = protocolVersion === PROTOCOL_V06;
const isDurableProtocol = isV05 || isV06;
const inboxDir = resolveHome(process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox"));
const stateRoot = resolveHome(process.env.AGENTRELAY_STATE_DIR || resolve(repoRoot, "state"));
const hookCommand = process.env.AGENTRELAY_LISTENER_HOOK || "";
const reconnectMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONNECT_MS || "5000", 10);
const inactivityMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_INACTIVITY_MS || "90000", 10);
const reconcileIntervalMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONCILE_MS || "300000", 10);
const statusPath = resolveHome(process.env.AGENTRELAY_LISTENER_STATUS_PATH || resolve(inboxDir, "..", "listener-status.json"));
const once = process.argv.includes("--once");
const readinessPublishMs = Number.parseInt(process.env.AGENTRELAY_READINESS_PUBLISH_MS || "60000", 10);
const listenerInstanceId = isDurableProtocol ? `listener-${agentId}-${crypto.randomUUID()}` : "";
const clientVersion = isV06 ? "0.6.0" : "0.5.1";
let lastReconciledAt = 0;
let lastReadinessPublishedAt = 0;
let listenerIdentity = null;
let listenerRecoveryRequired = false;
const listenerStatus = {
  version: 1,
  agentId,
  state: "starting",
  relayReadiness: "unknown",
  pendingRemoteMessages: null,
  startedAt: new Date().toISOString()
};

if (!agentId || !username || !token) {
  fail("Missing AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, or AGENTRELAY_TOKEN in .env");
}

await mkdir(inboxDir, { recursive: true });
await mkdir(dirname(statusPath), { recursive: true });
if (isDurableProtocol) await initializeDurableListener();
await updateListenerStatus({ state: "connecting" });
console.error(`[agentrelay-listener] inbox: ${inboxDir}`);
console.error(`[agentrelay-listener] connecting as ${agentId} to ${wsBaseUrl}`);

while (true) {
  if (isDurableProtocol && listenerRecoveryRequired) {
    try {
      await recoverV05Listener();
    } catch (error) {
      const superseded = error.code === "listener_recovery_not_allowed";
      console.error(`[agentrelay-listener] recovery ${superseded ? "blocked" : "failed"}: ${error.message}`);
      await updateListenerStatus({
        state: superseded ? "superseded" : "disconnected",
        lastError: error.message,
        lastRecoveryError: error.message,
        relayReadiness: "stale",
        pendingRemoteMessages: null
      });
      if (once) break;
      await delay(reconnectMs);
      continue;
    }
  }
  try {
    await listenOnce();
  } catch (error) {
    console.error(`[agentrelay-listener] disconnected: ${error.message}`);
    await updateListenerStatus({
      state: "disconnected",
      disconnectedAt: new Date().toISOString(),
      lastError: error.message,
      relayReadiness: "stale",
      pendingRemoteMessages: null
    });
    if (isDurableProtocol && isStaleReadinessEpochError(error)) {
      listenerRecoveryRequired = true;
      await updateListenerStatus({ recoveryRequired: true });
    } else if (isDurableProtocol && listenerIdentity) {
      await publishDurableReadiness(false).catch(() => {});
    }
  }
  if (once) break;
  await delay(reconnectMs);
}

async function listenOnce() {
  if (isDurableProtocol && listenerIdentity?.qualified !== true) await qualifyDurableListener();
  await updateListenerStatus({ state: "connecting", connectionStartedAt: new Date().toISOString() });
  const wsQuery = isDurableProtocol
    ? `?${new URLSearchParams({ listener_instance_id: listenerIdentity.instanceId, readiness_epoch: String(listenerIdentity.epoch) })}`
    : "";
  const socket = await connectWebSocket(`${wsBaseUrl}/workers/${encodeURIComponent(agentId)}/events/ws${wsQuery}`, relayHeaders());
  try {
    while (true) {
      const frame = await readJsonFrame(socket, { inactivityMs });
      if (frame.type === "hello") {
        if (isDurableProtocol && (frame.protocolVersion !== protocolVersion
          || frame.listenerInstanceId !== listenerIdentity.instanceId
          || Number(frame.readinessEpoch) !== listenerIdentity.epoch)) {
          throw new Error(`${protocolVersion} hello does not match the registered Listener epoch`);
        }
        console.error(`[agentrelay-listener] hello ${frame.agentId}`);
        await tryReconcilePending({ required: isDurableProtocol });
        if (isDurableProtocol) await publishDurableReadiness(true);
        await updateListenerStatus({ state: "connected", connectedAt: new Date().toISOString(), lastError: null, ready: isDurableProtocol ? true : undefined });
        continue;
      }
      if (frame.type === "heartbeat") {
        console.error(`[agentrelay-listener] heartbeat ${frame.serverTime}`);
        await updateListenerStatus({ state: "connected", lastHeartbeatAt: new Date().toISOString(), serverTime: frame.serverTime });
        if (Date.now() - lastReconciledAt >= reconcileIntervalMs) await tryReconcilePending();
        if (isDurableProtocol && Date.now() - lastReadinessPublishedAt >= readinessPublishMs) await publishDurableReadiness(true);
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

async function tryReconcilePending({ required = false } = {}) {
  try {
    const result = isDurableProtocol ? { discovered: 0, persisted: 0, failures: [] } : await reconcilePendingTasks({
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
      const eventPath = await writeInboxEvent({
        ...payload,
        event: { ...payload.event, protocolVersion }
      }, { stableName: true });
      if (hookCommand) await runHook(eventPath);
    };
    const eventRecovery = isV06
      ? await reconcileAgentEventsV06({
          agentId,
          listenerInstanceId: listenerIdentity.instanceId,
          readinessEpoch: listenerIdentity.epoch,
          relayGet: (path) => relayRequest("GET", path),
          persist: persistRecoveredEvent
        })
      : isV05
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
    if (required && eventRecovery.failures.length > 0) {
      throw new Error(`${protocolVersion} Event recovery failed for ${eventRecovery.failures.length} Event(s)`);
    }
    lastReconciledAt = Date.now();
    await updateListenerStatus({
      lastReconciliationAt: new Date().toISOString(),
      reconciliationDiscovered: result.discovered,
      reconciliationPersisted: result.persisted,
      reconciliationFailed: result.failures.length,
      eventRecoveryDiscovered: eventRecovery.discovered,
      eventRecoveryPersisted: eventRecovery.persisted,
      eventRecoveryFailed: eventRecovery.failures.length,
      ...(isV06 ? {
        pendingRemoteMessages: eventRecovery.failures.length === 0 && eventRecovery.discovered < 500 ? 0 : null,
        lastRecovery: { at: new Date().toISOString(), ...eventRecovery.recovered }
      } : {}),
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
    await updateListenerStatus({ lastReconciliationError: error.message, pendingRemoteMessages: null });
    if (required) throw error;
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
  const temporaryPath = `${eventPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...payload }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, eventPath);
  JSON.parse(await readFile(eventPath, "utf8"));
  return eventPath;
}

async function runHook(eventPath) {
  await new Promise((resolveHook, rejectHook) => {
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
      if (code === 0) resolveHook();
      else rejectHook(new Error(`Listener hook exited with ${code}`));
    });
    child.on("error", (error) => {
      rejectHook(new Error(`Listener hook failed: ${error.message}`));
    });
  });
}

async function initializeDurableListener() {
  if (!hookCommand || process.env.AGENTRELAY_ACK_ON_INBOX_RECEIVED !== "1") {
    throw new Error(`${protocolVersion} readiness requires the durable inbox hook and AGENTRELAY_ACK_ON_INBOX_RECEIVED=1`);
  }
  await verifyDurableRuntime();
  await registerDurableListener();
  await qualifyDurableListener();
}

async function recoverV05Listener() {
  await updateListenerStatus({ state: "recovering", recoveryRequired: true, lastRecoveryError: null });
  await verifyDurableRuntime();
  await registerDurableListener({ recoverIfStale: true });
  listenerRecoveryRequired = false;
  try {
    await qualifyDurableListener();
  } catch (error) {
    if (isStaleReadinessEpochError(error)) listenerRecoveryRequired = true;
    throw error;
  }
}

async function verifyDurableRuntime() {
  const versionPath = protocolVersion.slice("agent-collab-".length);
  const manifest = await relayRequest("GET", `/protocols/agent-collab/${versionPath}/manifest`);
  if (manifest.version !== protocolVersion) throw new Error(`Relay did not return the ${protocolVersion} manifest`);
  await verifyWorkspaceV2Ready({ stateRoot });
}

async function registerDurableListener({ recoverIfStale = false } = {}) {
  const registered = await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness/register`, {
    listener_instance_id: listenerInstanceId,
    client_version: clientVersion,
    workspace_version: "2",
    transport: "websocket",
    ...(recoverIfStale ? { recover_if_stale: true } : {})
  });
  const readiness = registered.readiness || registered.data?.readiness;
  if (!readiness?.readiness_epoch) throw new Error("Relay readiness registration is missing readiness_epoch");
  listenerIdentity = { instanceId: listenerInstanceId, epoch: Number(readiness.readiness_epoch), qualified: false };
}

async function qualifyDurableListener() {
  await probeV05DeliveryEndpoints({
    agentId,
    listenerInstanceId: listenerIdentity.instanceId,
    readinessEpoch: listenerIdentity.epoch,
    relayPost: relayProbe
  });
  await publishDurableReadiness(false);
  listenerIdentity.qualified = true;
  await updateListenerStatus({
    protocolVersion,
    listenerInstanceId: listenerIdentity.instanceId,
    readinessEpoch: listenerIdentity.epoch,
    workspaceVersion: 2,
    ready: false,
    relayReadiness: "stale",
    recoveryRequired: false,
    lastRecoveryError: null
  });
}

async function publishDurableReadiness(ready) {
  await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness`, {
    listener_instance_id: listenerIdentity.instanceId,
    readiness_epoch: listenerIdentity.epoch,
    ready
  });
  lastReadinessPublishedAt = Date.now();
  await updateListenerStatus({
    ready,
    relayReadiness: ready ? "fresh" : "stale",
    readinessPublishedAt: new Date().toISOString()
  });
}

async function relayRequest(method, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...relayHeaders() },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  const data = parseJsonResponseBody(text);
  if (!response.ok) throw relayResponseError(`${method} ${path}`, response.status, data);
  return data;
}

async function relayProbe(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...relayHeaders() },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
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
      const header = response.subarray(0, headerEnd).toString("utf8");
      let parsedHead;
      try {
        parsedHead = parseHttpResponseHead(header);
      } catch (error) {
        socket.off("data", onData);
        socket.off("error", rejectConnect);
        rejectConnect(error);
        socket.destroy();
        return;
      }
      const responseEnd = headerEnd + 4 + (parsedHead.status === 101 ? 0 : parsedHead.contentLength);
      if (response.length < responseEnd) return;
      socket.off("data", onData);
      socket.off("error", rejectConnect);
      socket.setTimeout(0);
      if (parsedHead.status !== 101) {
        const bodyText = response.subarray(headerEnd + 4, responseEnd).toString("utf8");
        const body = parseJsonResponseBody(bodyText);
        rejectConnect(relayResponseError("WebSocket upgrade", parsedHead.status, body));
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

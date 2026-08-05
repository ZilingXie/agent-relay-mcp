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
  BoundedAsyncQueue,
  isStaleReadinessEpochError,
  parseHttpResponseHead,
  parseJsonResponseBody,
  probeV05DeliveryEndpoints,
  reconcileAgentEvents,
  reconcileAgentEventsV05,
  reconcileAgentEventsV06,
  reconcilePendingTasks,
  relayResponseError,
  WebSocketFrameReader
} from "./agentrelay-listener-core.mjs";
import { recoverPendingTaskSyncs } from "./agentrelay-task-context-sync.mjs";
import { verifyWorkspaceV2Ready } from "./agentrelay-task-workspace.mjs";
import { PROTOCOL_V05 } from "./agentrelay-v05.mjs";
import { PROTOCOL_V06 } from "./agentrelay-v06.mjs";
import { negotiateCurrentProtocol } from "./protocol-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
loadDotEnv(envPath);

const baseUrl = normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || "https://server.stellarix.space/agentrelay/api");
const wsBaseUrl = normalizeBaseUrl(process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl));
const agentId = process.env.AGENTRELAY_AGENT_ID || "";
const username = process.env.AGENTRELAY_USERNAME || "";
const token = process.env.AGENTRELAY_TOKEN || "";
if (!agentId || !username || !token) {
  fail("Missing AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, or AGENTRELAY_TOKEN in .env");
}

const configuredProtocolVersion = process.env.AGENTRELAY_LISTENER_LANE_CHILD === "1"
  ? process.env.AGENTRELAY_PROTOCOL_VERSION
  : await resolveRelayCurrentProtocolVersion();
if (!configuredProtocolVersion) fail("Listener lane child requires AGENTRELAY_PROTOCOL_VERSION");
const compatibilityProtocolVersions = String(process.env.AGENTRELAY_COMPAT_PROTOCOL_VERSIONS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const listenerProtocolLanes = [...new Set([configuredProtocolVersion, ...compatibilityProtocolVersions])];
if (process.env.AGENTRELAY_LISTENER_LANE_CHILD !== "1" && listenerProtocolLanes.length > 1) {
  await superviseProtocolLanes(listenerProtocolLanes);
  process.exit(process.exitCode || 0);
}

const protocolVersion = configuredProtocolVersion;
const isV05 = protocolVersion === PROTOCOL_V05;
const isV06 = protocolVersion === PROTOCOL_V06;
const isDurableProtocol = isV05 || isV06;
const inboxDir = resolveHome(process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox"));
const stateRoot = resolveHome(process.env.AGENTRELAY_STATE_DIR || resolve(repoRoot, "state"));
const hookCommand = process.env.AGENTRELAY_LISTENER_HOOK || "";
const reconnectMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONNECT_MS || "5000", 10);
const inactivityMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_INACTIVITY_MS || "90000", 10);
const frameQueueMax = positiveInt(process.env.AGENTRELAY_LISTENER_FRAME_QUEUE_MAX, 256);
const hookQueueMax = positiveInt(process.env.AGENTRELAY_LISTENER_HOOK_QUEUE_MAX, 256);
const reconcileIntervalMs = Number.parseInt(process.env.AGENTRELAY_LISTENER_RECONCILE_MS || "300000", 10);
const statusPath = resolveHome(process.env.AGENTRELAY_LISTENER_STATUS_PATH || resolve(inboxDir, "..", "listener-status.json"));
const deliveryIndexPath = `${statusPath}.delivery-index.json`;
const once = process.argv.includes("--once");
const readinessPublishMs = Number.parseInt(process.env.AGENTRELAY_READINESS_PUBLISH_MS || "60000", 10);
const listenerInstanceId = isDurableProtocol ? `listener-${agentId}-${crypto.randomUUID()}` : "";
const clientVersion = isV06 ? "0.6.0" : "0.5.1";
let lastReconciledAt = 0;
let lastReadinessPublishedAt = 0;
let listenerIdentity = null;
let listenerRecoveryRequired = false;
let activeHookJob = null;
let hookWorkerStarted = false;
let statusWriteChain = Promise.resolve();
let deliveryIndexWriteChain = Promise.resolve();
const deliveryJobs = new Map();
const completedDeliveries = new Map();
const listenerStatus = {
  version: 1,
  agentId,
  state: "starting",
  relayReadiness: "unknown",
  pendingRemoteMessages: null,
  reader: {
    state: "starting",
    depth: 0,
    capacity: frameQueueMax,
    paused: false,
    pauseCount: 0,
    resumeCount: 0,
    bufferedBytes: 0,
    framesReceived: 0,
    lastFrameAt: null
  },
  queue: {
    depth: 0,
    capacity: hookQueueMax,
    pendingProducers: 0,
    active: 0
  },
  hook: {
    state: "idle",
    total: 0,
    succeeded: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    lastFailureAt: null
  },
  lastAck: null,
  startedAt: new Date().toISOString()
};

const hookQueue = new BoundedAsyncQueue({
  maxSize: hookQueueMax,
  name: "listener hook queue",
  onChange: (stats) => {
    void updateListenerStatus({
      queue: {
        ...listenerStatus.queue,
        depth: stats.depth,
        capacity: stats.capacity,
        pendingProducers: stats.pendingProducers,
        active: activeHookJob ? 1 : 0
      }
    });
  }
});

await mkdir(inboxDir, { recursive: true });
await mkdir(dirname(statusPath), { recursive: true });
if (hookCommand) await loadCompletedDeliveries();
if (isDurableProtocol) await initializeDurableListener();
startHookWorker();
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
    ? `?${new URLSearchParams({
      listener_instance_id: listenerIdentity.instanceId,
      readiness_epoch: String(listenerIdentity.epoch),
      protocol_version: protocolVersion
    })}`
    : "";
  const socket = await connectWebSocket(`${wsBaseUrl}/workers/${encodeURIComponent(agentId)}/events/ws${wsQuery}`, relayHeaders());
  const reader = new WebSocketFrameReader(socket, {
    inactivityMs,
    maxQueue: frameQueueMax
  });
  socket.agentRelayFrameReader = reader;
  try {
    while (true) {
      const frame = await reader.nextJson();
      await updateListenerStatus({ reader: reader.stats });
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
        const delivery = await enqueueDelivery(buildPendingEventPayload(frame), { source: "websocket" });
        console.log(JSON.stringify({ ok: true, received: "task.pending", taskId: frame.taskId, eventId: frame.eventId, path: delivery.eventPath, queued: true }));
        if (once) {
          const outcome = await delivery.completion;
          if (!outcome.ok) throw new Error(outcome.error || "Listener hook failed");
          return;
        }
        continue;
      }
      const delivery = await enqueueDelivery({ event: frame }, { source: "websocket" });
      console.log(JSON.stringify({ ok: true, received: frame.type || "event", eventId: frame.eventId, path: delivery.eventPath, queued: true }));
      if (once) {
        const outcome = await delivery.completion;
        if (!outcome.ok) throw new Error(outcome.error || "Listener hook failed");
        return;
      }
    }
  } finally {
    reader.close();
    socket.destroy();
  }
}

async function tryReconcilePending({ required = false } = {}) {
  try {
    const result = isDurableProtocol ? { discovered: 0, persisted: 0, failures: [] } : await reconcilePendingTasks({
      agentId,
      relayGet: (path) => relayRequest("GET", path),
      persist: async (payload) => {
        const delivery = await enqueueDelivery(payload, {
          source: "http_recovery",
          awaitCompletion: required
        });
        console.log(JSON.stringify({
          ok: true,
          received: "task.pending",
          recovered: true,
          taskId: payload.event.taskId,
          eventId: payload.event.eventId,
          path: delivery.eventPath,
          queued: true
        }));
      }
    });
    const persistRecoveredEvent = async (payload) => {
      const delivery = await enqueueDelivery({
        ...payload,
        event: { ...payload.event, protocolVersion }
      }, {
        source: "http_recovery",
        awaitCompletion: required
      });
      return delivery;
    };
    const eventRecovery = isV06
      ? await reconcileAgentEventsV06({
          agentId,
          listenerInstanceId: listenerIdentity.instanceId,
          readinessEpoch: listenerIdentity.epoch,
          protocolVersion,
          relayGet: (path) => relayRequest("GET", path),
          persist: persistRecoveredEvent
        })
      : isV05
        ? await reconcileAgentEventsV05({
          agentId,
          listenerInstanceId: listenerIdentity.instanceId,
          readinessEpoch: listenerIdentity.epoch,
          protocolVersion,
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
  const nextStatus = { ...listenerStatus, ...patch, updatedAt: new Date().toISOString() };
  Object.assign(listenerStatus, nextStatus);
  statusWriteChain = statusWriteChain
    .catch(() => {})
    .then(async () => {
      const temporaryPath = `${statusPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(nextStatus, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, statusPath);
      } catch (error) {
        console.error(`[agentrelay-listener] status write failed: ${error.message}`);
      }
    });
  return statusWriteChain;
}

async function superviseProtocolLanes(protocolVersions) {
  const primaryProtocol = protocolVersions[0];
  const defaultInboxDir = resolveHome(
    process.env.AGENTRELAY_INBOX_DIR || resolve(repoRoot, ".agentrelay", "inbox")
  );
  const primaryStatusPath = resolveHome(
    process.env.AGENTRELAY_LISTENER_STATUS_PATH || resolve(defaultInboxDir, "..", "listener-status.json")
  );
  const children = protocolVersions.map((laneProtocol) => {
    const laneSuffix = laneProtocol.slice("agent-collab-".length).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTRELAY_LISTENER_LANE_CHILD: "1",
        AGENTRELAY_PROTOCOL_VERSION: laneProtocol,
        AGENTRELAY_LISTENER_STATUS_PATH: laneProtocol === primaryProtocol
          ? primaryStatusPath
          : `${primaryStatusPath}.${laneSuffix}`
      }
    });
    return { laneProtocol, child };
  });
  const stopChildren = (signal = "SIGTERM") => {
    for (const { child } of children) {
      if (!child.killed) child.kill(signal);
    }
  };
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    stopChildren("SIGINT");
  });
  process.once("SIGTERM", () => {
    stopping = true;
    stopChildren("SIGTERM");
  });
  const exits = children.map(({ laneProtocol, child }) => new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ laneProtocol, code, signal }));
  }));
  if (process.argv.includes("--once")) {
    const results = await Promise.all(exits);
    process.exitCode = results.some(({ code }) => code !== 0) ? 1 : 0;
    return;
  }
  const first = await Promise.race(exits);
  stopChildren();
  await Promise.all(exits);
  if (!stopping && (first.code !== 0 || first.signal)) {
    console.error(`[agentrelay-listener] ${first.laneProtocol} lane exited unexpectedly`);
    process.exitCode = 1;
  }
}

async function writeInboxEvent(payload, { stableName = false } = {}) {
  const eventId = payload.event?.eventId || payload.event?.event_id;
  const messageId = payload.event?.messageId || payload.event?.message_id;
  const safeEventId = String(eventId || messageId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, "_");
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

function startHookWorker() {
  if (hookWorkerStarted || !hookCommand) return;
  hookWorkerStarted = true;
  void (async () => {
    while (true) {
      let job;
      try {
        job = await hookQueue.pop();
      } catch {
        return;
      }
      activeHookJob = job;
      await updateListenerStatus({
        queue: { ...listenerStatus.queue, depth: hookQueue.depth, pendingProducers: hookQueue.pendingProducers, active: 1 },
        hook: {
          ...listenerStatus.hook,
          state: "running",
          currentKey: job.identity.keys[0] || null,
          lastError: null
        }
      });
      let outcome;
      try {
        const hookResult = await runHook(job.eventPath);
        outcome = hookResult.ackRequired && !hookResult.acked && !hookResult.nacked
          ? { ...hookResult, ok: false, error: hookResult.ackError?.message || hookResult.ackError || "Listener hook did not ACK the event" }
          : { ok: true, ...hookResult };
      } catch (error) {
        outcome = { ok: false, error: error.message };
      }
      await finalizeDelivery(job, outcome);
      activeHookJob = null;
      await updateListenerStatus({
        queue: { ...listenerStatus.queue, depth: hookQueue.depth, pendingProducers: hookQueue.pendingProducers, active: 0 }
      });
    }
  })().catch((error) => {
    console.error(`[agentrelay-listener] hook worker stopped: ${error.message}`);
    void updateListenerStatus({
      hook: { ...listenerStatus.hook, state: "failed", lastError: error.message, lastFailureAt: new Date().toISOString() }
    });
  });
}

async function enqueueDelivery(payload, { source = "websocket", awaitCompletion = false } = {}) {
  const identity = deliveryIdentity(payload);
  const existing = findDelivery(identity.keys);
  if (existing) {
    if (awaitCompletion) await assertDeliveryOutcome(existing.completion);
    return { eventPath: existing.eventPath, completion: existing.completion, deduped: true, source };
  }
  const eventPath = await writeInboxEvent(payload, { stableName: true });
  if (!hookCommand) {
    const completion = Promise.resolve({ ok: true, hookSkipped: true });
    return { eventPath, completion, deduped: false, source };
  }
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const job = { payload, eventPath, identity, source, completion, resolveCompletion };
  for (const key of identity.keys) deliveryJobs.set(key, job);
  try {
    await hookQueue.push(job);
  } catch (error) {
    await finalizeDelivery(job, { ok: false, error: error.message });
  }
  if (awaitCompletion) await assertDeliveryOutcome(completion);
  return { eventPath, completion, deduped: false, source };
}

async function assertDeliveryOutcome(completion) {
  const outcome = await completion;
  if (!outcome.ok) throw new Error(outcome.error || "Listener hook failed");
  return outcome;
}

function deliveryIdentity(payload) {
  const event = payload?.event || {};
  const eventId = event.eventId || event.event_id || event.payload?.eventId || event.payload?.event_id || "";
  const messageId = event.messageId || event.message_id
    || event.payload?.messageId || event.payload?.message_id
    || payload?.task?.current_message_id || payload?.task?.currentMessageId || "";
  const keys = deliveryKeys(eventId, messageId);
  if (!keys.length) keys.push(`anonymous:${crypto.randomUUID()}`);
  return { eventId, messageId, keys };
}

function deliveryKeys(eventId, messageId) {
  const keys = [];
  if (eventId) keys.push(`event:${eventId}`);
  if (messageId) keys.push(`message:${messageId}`);
  return keys;
}

function findDelivery(keys) {
  for (const key of keys) {
    const job = deliveryJobs.get(key);
    if (job) return job;
    const completed = completedDeliveries.get(key);
    if (completed) return completed;
  }
  return null;
}

async function finalizeDelivery(job, outcome) {
  for (const key of job.identity.keys) {
    if (deliveryJobs.get(key) === job) deliveryJobs.delete(key);
  }
  const now = new Date().toISOString();
  if (outcome.ok) {
    job.completedAt = now;
    for (const key of job.identity.keys) {
      completedDeliveries.delete(key);
      completedDeliveries.set(key, job);
    }
    while (completedDeliveries.size > 4096) completedDeliveries.delete(completedDeliveries.keys().next().value);
    try {
      await persistCompletedDeliveries();
    } catch (error) {
      console.error(`[agentrelay-listener] delivery index write failed: ${error.message}`);
    }
  }
  const hook = listenerStatus.hook;
  void updateListenerStatus({
    hook: outcome.ok
      ? { ...hook, state: "idle", total: hook.total + 1, succeeded: hook.succeeded + 1, consecutiveFailures: 0, lastSuccessAt: now, lastError: null, currentKey: null }
      : { ...hook, state: "failed", total: hook.total + 1, failed: hook.failed + 1, consecutiveFailures: hook.consecutiveFailures + 1, lastFailureAt: now, lastError: outcome.error || "unknown hook failure", currentKey: null }
  });
  if (outcome.acked || outcome.nacked) {
    void updateListenerStatus({
      lastAck: {
        eventId: job.identity.eventId || null,
        messageId: job.identity.messageId || null,
        status: outcome.nacked ? "delivery_failed" : "received",
        at: now
      }
    });
  }
  job.resolveCompletion(outcome);
}

async function loadCompletedDeliveries() {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(deliveryIndexPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`[agentrelay-listener] delivery index read failed: ${error.message}`);
    return;
  }
  const records = Array.isArray(snapshot?.deliveries) ? snapshot.deliveries : [];
  for (const record of records.slice(-2048)) {
    const eventId = record?.eventId || record?.event_id || "";
    const messageId = record?.messageId || record?.message_id || "";
    const keys = deliveryKeys(eventId, messageId);
    if (!keys.length || typeof record?.eventPath !== "string" || !record.eventPath) continue;
    const job = {
      eventPath: record.eventPath,
      identity: { eventId, messageId, keys },
      completion: Promise.resolve({ ok: true, deduped: true, persisted: true }),
      completedAt: record.completedAt || null
    };
    for (const key of keys) {
      completedDeliveries.delete(key);
      completedDeliveries.set(key, job);
    }
  }
  while (completedDeliveries.size > 4096) completedDeliveries.delete(completedDeliveries.keys().next().value);
}

async function persistCompletedDeliveries() {
  const jobs = [];
  const seen = new Set();
  for (const job of completedDeliveries.values()) {
    if (seen.has(job) || (!job.identity.eventId && !job.identity.messageId)) continue;
    seen.add(job);
    jobs.push({
      eventId: job.identity.eventId || null,
      messageId: job.identity.messageId || null,
      eventPath: job.eventPath,
      completedAt: job.completedAt || null
    });
  }
  const snapshot = `${JSON.stringify({ version: 1, deliveries: jobs.slice(-4096) }, null, 2)}\n`;
  deliveryIndexWriteChain = deliveryIndexWriteChain
    .catch(() => {})
    .then(async () => {
      const temporaryPath = `${deliveryIndexPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, snapshot, { mode: 0o600 });
      await rename(temporaryPath, deliveryIndexPath);
    });
  return deliveryIndexWriteChain;
}

async function runHook(eventPath) {
  return new Promise((resolveHook, rejectHook) => {
    let stdout = "";
    const child = spawn(hookCommand, [eventPath], {
      shell: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        ...(listenerIdentity ? {
          AGENTRELAY_LISTENER_INSTANCE_ID: listenerIdentity.instanceId,
          AGENTRELAY_READINESS_EPOCH: String(listenerIdentity.epoch)
        } : {})
      }
    });
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65536);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectHook(new Error(`Listener hook exited with ${code}`));
        return;
      }
      resolveHook(parseHookResult(stdout));
    });
    child.on("error", (error) => {
      rejectHook(new Error(`Listener hook failed: ${error.message}`));
    });
  });
}

function parseHookResult(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const result = JSON.parse(line);
      if (result && typeof result === "object") return result;
    } catch {
      // Custom hooks may emit human-readable output.
    }
  }
  return {};
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
  const query = new URLSearchParams({ protocol_version: protocolVersion });
  const registered = await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness/register?${query}`, {
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
  const query = new URLSearchParams({ protocol_version: protocolVersion });
  await relayRequest("POST", `/workers/${encodeURIComponent(agentId)}/readiness?${query}`, {
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
      socket.pause();
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

async function resolveRelayCurrentProtocolVersion() {
  const result = await negotiateCurrentProtocol({
    baseUrl,
    headers: relayHeaders(),
    log: null
  });
  if (result.status === "client_release_required") {
    throw new Error("Relay current protocol requires a newer AgentRelay client runtime");
  }
  const version = result.active?.version;
  if (![PROTOCOL_V05, PROTOCOL_V06].includes(version)) {
    throw new Error(`Relay current protocol ${version || "unknown"} is outside the Listener's compiled protocol range`);
  }
  return version;
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

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

import crypto from "node:crypto";

export class RelayResponseError extends Error {
  constructor(message, { status, body = {} } = {}) {
    super(message);
    this.name = "RelayResponseError";
    this.status = status;
    this.body = body;
    this.code = body?.code || body?.error || "";
  }
}

export function relayResponseError(operation, status, body = {}) {
  return new RelayResponseError(
    `${operation} failed (${status}): ${JSON.stringify(body)}`,
    { status, body }
  );
}

export function isStaleReadinessEpochError(error) {
  return error instanceof RelayResponseError
    && error.status === 409
    && error.code === "stale_readiness_epoch";
}

export function parseHttpResponseHead(header) {
  const lines = String(header).split("\r\n");
  const match = lines[0]?.match(/^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/);
  if (!match) throw new Error("Invalid HTTP response status line");
  let contentLength = 0;
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() === "content-length") {
      contentLength = Number.parseInt(line.slice(separator + 1).trim(), 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error("Invalid HTTP Content-Length");
      }
    }
  }
  return { status: Number(match[1]), contentLength };
}

export function parseJsonResponseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export function unwrapTask(response) {
  return response?.data?.task || response?.task || null;
}

export function unwrapPendingTasks(response) {
  const tasks = response?.data?.tasks || response?.tasks || [];
  return Array.isArray(tasks) ? tasks : [];
}

export function unwrapAgentEvents(response) {
  const events = response?.data?.events || response?.events || [];
  return Array.isArray(events) ? events : [];
}

export function buildPendingEventPayload(event) {
  const taskId = event?.taskId || event?.task_id;
  if (!taskId) throw new Error("Pending event is missing task id");
  return { event };
}

export function buildRecoveryEvent({ task, agentId }) {
  const taskId = task?.task_id || task?.taskId;
  if (!taskId) throw new Error("Pending task snapshot is missing task id");
  const goalVersion = task.goal_version ?? task.goalVersion ?? 0;
  const updatedAt = task.updated_at ?? task.updatedAt ?? 0;
  const pendingOnAgentId = task.pending_on_agent_id || task.pendingOnAgentId || agentId;
  const identity = `${taskId}:${goalVersion}:${updatedAt}:${pendingOnAgentId}`;
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return {
    eventId: `recovery_${digest}`,
    type: "task.pending",
    eventType: "task.pending",
    agentId,
    taskId,
    pendingOnAgentId,
    reason: "listener.recovery",
    recovery: true
  };
}

export function listenerStatusHealth(status, { now = Date.now(), staleAfterMs = 180000 } = {}) {
  if (!status || status.state !== "connected") return { healthy: false, reason: status?.state || "missing" };
  const activityAt = Date.parse(status.lastHeartbeatAt || status.connectedAt || "");
  if (!Number.isFinite(activityAt)) return { healthy: false, reason: "missing activity timestamp" };
  const ageMs = Math.max(0, now - activityAt);
  return ageMs <= staleAfterMs
    ? { healthy: true, ageMs }
    : { healthy: false, reason: `activity stale by ${ageMs}ms`, ageMs };
}

export function listenerOperationalStatus(status = {}, options = {}) {
  const state = String(status.state || "missing");
  const health = listenerStatusHealth(status, options);
  const lastError = String(status.lastError || "");
  let suggestedAction = "none";
  if (/ENOSPC|no space left|disk full/i.test(lastError)) {
    suggestedAction = "free_local_storage";
  } else if (state === "superseded" || /listener_recovery_not_allowed|stale_readiness_epoch/i.test(lastError)) {
    suggestedAction = "inspect_active_listener";
  } else if (/unauthorized|forbidden|authentication|\b401\b|\b403\b/i.test(lastError)) {
    suggestedAction = "check_credentials";
  } else if (!health.healthy) {
    suggestedAction = "restart_listener";
  }
  return {
    state,
    healthy: health.healthy,
    lastHeartbeatAt: status.lastHeartbeatAt || status.connectedAt || null,
    relayReadiness: status.relayReadiness || "unknown",
    pendingRemoteMessages: Number.isInteger(status.pendingRemoteMessages)
      ? status.pendingRemoteMessages
      : null,
    lastRecovery: normalizeRecovery(status.lastRecovery),
    suggestedAction,
    lastError: lastError || null
  };
}

export function v05ReadinessHealth(agent, listenerStatus) {
  return durableReadinessHealth(agent, listenerStatus, "agent-collab-v0.5");
}

export function durableReadinessHealth(agent, listenerStatus, protocolVersion) {
  const failures = [];
  if (!agent) failures.push("agent missing from Relay registry");
  if (!listenerStatus) failures.push("local Listener status missing");
  if (agent && listenerStatus) {
    if (agent.agent_id !== listenerStatus.agentId) failures.push("agent id mismatch");
    if (agent.enabled !== true) failures.push("agent disabled");
    if (!(agent.protocol_capabilities || []).includes(protocolVersion)) failures.push(`${protocolVersion.slice("agent-collab-".length)} capability missing`);
    if (agent.readiness_protocol_version !== protocolVersion) failures.push("readiness protocol mismatch");
    if (agent.ready !== true) failures.push("Relay readiness is false");
    if (agent.readiness_fresh !== true) failures.push("Relay readiness is stale");
    if (String(agent.workspace_version || "") !== "2") failures.push("workspace version mismatch");
    if (agent.transport !== "websocket") failures.push("transport mismatch");
    if (agent.listener_instance_id !== listenerStatus.listenerInstanceId) failures.push("Listener instance mismatch");
    if (Number(agent.readiness_epoch) !== Number(listenerStatus.readinessEpoch)) failures.push("readiness epoch mismatch");
  }
  return failures.length === 0
    ? { healthy: true }
    : { healthy: false, reason: failures.join(", "), failures };
}

export async function reconcilePendingTasks({ agentId, relayGet, persist }) {
  const pendingResponse = await relayGet(`/workers/${encodeURIComponent(agentId)}/pending`);
  const pendingTasks = unwrapPendingTasks(pendingResponse);
  const failures = [];
  let persisted = 0;

  for (const summary of pendingTasks) {
    const taskId = summary?.task_id || summary?.taskId;
    if (!taskId) {
      failures.push({ taskId: "", error: "Pending task summary is missing task id" });
      continue;
    }
    try {
      const taskResponse = await relayGet(`/tasks/${encodeURIComponent(taskId)}`);
      const task = unwrapTask(taskResponse);
      if (!task) throw new Error("Task response is missing task snapshot");
      await persist({ event: buildRecoveryEvent({ task, agentId }), task });
      persisted += 1;
    } catch (error) {
      failures.push({ taskId, error: error.message });
    }
  }

  return { discovered: pendingTasks.length, persisted, failures };
}

export async function reconcileAgentEvents({ agentId, relayGet, persist }) {
  const response = await relayGet(`/workers/${encodeURIComponent(agentId)}/events?include_acked=false&limit=500`);
  const events = unwrapAgentEvents(response);
  const failures = [];
  let persisted = 0;
  for (const event of events) {
    const eventId = event?.event_id || event?.eventId;
    if (!eventId) {
      failures.push({ eventId: "", error: "Agent event is missing event id" });
      continue;
    }
    try {
      await persist({ event });
      persisted += 1;
    } catch (error) {
      failures.push({ eventId, error: error.message });
    }
  }
  return { discovered: events.length, persisted, failures };
}

export async function reconcileAgentEventsV05({
  agentId,
  listenerInstanceId,
  readinessEpoch,
  relayGet,
  persist,
  limit = 500
}) {
  const failures = [];
  let discovered = 0;
  let persisted = 0;
  const seen = new Set();
  const query = new URLSearchParams({
    listener_instance_id: listenerInstanceId,
    readiness_epoch: String(readinessEpoch)
  });
  while (discovered < limit) {
    const response = await relayGet(`/workers/${encodeURIComponent(agentId)}/events?${query}`);
    const events = unwrapAgentEvents(response);
    if (!events.length) break;
    const event = events[0];
    discovered += 1;
    const eventId = event?.event_id || event?.eventId;
    if (!eventId) {
      failures.push({ eventId: "", error: "Agent event is missing event id" });
      break;
    }
    if (seen.has(eventId)) break;
    seen.add(eventId);
    try {
      await persist({ event });
      persisted += 1;
    } catch (error) {
      failures.push({ eventId, error: error.message });
      break;
    }
  }
  return { discovered, persisted, failures };
}

export async function reconcileAgentEventsV06(options) {
  const recovered = {
    total: 0,
    newTasks: 0,
    expiredWhileOffline: 0,
    failedWhileOffline: 0
  };
  const result = await reconcileAgentEventsV05({
    ...options,
    persist: async (payload) => {
      await options.persist(payload);
      const event = payload.event || {};
      const eventType = event.event_type || event.eventType;
      const status = event.payload?.status;
      recovered.total += 1;
      if (eventType === "message.pending") recovered.newTasks += 1;
      if (eventType === "task.status_changed" && status === "expired") recovered.expiredWhileOffline += 1;
      if (eventType === "task.status_changed" && status === "failed") recovered.failedWhileOffline += 1;
    }
  });
  return { ...result, recovered };
}

function normalizeRecovery(value) {
  if (!value || typeof value !== "object") return null;
  return {
    at: value.at || null,
    total: nonNegativeInt(value.total),
    newTasks: nonNegativeInt(value.newTasks),
    expiredWhileOffline: nonNegativeInt(value.expiredWhileOffline),
    failedWhileOffline: nonNegativeInt(value.failedWhileOffline)
  };
}

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function probeV05DeliveryEndpoints({
  agentId,
  listenerInstanceId,
  readinessEpoch,
  relayPost
}) {
  const probeId = `readiness-probe-${listenerInstanceId}`;
  const common = {
    task_id: probeId,
    event_id: probeId,
    message_id: probeId,
    turn_sequence: 1,
    expected_task_version: 1,
    listener_instance_id: listenerInstanceId,
    readiness_epoch: readinessEpoch
  };
  const probes = [
    {
      name: "ack",
      path: `/workers/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(probeId)}/ack`,
      payload: { ...common, idempotency_key: `${probeId}-ack` }
    },
    {
      name: "nack",
      path: `/workers/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(probeId)}/delivery-fail`,
      payload: { ...common, reason: "listener_persistence_failed", idempotency_key: `${probeId}-nack` }
    }
  ];
  for (const probe of probes) {
    const response = await relayPost(probe.path, probe.payload);
    const code = response?.body?.code || response?.body?.error?.code;
    const compatible = (response?.status === 404 && code === "task_not_found")
      || (response?.status === 503 && code === "mutations_closed");
    if (!compatible) {
      throw new Error(`Protocol v0.5 ${probe.name.toUpperCase()} endpoint compatibility check failed (${response?.status || "unknown"}/${code || "unknown"})`);
    }
  }
  return { ack: true, nack: true };
}

export async function readJsonFrame(socket, { inactivityMs }) {
  while (true) {
    const frame = await readFrameWithTimeout(socket, inactivityMs);
    if (frame.opcode === 8) throw new Error("received close frame");
    if (frame.opcode === 9) {
      socket.write(encodeClientFrame(10, frame.payload));
      continue;
    }
    if (frame.opcode === 10) continue;
    if (frame.opcode !== 1) throw new Error(`expected text frame, got opcode ${frame.opcode}`);
    return JSON.parse(frame.payload.toString("utf8"));
  }
}

async function readFrameWithTimeout(socket, inactivityMs) {
  if (!Number.isFinite(inactivityMs) || inactivityMs <= 0) return readFrame(socket);
  let timer;
  try {
    return await Promise.race([
      readFrame(socket),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`WebSocket inactive for ${inactivityMs}ms`));
        }, inactivityMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readFrame(socket) {
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
  return { opcode, payload };
}

function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  const lengthBytes = length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length <= 0xffff
      ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
      : (() => {
          const header = Buffer.alloc(10);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(length), 2);
          return header;
        })();
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) maskedPayload[index] ^= mask[index % 4];
  return Buffer.concat([lengthBytes, mask, maskedPayload]);
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
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total < size) return;
      cleanup();
      const data = Buffer.concat(chunks, total);
      socket.agentRelayReadBuffer = data.subarray(size);
      resolveRead(data.subarray(0, size));
    };
    const onEnd = () => rejectClosed("socket ended");
    const onClose = () => rejectClosed("socket closed");
    const onError = (error) => {
      cleanup();
      rejectRead(error);
    };
    const rejectClosed = (message) => {
      cleanup();
      rejectRead(new Error(message));
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

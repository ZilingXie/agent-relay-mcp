import crypto from "node:crypto";

export class BoundedAsyncQueue {
  constructor({ maxSize = 256, name = "queue", onChange = () => {} } = {}) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error(`${name} maxSize must be a positive integer`);
    }
    this.name = name;
    this.maxSize = maxSize;
    this.items = [];
    this.waitingConsumers = [];
    this.waitingProducers = [];
    this.closed = false;
    this.closeError = null;
    this.onChange = onChange;
  }

  get depth() {
    return this.items.length;
  }

  get pendingProducers() {
    return this.waitingProducers.length;
  }

  get isFull() {
    return this.items.length >= this.maxSize;
  }

  get stats() {
    return {
      name: this.name,
      depth: this.items.length,
      capacity: this.maxSize,
      pendingProducers: this.waitingProducers.length,
      closed: this.closed
    };
  }

  push(value) {
    if (this.closed) return Promise.reject(this.closeError || new Error(`${this.name} is closed`));
    if (this.waitingConsumers.length) {
      this.waitingConsumers.shift().resolve(value);
      this.notify();
      return Promise.resolve();
    }
    if (!this.isFull) {
      this.items.push(value);
      this.notify();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waitingProducers.push({ value, resolve, reject });
      this.notify();
    });
  }

  pop() {
    if (this.items.length) {
      const value = this.items.shift();
      this.acceptWaitingProducer();
      this.notify();
      return Promise.resolve(value);
    }
    if (this.closed) return Promise.reject(this.closeError || new Error(`${this.name} is closed`));
    return new Promise((resolve, reject) => {
      this.waitingConsumers.push({ resolve, reject });
    });
  }

  close(error = new Error(`${this.name} is closed`)) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const consumer of this.waitingConsumers.splice(0)) consumer.reject(error);
    for (const producer of this.waitingProducers.splice(0)) producer.reject(error);
    this.notify();
  }

  acceptWaitingProducer() {
    if (this.closed || this.isFull || !this.waitingProducers.length) return;
    const producer = this.waitingProducers.shift();
    this.items.push(producer.value);
    producer.resolve();
  }

  notify() {
    try {
      this.onChange(this.stats);
    } catch {
      // Metrics must never affect delivery.
    }
  }
}

export class WebSocketFrameReader {
  constructor(socket, {
    inactivityMs = 90000,
    maxQueue = 256,
    lowWatermark = Math.max(0, Math.floor(maxQueue / 2)),
    initialData = null
  } = {}) {
    if (!socket || typeof socket.on !== "function") throw new Error("WebSocket frame reader requires a socket");
    if (!Number.isInteger(maxQueue) || maxQueue <= 0) throw new Error("WebSocket frame queue max must be a positive integer");
    this.socket = socket;
    this.inactivityMs = Number.isFinite(inactivityMs) && inactivityMs > 0 ? inactivityMs : 0;
    this.maxQueue = maxQueue;
    this.lowWatermark = Math.min(maxQueue - 1, Math.max(0, lowWatermark));
    this.queue = [];
    this.waiters = [];
    this.buffer = Buffer.concat([
      socket.agentRelayReadBuffer || Buffer.alloc(0),
      initialData || Buffer.alloc(0)
    ]);
    socket.agentRelayReadBuffer = Buffer.alloc(0);
    this.closed = false;
    this.closeError = null;
    this.pausedByBackpressure = false;
    this.pauseCount = 0;
    this.resumeCount = 0;
    this.timer = null;
    this.lastDataAt = Date.now();
    this.lastFrameAt = null;
    this.framesReceived = 0;
    this.onData = (chunk) => {
      if (this.closed) return;
      this.lastDataAt = Date.now();
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
      this.parseAvailableFrames();
      this.armInactivityTimer();
    };
    this.onEnd = () => this.fail(new Error("socket ended"));
    this.onClose = () => this.fail(new Error("socket closed"));
    this.onError = (error) => this.fail(error);
    socket.on("data", this.onData);
    socket.once("end", this.onEnd);
    socket.once("close", this.onClose);
    socket.once("error", this.onError);
    this.parseAvailableFrames();
    if (!this.pausedByBackpressure && typeof socket.resume === "function") socket.resume();
    this.armInactivityTimer();
  }

  get stats() {
    return {
      state: this.closed ? "closed" : this.pausedByBackpressure ? "paused" : "reading",
      depth: this.queue.length,
      capacity: this.maxQueue,
      bufferedBytes: this.buffer.length,
      paused: this.pausedByBackpressure,
      pauseCount: this.pauseCount,
      resumeCount: this.resumeCount,
      framesReceived: this.framesReceived,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null
    };
  }

  async nextJson() {
    const frame = await this.nextFrame();
    try {
      return JSON.parse(frame.payload.toString("utf8"));
    } catch (error) {
      throw new Error(`Invalid WebSocket JSON frame: ${error.message}`);
    }
  }

  nextFrame() {
    if (this.queue.length) {
      const frame = this.queue.shift();
      this.maybeResume();
      return Promise.resolve(frame);
    }
    if (this.closed) return Promise.reject(this.closeError || new Error("WebSocket frame reader is closed"));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  parseAvailableFrames() {
    while (!this.closed) {
      if (this.queue.length >= this.maxQueue && !this.waiters.length) {
        this.pauseForBackpressure();
        return;
      }
      const frame = this.takeFrame();
      if (!frame) return;
      this.lastFrameAt = Date.now();
      if (frame.opcode === 8) {
        this.fail(new Error("received close frame"));
        return;
      }
      if (frame.opcode === 9) {
        this.socket.write(encodeClientFrame(10, frame.payload));
        continue;
      }
      if (frame.opcode === 10) continue;
      if (frame.opcode !== 1) {
        this.fail(new Error(`expected text frame, got opcode ${frame.opcode}`));
        return;
      }
      this.framesReceived += 1;
      if (this.waiters.length) {
        this.waiters.shift().resolve(frame);
      } else {
        this.queue.push(frame);
      }
    }
  }

  takeFrame() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) headerLength += 2;
    if (payloadLength === 127) headerLength += 8;
    if (this.buffer.length < headerLength) return null;
    if (payloadLength === 126) payloadLength = this.buffer.readUInt16BE(2);
    if (payloadLength === 127) {
      const length = this.buffer.readBigUInt64BE(2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail(new Error("WebSocket frame is too large"));
        return null;
      }
      payloadLength = Number(length);
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (this.buffer.length < frameLength) return null;
    let offset = headerLength;
    const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
    this.buffer = this.buffer.subarray(frameLength);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    return { opcode, payload };
  }

  pauseForBackpressure() {
    if (this.pausedByBackpressure || this.closed) return;
    this.pausedByBackpressure = true;
    this.pauseCount += 1;
    this.socket.pause();
  }

  maybeResume() {
    if (!this.pausedByBackpressure || this.closed || this.queue.length > this.lowWatermark) return;
    this.pausedByBackpressure = false;
    this.resumeCount += 1;
    this.parseAvailableFrames();
    if (!this.pausedByBackpressure) this.socket.resume();
  }

  armInactivityTimer() {
    if (!this.inactivityMs || this.closed) return;
    clearTimeout(this.timer);
    const remaining = Math.max(1, this.inactivityMs - (Date.now() - this.lastDataAt));
    this.timer = setTimeout(() => {
      if (Date.now() - this.lastDataAt < this.inactivityMs) {
        this.armInactivityTimer();
        return;
      }
      if (this.queue.length || this.buffer.length || this.pausedByBackpressure) {
        this.lastDataAt = Date.now();
        this.armInactivityTimer();
        return;
      }
      this.fail(new Error(`WebSocket inactive for ${this.inactivityMs}ms`));
      this.socket.destroy();
    }, remaining);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    clearTimeout(this.timer);
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onError);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close() {
    this.fail(new Error("WebSocket frame reader closed"));
  }
}

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
  const messageId = task.current_message_id || task.currentMessageId || "";
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
    recovery: true,
    ...(messageId ? { messageId } : {})
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
  const hook = normalizeHookStatus(status.hook);
  const reader = normalizeReaderStatus(status.reader);
  const queue = normalizeQueueStatus(status.queue);
  let suggestedAction = "none";
  if (/ENOSPC|no space left|disk full/i.test(lastError)) {
    suggestedAction = "free_local_storage";
  } else if (hook.state === "failed") {
    suggestedAction = "inspect_hook";
  } else if (queue.capacity > 0 && queue.depth >= queue.capacity) {
    suggestedAction = "inspect_hook_queue";
  } else if (state === "superseded" || /listener_recovery_not_allowed|stale_readiness_epoch/i.test(lastError)) {
    suggestedAction = "inspect_active_listener";
  } else if (/unauthorized|forbidden|authentication|\b401\b|\b403\b/i.test(lastError)) {
    suggestedAction = "check_credentials";
  } else if (!health.healthy) {
    suggestedAction = "restart_listener";
  }
  return {
    state,
    healthy: health.healthy && hook.state !== "failed",
    lastHeartbeatAt: status.lastHeartbeatAt || status.connectedAt || null,
    relayReadiness: status.relayReadiness || "unknown",
    pendingRemoteMessages: Number.isInteger(status.pendingRemoteMessages)
      ? status.pendingRemoteMessages
      : null,
    reader,
    queue,
    hook,
    lastAck: normalizeLastAck(status.lastAck),
    lastRecovery: normalizeRecovery(status.lastRecovery),
    suggestedAction,
    lastError: lastError || null
  };
}

function normalizeReaderStatus(value) {
  const reader = value && typeof value === "object" ? value : {};
  return {
    state: reader.state || "unknown",
    depth: nonNegativeInt(reader.depth),
    capacity: positiveOrZeroInt(reader.capacity),
    paused: reader.paused === true,
    pauseCount: nonNegativeInt(reader.pauseCount),
    resumeCount: nonNegativeInt(reader.resumeCount),
    bufferedBytes: nonNegativeInt(reader.bufferedBytes),
    framesReceived: nonNegativeInt(reader.framesReceived),
    lastFrameAt: reader.lastFrameAt || null
  };
}

function normalizeQueueStatus(value) {
  const queue = value && typeof value === "object" ? value : {};
  return {
    depth: nonNegativeInt(queue.depth),
    capacity: positiveOrZeroInt(queue.capacity),
    pendingProducers: nonNegativeInt(queue.pendingProducers),
    active: nonNegativeInt(queue.active)
  };
}

function normalizeHookStatus(value) {
  const hook = value && typeof value === "object" ? value : {};
  return {
    state: hook.state || "unknown",
    total: nonNegativeInt(hook.total),
    succeeded: nonNegativeInt(hook.succeeded),
    failed: nonNegativeInt(hook.failed),
    consecutiveFailures: nonNegativeInt(hook.consecutiveFailures),
    currentKey: hook.currentKey || null,
    lastError: hook.lastError || null,
    lastSuccessAt: hook.lastSuccessAt || null,
    lastFailureAt: hook.lastFailureAt || null
  };
}

function normalizeLastAck(value) {
  if (!value || typeof value !== "object") return null;
  return {
    eventId: value.eventId || null,
    messageId: value.messageId || null,
    status: value.status || "unknown",
    at: value.at || null
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
  protocolVersion = "agent-collab-v0.5",
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
    readiness_epoch: String(readinessEpoch),
    protocol_version: protocolVersion
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

function positiveOrZeroInt(value) {
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
  const reader = socket.agentRelayFrameReader instanceof WebSocketFrameReader
    ? socket.agentRelayFrameReader
    : (socket.agentRelayFrameReader = new WebSocketFrameReader(socket, { inactivityMs }));
  return reader.nextJson();
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

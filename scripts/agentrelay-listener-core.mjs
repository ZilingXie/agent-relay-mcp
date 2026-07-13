import crypto from "node:crypto";

export function unwrapTask(response) {
  return response?.data?.task || response?.task || null;
}

export function unwrapPendingTasks(response) {
  const tasks = response?.data?.tasks || response?.tasks || [];
  return Array.isArray(tasks) ? tasks : [];
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

import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  buildRecoveryEvent,
  listenerStatusHealth,
  readJsonFrame,
  reconcilePendingTasks,
  unwrapPendingTasks,
  unwrapTask
} from "../scripts/agentrelay-listener-core.mjs";

test("listenerStatusHealth rejects a stale connected listener", () => {
  assert.deepEqual(
    listenerStatusHealth({ state: "connected", lastHeartbeatAt: "2026-07-13T02:00:00.000Z" }, {
      now: Date.parse("2026-07-13T02:04:00.000Z"),
      staleAfterMs: 180000
    }),
    { healthy: false, reason: "activity stale by 240000ms", ageMs: 240000 }
  );
  assert.equal(listenerStatusHealth({
    state: "connected",
    connectedAt: "2026-07-13T02:03:30.000Z"
  }, {
    now: Date.parse("2026-07-13T02:04:00.000Z"),
    staleAfterMs: 180000
  }).healthy, true);
});

test("listener core unwraps current and legacy Relay envelopes", () => {
  const task = { task_id: "task_current" };
  const pending = [{ taskId: "task_current", goalVersion: 2 }];

  assert.equal(unwrapTask({ data: { task } }), task);
  assert.equal(unwrapTask({ task }), task);
  assert.deepEqual(unwrapPendingTasks({ data: { tasks: pending } }), pending);
  assert.deepEqual(unwrapPendingTasks({ tasks: pending }), pending);
});

test("buildRecoveryEvent derives a stable identity from the full task snapshot", () => {
  const task = {
    task_id: "task_recovery",
    goal_version: 3,
    updated_at: 1783908094,
    pending_on_agent_id: "zac-agent"
  };

  const first = buildRecoveryEvent({ task, agentId: "zac-agent" });
  const second = buildRecoveryEvent({ task, agentId: "zac-agent" });

  assert.deepEqual(second, first);
  assert.equal(first.type, "task.pending");
  assert.equal(first.taskId, "task_recovery");
  assert.match(first.eventId, /^recovery_[a-f0-9]{32}$/);
});

test("reconcilePendingTasks fetches full snapshots and reports per-task failures", async () => {
  const persisted = [];
  const requests = [];
  const result = await reconcilePendingTasks({
    agentId: "zac-agent",
    relayGet: async (path) => {
      requests.push(path);
      if (path.endsWith("/pending")) {
        return { data: { tasks: [{ taskId: "task_ok" }, { taskId: "task_failed" }] } };
      }
      if (path.endsWith("task_failed")) throw new Error("snapshot unavailable");
      return { data: { task: {
        task_id: "task_ok",
        goal_version: 1,
        updated_at: 123,
        pending_on_agent_id: "zac-agent"
      } } };
    },
    persist: async (payload) => persisted.push(payload)
  });

  assert.deepEqual(requests, [
    "/workers/zac-agent/pending",
    "/tasks/task_ok",
    "/tasks/task_failed"
  ]);
  assert.equal(result.discovered, 2);
  assert.equal(result.persisted, 1);
  assert.deepEqual(result.failures, [{ taskId: "task_failed", error: "snapshot unavailable" }]);
  assert.equal(persisted[0].task.task_id, "task_ok");
  assert.equal(persisted[0].event.reason, "listener.recovery");
});

test("readJsonFrame rejects an inactive half-open connection", async () => {
  const socket = new MemorySocket();

  await assert.rejects(
    readJsonFrame(socket, { inactivityMs: 10 }),
    /inactive for 10ms/
  );
  assert.equal(socket.destroyed, true);
});

test("readJsonFrame responds to ping and continues to the next text frame", async () => {
  const socket = new MemorySocket();
  const read = readJsonFrame(socket, { inactivityMs: 1000 });
  socket.push(frame(9, Buffer.from("health")));
  await new Promise((resolve) => setImmediate(resolve));
  socket.push(frame(1, Buffer.from(JSON.stringify({ type: "heartbeat", serverTime: 123 }))));

  assert.deepEqual(await read, { type: "heartbeat", serverTime: 123 });
  assert.equal(socket.writes.length, 1);
  assert.equal(socket.writes[0][0] & 0x0f, 10);
  socket.destroy();
});

class MemorySocket extends Duplex {
  constructor() {
    super();
    this.writes = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
}

function frame(opcode, payload) {
  assert(payload.length < 126);
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

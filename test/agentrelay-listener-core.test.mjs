import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  buildPendingEventPayload,
  buildRecoveryEvent,
  listenerStatusHealth,
  isStaleReadinessEpochError,
  parseHttpResponseHead,
  parseJsonResponseBody,
  probeV05DeliveryEndpoints,
  readJsonFrame,
  reconcileAgentEvents,
  reconcileAgentEventsV05,
  reconcilePendingTasks,
  unwrapPendingTasks,
  unwrapTask,
  v05ReadinessHealth,
  relayResponseError
} from "../scripts/agentrelay-listener-core.mjs";

test("Listener transport errors preserve structured HTTP and WebSocket conflicts", () => {
  assert.deepEqual(
    parseHttpResponseHead("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 78"),
    { status: 409, contentLength: 78 }
  );
  assert.deepEqual(parseJsonResponseBody('{"error":"stale_readiness_epoch","code":"stale_readiness_epoch"}'), {
    error: "stale_readiness_epoch",
    code: "stale_readiness_epoch"
  });
  assert.deepEqual(parseJsonResponseBody("proxy failure"), { error: "proxy failure" });

  const stale = relayResponseError("WebSocket upgrade", 409, {
    error: "stale_readiness_epoch",
    code: "stale_readiness_epoch"
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "stale_readiness_epoch");
  assert.deepEqual(stale.body, {
    error: "stale_readiness_epoch",
    code: "stale_readiness_epoch"
  });
  assert.equal(isStaleReadinessEpochError(stale), true);
  assert.equal(isStaleReadinessEpochError(relayResponseError("POST readiness", 409, {
    code: "stale_readiness_epoch"
  })), true);
  assert.equal(isStaleReadinessEpochError(relayResponseError("HTTP", 409, { code: "conflict" })), false);
  assert.equal(isStaleReadinessEpochError(relayResponseError("HTTP", 403, { code: "stale_readiness_epoch" })), false);
  assert.throws(() => parseHttpResponseHead("not HTTP"), /Invalid HTTP response status line/);
});

test("v0.5 readiness probes ACK and NACK endpoints without a business Task", async () => {
  const calls = [];
  const result = await probeV05DeliveryEndpoints({
    agentId: "frank-agent",
    listenerInstanceId: "listener-1",
    readinessEpoch: 3,
    relayPost: async (path, payload) => {
      calls.push({ path, payload });
      return { status: 503, body: { code: "mutations_closed" } };
    }
  });
  assert.deepEqual(result, { ack: true, nack: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /\/ack$/);
  assert.match(calls[1].path, /\/delivery-fail$/);
  assert.equal(calls[1].payload.reason, "listener_persistence_failed");
  assert.equal(calls[0].payload.readiness_epoch, 3);
});

test("v0.5 readiness rejects an incompatible delivery endpoint", async () => {
  await assert.rejects(
    probeV05DeliveryEndpoints({
      agentId: "frank-agent",
      listenerInstanceId: "listener-1",
      readinessEpoch: 3,
      relayPost: async () => ({ status: 404, body: { code: "ERROR" } })
    }),
    /ACK endpoint compatibility check failed/
  );
});

test("v0.5 recovery binds Listener epoch and drains one durable Event at a time", async () => {
  const persisted = [];
  let calls = 0;
  const result = await reconcileAgentEventsV05({
    agentId: "frank-agent",
    listenerInstanceId: "listener-1",
    readinessEpoch: 3,
    relayGet: async (path) => {
      assert.match(path, /listener_instance_id=listener-1/);
      assert.match(path, /readiness_epoch=3/);
      calls += 1;
      return calls <= 2
        ? { events: [{ event_id: `evt_${calls}`, task_id: `task_${calls}` }] }
        : { events: [] };
    },
    persist: async (payload) => persisted.push(payload.event.event_id)
  });
  assert.deepEqual(persisted, ["evt_1", "evt_2"]);
  assert.deepEqual(result, { discovered: 2, persisted: 2, failures: [] });
});

test("reconcileAgentEvents persists real unacked events for lifecycle-safe recovery", async () => {
  const persisted = [];
  const result = await reconcileAgentEvents({
    agentId: "frank-agent",
    relayGet: async (path) => {
      assert.equal(path, "/workers/frank-agent/events?include_acked=false&limit=500");
      return { events: [{ event_id: "aevt_v04", event_type: "task.message_pending", task_id: "task_v04" }] };
    },
    persist: async (payload) => persisted.push(payload)
  });
  assert.equal(result.persisted, 1);
  assert.equal(persisted[0].event.event_id, "aevt_v04");
});

test("buildPendingEventPayload persists only the notification summary", () => {
  const event = { type: "task.pending", eventId: "evt_summary", taskId: "task_summary", payloadRef: "/tasks/task_summary" };
  assert.deepEqual(buildPendingEventPayload(event), { event });
  assert.equal(Object.hasOwn(buildPendingEventPayload(event), "task"), false);
  assert.throws(() => buildPendingEventPayload({ type: "task.pending" }), /missing task id/);
});

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

test("v05ReadinessHealth matches Relay readiness to the installed Listener identity", () => {
  const status = {
    agentId: "zac-agent",
    listenerInstanceId: "listener-zac-1",
    readinessEpoch: 3
  };
  const agent = {
    agent_id: "zac-agent",
    enabled: true,
    protocol_capabilities: ["agent-collab-v0.5"],
    readiness_protocol_version: "agent-collab-v0.5",
    ready: true,
    readiness_fresh: true,
    workspace_version: "2",
    transport: "websocket",
    listener_instance_id: "listener-zac-1",
    readiness_epoch: 3
  };
  assert.deepEqual(v05ReadinessHealth(agent, status), { healthy: true });
  const mismatch = v05ReadinessHealth({ ...agent, readiness_epoch: 4, readiness_fresh: false }, status);
  assert.equal(mismatch.healthy, false);
  assert.deepEqual(mismatch.failures, ["Relay readiness is stale", "readiness epoch mismatch"]);
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

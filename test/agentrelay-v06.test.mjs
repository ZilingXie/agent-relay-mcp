import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import {
  listenerOperationalStatus,
  reconcileAgentEventsV06
} from "../scripts/agentrelay-listener-core.mjs";
import { createInboxUiServer, loadInboxSnapshot } from "../scripts/agentrelay-inbox-ui.mjs";
import { processInboxEvent } from "../scripts/agentrelay-inbox-intake.mjs";
import { readTaskWorkspace } from "../scripts/agentrelay-task-workspace.mjs";
import {
  buildCreatePayloadV06,
  PROTOCOL_V06
} from "../scripts/agentrelay-v06.mjs";
import { buildNegotiationRequest, SUPPORTED_PROTOCOL_VERSIONS } from "../scripts/protocol-runtime.mjs";

test("Protocol runtime and create payload support v0.6 without changing v0.5", () => {
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS.slice(0, 2), [
    "agent-collab-v0.6",
    "agent-collab-v0.5"
  ]);
  const payload = buildCreatePayloadV06({
    requesterAgentId: "zac-agent",
    targetAgentId: "vivi-agent",
    doneCriteria: "vivi receives the request",
    message: {
      subject: "Offline delivery",
      parts: [{ kind: "text", text: "ping" }]
    }
  }, "v06-create");
  assert.equal(payload.protocol_version, PROTOCOL_V06);
  assert.equal(payload.idempotency_key, "v06-create");
  assert.deepEqual(buildNegotiationRequest({ protocolVersion: PROTOCOL_V06 }).supported_protocol_versions, [
    PROTOCOL_V06,
    "agent-collab-v0.5"
  ]);
});

test("v0.6 epoch recovery drains durable Events and classifies offline outcomes", async () => {
  const persisted = [];
  const events = [
    {
      event_id: "evt_new",
      event_type: "message.pending",
      task_id: "task_new",
      can_transition_message: true,
      payload: {}
    },
    {
      event_id: "evt_expired",
      event_type: "task.status_changed",
      task_id: "task_expired",
      can_transition_message: false,
      payload: { status: "expired" }
    },
    {
      event_id: "evt_failed",
      event_type: "task.status_changed",
      task_id: "task_failed",
      can_transition_message: false,
      payload: { status: "failed" }
    }
  ];
  let index = 0;
  const result = await reconcileAgentEventsV06({
    agentId: "vivi-agent",
    listenerInstanceId: "listener-vivi",
    readinessEpoch: 4,
    relayGet: async (path) => {
      assert.match(path, /listener_instance_id=listener-vivi/);
      assert.match(path, /readiness_epoch=4/);
      return { events: index < events.length ? [events[index++]] : [] };
    },
    persist: async (payload) => persisted.push(payload.event.event_id)
  });
  assert.deepEqual(persisted, ["evt_new", "evt_expired", "evt_failed"]);
  assert.deepEqual(result.recovered, {
    total: 3,
    newTasks: 1,
    expiredWhileOffline: 1,
    failedWhileOffline: 1
  });
  assert.equal(result.failures.length, 0);
});

test("v0.6 recovery does not count or advance a locally unpersisted Event", async () => {
  let requests = 0;
  const result = await reconcileAgentEventsV06({
    agentId: "vivi-agent",
    listenerInstanceId: "listener-vivi",
    readinessEpoch: 5,
    relayGet: async () => ({
      events: requests++ === 0 ? [{
        event_id: "evt_unpersisted",
        event_type: "message.pending",
        payload: {}
      }] : []
    }),
    persist: async () => { throw new Error("ENOSPC"); }
  });
  assert.equal(result.persisted, 0);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.recovered, {
    total: 0,
    newTasks: 0,
    expiredWhileOffline: 0,
    failedWhileOffline: 0
  });
});

test("listener operational status gives state-specific recovery guidance", () => {
  const disconnected = listenerOperationalStatus({
    state: "disconnected",
    lastHeartbeatAt: "2026-07-28T01:34:00.000Z",
    relayReadiness: "stale",
    pendingRemoteMessages: null,
    lastRecovery: {
      at: "2026-07-28T01:35:00.000Z",
      total: 3,
      newTasks: 2,
      expiredWhileOffline: 1,
      failedWhileOffline: 0
    }
  });
  assert.equal(disconnected.healthy, false);
  assert.equal(disconnected.suggestedAction, "restart_listener");
  assert.equal(disconnected.pendingRemoteMessages, null);

  const superseded = listenerOperationalStatus({
    state: "superseded",
    lastError: "listener_recovery_not_allowed"
  });
  assert.equal(superseded.suggestedAction, "inspect_active_listener");

  const disk = listenerOperationalStatus({
    state: "disconnected",
    lastError: "ENOSPC: no space left on device"
  });
  assert.equal(disk.suggestedAction, "free_local_storage");

  const hookFailure = listenerOperationalStatus({
    state: "connected",
    connectedAt: "2026-07-28T01:34:00.000Z",
    hook: { state: "failed", lastError: "hook exited with 1" },
    queue: { depth: 1, capacity: 256 }
  }, { now: Date.parse("2026-07-28T01:35:00.000Z") });
  assert.equal(hookFailure.healthy, false);
  assert.equal(hookFailure.suggestedAction, "inspect_hook");
});

test("inbox snapshot includes local Listener health and recovery summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-ui-"));
  const stateRoot = join(root, "state");
  const listenerStatusPath = join(root, "listener-status.json");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify({
    version: 1,
    issues: {},
    events: {}
  }));
  await writeFile(listenerStatusPath, JSON.stringify({
    state: "connected",
    agentId: "zac-agent",
    lastHeartbeatAt: "2026-07-28T01:34:00.000Z",
    relayReadiness: "fresh",
    pendingRemoteMessages: 0,
    reader: { state: "reading", depth: 3, capacity: 256, paused: false, bufferedBytes: 0 },
    queue: { depth: 2, capacity: 256, active: 1 },
    hook: { state: "running", total: 8, succeeded: 7, failed: 1, consecutiveFailures: 0 },
    lastAck: { eventId: "evt_last_ack", status: "received", at: "2026-07-28T01:34:30.000Z" },
    lastRecovery: {
      at: "2026-07-28T01:33:00.000Z",
      total: 2,
      newTasks: 1,
      expiredWhileOffline: 1,
      failedWhileOffline: 0
    }
  }));

  const snapshot = await loadInboxSnapshot({
    stateRoot,
    localAgentId: "zac-agent",
    listenerStatusPath,
    now: () => "2026-07-28T01:35:00.000Z"
  });
  assert.equal(snapshot.listener.state, "connected");
  assert.equal(snapshot.listener.healthy, true);
  assert.equal(snapshot.listener.relayReadiness, "fresh");
  assert.equal(snapshot.listener.reader.depth, 3);
  assert.equal(snapshot.listener.queue.depth, 2);
  assert.equal(snapshot.listener.hook.state, "running");
  assert.equal(snapshot.listener.lastAck.eventId, "evt_last_ack");
  assert.equal(snapshot.listener.lastRecovery.expiredWhileOffline, 1);
});

test("v0.6 intake persists workspace v2 before epoch-bound Message ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const event = {
    event_id: "evt_v06_message",
    event_type: "message.pending",
    protocol_version: PROTOCOL_V06,
    task_id: "task_v06",
    message_id: "msg_v06",
    can_transition_message: true
  };
  const pending = v06Task("pending", "open", 1);
  await writeFile(eventPath, JSON.stringify({ event }));
  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "vivi-agent",
    listenerInstanceId: "listener-v06",
    readinessEpoch: 6,
    ackReceived: true,
    relayClient: {
      async getTask() { return pending; },
      async ackMessage(metadata) {
        const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_v06" });
        assert.equal(workspace.paths.workspaceVersion, 2);
        assert.equal(workspace.task.current_message_id, "msg_v06");
        assert.equal(metadata.payload.readiness_epoch, 6);
        return v06Task("delivered", "open", 2);
      }
    }
  });
  assert.equal(result.acked, true, JSON.stringify(result));
});

test("v0.6 expired notice uses epoch-bound informational ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-expired-"));
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ event: {
    event_id: "evt_v06_expired",
    event_type: "task.status_changed",
    protocol_version: PROTOCOL_V06,
    task_id: "task_v06",
    can_transition_message: false,
    payload: { status: "expired" }
  } }));
  let ackPayload;
  const result = await processInboxEvent({
    eventPath,
    stateRoot: join(root, "state"),
    projectPath: root,
    agentId: "vivi-agent",
    listenerInstanceId: "listener-v06",
    readinessEpoch: 7,
    ackReceived: true,
    relayClient: {
      async ackInformationalEvent({ payload }) { ackPayload = payload; return {}; },
      async getTask() { return v06Task("pending", "expired", 2); }
    }
  });
  assert.equal(result.acked, true);
  assert.equal(ackPayload.listener_instance_id, "listener-v06");
  assert.equal(ackPayload.readiness_epoch, 7);
});

test("local UI creates v0.6 Tasks and projects waiting_listener visibility", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-ui-create-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "task-drafts.json"), JSON.stringify({
    version: 1,
    drafts: {
      draft_v06: {
        draftId: "draft_v06",
        status: "drafted",
        to: "vivi-agent",
        from: "zac-agent",
        subject: "Offline request",
        requestText: "verify after reconnect",
        doneCriteria: "recovery succeeds",
        createdAt: "2026-07-28T01:00:00Z",
        updatedAt: "2026-07-28T01:00:00Z"
      }
    }
  }));
  let createPayload;
  const taskDetail = v06Task("pending", "open", 1);
  const server = createInboxUiServer({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient: {
      async createSemanticTask(semanticRequest) {
        createPayload = semanticRequest;
        return taskDetail;
      },
      async getTaskVisibilityBatch(taskIds) {
        assert.deepEqual(taskIds, ["task_v06"]);
        return { items: [{
          task: taskDetail.task,
          current_message: taskDetail.messages[0],
          outbox: { outbox_status: "parked", outbox_attempts: 0, recovery_attempts: 0 },
          diagnosis: "waiting_listener"
        }], errors: [] };
      }
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const createResponse = await fetch(`${base}/api/task-drafts/draft_v06/send`, { method: "POST" });
  assert.equal(createResponse.status, 201);
  assert.equal(createPayload.idempotencyKey, "local-ui-create-draft_v06");
  assert.equal(createPayload.requesterAgentId, "zac-agent");
  assert.equal(createPayload.input.targetAgentId, "vivi-agent");
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_v06" });
  assert.equal(workspace.paths.workspaceVersion, 2);
  const snapshot = await (await fetch(`${base}/api/issues`)).json();
  assert.equal(snapshot.issues[0].diagnosis, "waiting_listener");
  assert.equal(snapshot.issues[0].outboxStatus, "parked");
});

test("local UI includes Listener reader, queue, ACK, and hook health panels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-ui-health-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const server = createInboxUiServer({ stateRoot, localAgentId: "zac-agent" });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const app = await (await fetch(`http://127.0.0.1:${server.address().port}/app.js`)).text();
  assert.match(app, /Queue depth/);
  assert.match(app, /Last ACK/);
  assert.match(app, /Hook health/);
  assert.match(app, />Reader</);
});

function v06Task(deliveryStatus, status, taskVersion) {
  return {
    task: {
      task_id: "task_v06",
      root_task_id: "task_v06",
      protocol_version: PROTOCOL_V06,
      requester_agent_id: "zac-agent",
      target_agent_id: "vivi-agent",
      done_criteria: "receive offline request",
      status,
      current_message_id: "msg_v06",
      turn_sequence: 1,
      task_version: taskVersion,
      from_agent_id: "zac-agent",
      to_agent_id: "vivi-agent",
      max_turns: 3,
      updated_at: taskVersion
    },
    messages: [{
      message_id: "msg_v06",
      task_id: "task_v06",
      turn_sequence: 1,
      from_agent_id: "zac-agent",
      to_agent_id: "vivi-agent",
      delivery_status: deliveryStatus,
      parts: [{ kind: "text", text: "ping" }]
    }]
  };
}

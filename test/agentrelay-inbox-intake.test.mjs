import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { processInboxEvent } from "../scripts/agentrelay-inbox-intake.mjs";
import { readTaskWorkspace } from "../scripts/agentrelay-task-workspace.mjs";

function v05Detail({ messageId = "msg_v05", taskVersion = 1, deliveryStatus = "pending" } = {}) {
  return {
    task: {
      task_id: "task_v05", root_task_id: "task_v05", protocol_version: "agent-collab-v0.5",
      requester_agent_id: "zac-agent", target_agent_id: "frank-agent", done_criteria: "pong",
      status: "open", current_message_id: messageId, turn_sequence: 1, task_version: taskVersion,
      from_agent_id: "zac-agent", to_agent_id: "frank-agent", max_turns: 3, updated_at: taskVersion
    },
    messages: [{
      message_id: messageId, task_id: "task_v05", turn_sequence: 1,
      from_agent_id: "zac-agent", to_agent_id: "frank-agent",
      delivery_status: deliveryStatus, parts: [{ kind: "text", text: "ping" }]
    }]
  };
}

test("v0.5 current Message is verified in workspace v2 before versioned ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v05-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const event = {
    eventId: "evt_v05", type: "message.pending", protocolVersion: "agent-collab-v0.5",
    taskId: "task_v05", messageId: "msg_v05", agentId: "frank-agent",
    canTransitionMessage: true
  };
  await writeFile(eventPath, JSON.stringify({ event }));
  const calls = [];
  const detail = v05Detail();
  const result = await processInboxEvent({
    eventPath, stateRoot, projectPath: root, agentId: "frank-agent",
    listenerInstanceId: "listener-1", readinessEpoch: 4, ackReceived: true,
    relayClient: {
      async getTask() { calls.push("get"); return detail; },
      async ackMessage(metadata) {
        const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_v05" });
        assert.equal(workspace.paths.workspaceVersion, 2);
        assert.equal(workspace.task.messages[0].message_id, "msg_v05");
        assert.equal(metadata.payload.expected_task_version, 1);
        assert.equal(metadata.payload.readiness_epoch, 4);
        calls.push("ack");
        return v05Detail({ taskVersion: 2, deliveryStatus: "delivered" });
      }
    }
  });
  assert.deepEqual(calls, ["get", "ack"]);
  assert.equal(result.acked, true);
  assert.equal((await readTaskWorkspace({ stateRoot, taskId: "task_v05" })).task.task_version, 2);
});

test("v0.5 stale Message Event does not ACK a newer current Message", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v05-stale-"));
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ event: {
    eventId: "evt_old", type: "message.pending", protocolVersion: "agent-collab-v0.5",
    taskId: "task_v05", messageId: "msg_old", canTransitionMessage: true
  } }));
  let acked = 0;
  const result = await processInboxEvent({
    eventPath, stateRoot: join(root, "state"), projectPath: root, agentId: "frank-agent",
    listenerInstanceId: "listener-1", readinessEpoch: 4, ackReceived: true,
    relayClient: {
      async getTask() { return v05Detail({ messageId: "msg_new", taskVersion: 3 }); },
      async ackMessage() { acked += 1; }
    }
  });
  assert.equal(acked, 0);
  assert.equal(result.acked, false);
});

test("v0.5 informational Event uses non-recursive Event ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v05-info-"));
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ event: {
    eventId: "evt_info", type: "message.delivery_changed", protocolVersion: "agent-collab-v0.5",
    taskId: "task_v05", messageId: "msg_v05", canTransitionMessage: false
  } }));
  const calls = [];
  const result = await processInboxEvent({
    eventPath, stateRoot: join(root, "state"), projectPath: root, agentId: "zac-agent",
    listenerInstanceId: "listener-1", readinessEpoch: 4, ackReceived: true,
    relayClient: {
      async ackInformationalEvent({ payload }) {
        assert.equal(payload.listener_instance_id, "listener-1");
        calls.push("ack-info");
      },
      async getTask() { calls.push("get"); return v05Detail({ taskVersion: 2, deliveryStatus: "delivered" }); }
    }
  });
  assert.deepEqual(calls, ["ack-info", "get"]);
  assert.equal(result.acked, true);
});

test("v0.5 deterministic local persistence failure sends guarded NACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v05-nack-"));
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ event: {
    eventId: "evt_nack", type: "message.pending", protocolVersion: "agent-collab-v0.5",
    taskId: "task_v05", messageId: "msg_v05", canTransitionMessage: true
  } }));
  let nackPayload;
  const task = { ...v05Detail().task, messages: v05Detail().messages, artifacts: [] };
  const result = await processInboxEvent({
    eventPath, stateRoot: join(root, "state"), projectPath: root, agentId: "frank-agent",
    listenerInstanceId: "listener-1", readinessEpoch: 4, ackReceived: true,
    syncTaskContext: async () => ({
      status: "context_sync_failed", task, error: { category: "local_persistence", message: "read-only" }
    }),
    relayClient: {
      async failMessageDelivery(metadata) { nackPayload = metadata.payload; return {}; }
    }
  });
  assert.equal(result.nacked, true);
  assert.equal(nackPayload.reason, "listener_persistence_failed");
});

test("v0.4 current Message is durably recorded before lifecycle ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v04-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const event = {
    eventId: "aevt_v04",
    eventType: "task.message_pending",
    type: "task.message_pending",
    agentId: "frank-agent",
    taskId: "task_v04",
    messageId: "msg_v04",
    turnSequence: 1,
    statusVersion: 1,
    fromAgentId: "zac-agent",
    toAgentId: "frank-agent"
  };
  await writeFile(eventPath, JSON.stringify({ receivedAt: "2026-07-16T08:00:00Z", event }, null, 2));
  const calls = [];
  const task = {
    task_id: "task_v04", root_task_id: "task_v04", protocol_version: "agent-collab-v0.4",
    requester_agent_id: "zac-agent", target_agent_id: "frank-agent", status: "submitted",
    current_message_id: "msg_v04", turn_sequence: 1, status_version: 1,
    from_agent_id: "zac-agent", to_agent_id: "frank-agent", updated_at: 1,
    messages: [{ message_id: "msg_v04", parts: [{ kind: "text", text: "request" }] }], artifacts: []
  };
  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "frank-agent",
    ackReceived: true,
    relayClient: {
      async ackMessage(metadata) {
        const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
        assert.equal(inbox.events.aevt_v04.status, "received");
        assert.equal(inbox.issues.task_v04.currentMessageId, "msg_v04");
        const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_v04" });
        assert.equal(workspace.task.messages[0].message_id, "msg_v04");
        assert.equal(metadata.payload.expected_status_version, 1);
        calls.push("message-ack");
        return { task: { ...task, status: "delivered", status_version: 2 } };
      },
      async ackEvent() { throw new Error("informational ACK endpoint must not be used"); },
      async getTask() { calls.push("get-task"); return { task }; }
    },
    now: () => "2026-07-16T08:00:01Z"
  });
  assert.deepEqual(calls, ["get-task", "message-ack"]);
  assert.equal(result.acked, true);
  assert.equal(result.contextSync.status, "context_ready");
});

test("v0.4 Listener does not ACK when fetched Message context no longer matches the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-v04-stale-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({ event: {
    eventId: "aevt_old", eventType: "task.message_pending", agentId: "frank-agent",
    taskId: "task_v04_stale", messageId: "msg_old", turnSequence: 1, statusVersion: 1
  } }));
  let acked = 0;
  const result = await processInboxEvent({
    eventPath, stateRoot, projectPath: root, agentId: "frank-agent", ackReceived: true,
    relayClient: {
      async ackMessage() { acked += 1; },
      async getTask() { return { task: {
        task_id: "task_v04_stale", protocol_version: "agent-collab-v0.4", status: "submitted",
        current_message_id: "msg_new", turn_sequence: 2, status_version: 3,
        messages: [{ message_id: "msg_new", parts: [] }], artifacts: []
      } }; }
    }
  });
  assert.equal(acked, 0);
  assert.equal(result.acked, false);
});

test("processInboxEvent ACKs a durable summary before fetching the complete task", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const payload = sampleEvent("evt_summary", "task_summary");
  delete payload.task;
  await writeFile(eventPath, JSON.stringify(payload, null, 2));
  const calls = [];

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    relayClient: {
      async ackEvent() {
        const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
        assert.equal(inbox.events.evt_summary.status, "received");
        calls.push("ack");
      },
      async getTask(taskId) {
        assert.deepEqual(calls, ["ack"]);
        calls.push("get");
        return { data: { task: sampleEvent("unused", taskId).task } };
      }
    },
    sleep: async () => {},
    now: sequenceNow([
      "2026-07-13T02:00:00.000Z",
      "2026-07-13T02:00:01.000Z",
      "2026-07-13T02:00:02.000Z",
      "2026-07-13T02:00:03.000Z",
      "2026-07-13T02:00:04.000Z"
    ])
  });

  assert.deepEqual(calls, ["ack", "get"]);
  assert.equal(result.acked, true);
  assert.equal(result.contextSync.status, "context_ready");
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_summary" });
  assert.equal(workspace.task.task_id, "task_summary");
});

test("processInboxEvent retries task sync once then exposes investigation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const payload = sampleEvent("evt_sync_failed", "task_sync_failed");
  delete payload.task;
  await writeFile(eventPath, JSON.stringify(payload, null, 2));
  let fetches = 0;

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    relayClient: {
      async ackEvent() {},
      async getTask() {
        fetches += 1;
        throw Object.assign(new Error("temporary outage"), { statusCode: 503 });
      }
    },
    sleep: async () => {},
    now: () => "2026-07-13T02:10:00.000Z"
  });

  assert.equal(fetches, 2);
  assert.equal(result.acked, true);
  assert.equal(result.contextSync.status, "context_sync_failed");
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_sync_failed" });
  assert.equal(workspace.workflow.attentionReason, "context_sync_failed");
  assert.match(workspace.handoffPrompt, /explicitly ask you to investigate/);
});

test("processInboxEvent continues context sync when event ACK fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const payload = sampleEvent("evt_ack_failed", "task_ack_failed");
  delete payload.task;
  await writeFile(eventPath, JSON.stringify(payload, null, 2));

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    relayClient: {
      async ackEvent() { throw new Error("network unavailable"); },
      async getTask(taskId) { return { task: sampleEvent("unused", taskId).task }; }
    },
    now: () => "2026-07-13T02:20:00.000Z"
  });

  assert.equal(result.acked, false);
  assert.equal(result.ackError.category, "network");
  assert.equal(result.contextSync.status, "context_ready");
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.events.evt_ack_failed.ackStatus, "failed");
});

test("processInboxEvent records a durable issue before ACK and does not create Codex queues", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(sampleEvent("evt_inbox_only", "task_inbox_only"), null, 2));
  const calls = [];

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    processInboxAfterReceive: true,
    executeInboxAfterReceive: true,
    relayClient: {
      async ackEvent({ eventId, taskId, status, projectPath }) {
        const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
        assert.equal(inbox.issues.task_inbox_only.localStatus, "received");
        assert.deepEqual(inbox.issues.task_inbox_only.localWorkflowBinding, {
          type: "local_inbox",
          workflow: "agentrelay_local_inbox",
          bindingId: "local-inbox:task_inbox_only",
          issueId: "task_inbox_only",
          taskId: "task_inbox_only",
          statePath: join(stateRoot, "issues.json"),
          projectPath: root,
          lastEventId: "evt_inbox_only",
          userOwnedAdapter: true,
          createdAt: "2026-07-03T03:00:00.000Z",
          updatedAt: "2026-07-03T03:00:00.000Z"
        });
        assert.equal(inbox.events.evt_inbox_only.status, "received");
        calls.push({ method: "ackEvent", eventId, taskId, status, projectPath });
      }
    },
    processor: async (params) => {
      calls.push({ method: "processor", stateRoot: params.stateRoot, localAgentId: params.localAgentId });
      return { scanned: 1, processed: 1, externalActions: [] };
    },
    executor: async (params) => {
      calls.push({ method: "executor", stateRoot: params.stateRoot, localAgentId: params.localAgentId });
      return { scanned: 1, executed: 1, failed: 0, actions: [] };
    },
    now: () => "2026-07-03T03:00:00.000Z"
  });

  assert.equal(result.status, "received");
  assert.equal(result.eventId, "evt_inbox_only");
  assert.equal(result.taskId, "task_inbox_only");
  assert.deepEqual(calls.map((call) => call.method), ["ackEvent", "processor", "executor"]);
  assert.equal(existsSync(join(stateRoot, "bindings.json")), false);
  assert.deepEqual(await readdir(join(stateRoot, "queue")).catch(() => []), []);
});

test("processInboxEvent treats duplicate event ids as already handled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(sampleEvent("evt_duplicate", "task_duplicate"), null, 2));
  let ackCount = 0;
  let processorCount = 0;
  let executorCount = 0;
  const options = {
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    processInboxAfterReceive: true,
    executeInboxAfterReceive: true,
    relayClient: {
      async ackEvent() {
        ackCount += 1;
      }
    },
    processor: async () => {
      processorCount += 1;
      return { scanned: 1, processed: 1, externalActions: [] };
    },
    executor: async () => {
      executorCount += 1;
      return { scanned: 1, executed: 1, failed: 0, actions: [] };
    },
    now: () => "2026-07-03T03:00:00.000Z"
  };

  const first = await processInboxEvent(options);
  const second = await processInboxEvent(options);

  assert.equal(first.status, "received");
  assert.equal(second.status, "duplicate");
  assert.equal(second.acked, true);
  assert.equal(ackCount, 2);
  assert.equal(processorCount, 1);
  assert.equal(executorCount, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.deepEqual(inbox.issues.task_duplicate.eventIds, ["evt_duplicate"]);
  assert.equal(inbox.issues.task_duplicate.localWorkflowBinding.bindingId, "local-inbox:task_duplicate");
  assert.equal(inbox.issues.task_duplicate.localWorkflowBinding.lastEventId, "evt_duplicate");
});

test("processInboxEvent does not process the same task snapshot under a different event id twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const pushPath = join(root, "push.json");
  const recoveryPath = join(root, "recovery.json");
  await writeFile(pushPath, JSON.stringify(sampleEvent("evt_push", "task_snapshot"), null, 2));
  await writeFile(recoveryPath, JSON.stringify(sampleEvent("recovery_snapshot", "task_snapshot"), null, 2));
  let processorCount = 0;

  const options = {
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: false,
    processInboxAfterReceive: true,
    processor: async () => {
      processorCount += 1;
      return { scanned: 1, processed: 1, externalActions: [] };
    },
    now: () => "2026-07-03T03:00:00.000Z"
  };

  const first = await processInboxEvent({ ...options, eventPath: pushPath });
  const second = await processInboxEvent({ ...options, eventPath: recoveryPath });

  assert.equal(first.status, "received");
  assert.equal(second.status, "duplicate_snapshot");
  assert.equal(processorCount, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.deepEqual(inbox.issues.task_snapshot.eventIds, ["evt_push", "recovery_snapshot"]);
  assert.equal(inbox.events.recovery_snapshot.status, "duplicate");
});

test("processInboxEvent distinguishes different snapshots updated in the same second", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  const firstPayload = sampleEvent("evt_same_second_1", "task_same_second");
  const secondPayload = sampleEvent("evt_same_second_2", "task_same_second");
  secondPayload.task.messages[0].parts[0].text = "A distinct update in the same second.";
  await writeFile(firstPath, JSON.stringify(firstPayload, null, 2));
  await writeFile(secondPath, JSON.stringify(secondPayload, null, 2));
  let processorCount = 0;
  const options = {
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: false,
    processInboxAfterReceive: true,
    processor: async () => {
      processorCount += 1;
      return { scanned: 1, processed: 1, externalActions: [] };
    }
  };

  const first = await processInboxEvent({ ...options, eventPath: firstPath });
  const second = await processInboxEvent({ ...options, eventPath: secondPath });

  assert.equal(first.status, "received");
  assert.equal(second.status, "received");
  assert.equal(processorCount, 2);
});

test("processInboxEvent never ACKs a synthetic recovery event", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "recovery.json");
  const payload = sampleEvent("recovery_no_ack", "task_recovery_no_ack");
  payload.event.recovery = true;
  await writeFile(eventPath, JSON.stringify(payload, null, 2));
  let ackCount = 0;

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: true,
    relayClient: { async ackEvent() { ackCount += 1; } },
    now: () => "2026-07-03T03:00:00.000Z"
  });

  assert.equal(result.status, "received");
  assert.equal(result.acked, false);
  assert.equal(ackCount, 0);
});

test("processInboxEvent preserves archived local status on new Relay events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(sampleEvent("evt_archived_new", "task_archived"), null, 2));
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify({
    version: 1,
    issues: {
      task_archived: {
        taskId: "task_archived",
        subject: "Archived task",
        pendingOnAgentId: "zac-agent",
        localStatus: "archived",
        relayStatus: "delivery_pending",
        archivedAt: "2026-07-03T02:58:00.000Z",
        eventIds: ["evt_old"],
        updatedAt: "2026-07-03T02:58:00.000Z"
      }
    },
    events: {
      evt_old: {
        eventId: "evt_old",
        taskId: "task_archived",
        type: "task.pending",
        status: "received"
      }
    }
  }, null, 2));

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: false,
    processInboxAfterReceive: false,
    now: () => "2026-07-03T03:02:00.000Z"
  });

  assert.equal(result.status, "received");
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_archived.localStatus, "archived");
  assert.equal(inbox.issues.task_archived.archivedAt, "2026-07-03T02:58:00.000Z");
  assert.deepEqual(inbox.issues.task_archived.eventIds, ["evt_old", "evt_archived_new"]);
  assert.equal(inbox.issues.task_archived.localWorkflowBinding.bindingId, "local-inbox:task_archived");
  assert.equal(inbox.issues.task_archived.localWorkflowBinding.lastEventId, "evt_archived_new");
});

test("processInboxEvent routes expired terminal task notifications to the requester from event payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-intake-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(expiredEvent("evt_expired", "task_expired"), null, 2));

  const result = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId: "zac-agent",
    ackReceived: false,
    processInboxAfterReceive: false,
    now: () => "2026-07-03T04:00:00.000Z"
  });

  assert.equal(result.status, "received");
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_expired;
  assert.equal(issue.relayStatus, "expired");
  assert.equal(issue.pendingOnAgentId, "");
  assert.equal(issue.direction, "outgoing");
  assert.equal(inbox.events.evt_expired.type, "task.pending");
});

function sampleEvent(eventId, taskId) {
  return {
    receivedAt: "2026-07-03T02:59:59.000Z",
    event: {
      eventId,
      type: "task.pending",
      eventType: "task.pending",
      agentId: "zac-agent",
      taskId,
      reason: "ownership.transferred"
    },
    task: {
      task_id: taskId,
      subject: "Inbox-only intake",
      requester_agent_id: "frank-agent",
      target_agent_id: "zac-agent",
      completion_owner_agent_id: "frank-agent",
      pending_on_agent_id: "zac-agent",
      pending_on_human_id: null,
      status: "delivery_pending",
      goal_version: 1,
      updated_at: 1783066800,
      messages: [{
        from_agent_id: "frank-agent",
        to_agent_id: "zac-agent",
        role: "user",
        parts: [{ kind: "text", text: "Please handle this in the local inbox." }]
      }],
      artifacts: []
    }
  };
}

function expiredEvent(eventId, taskId) {
  return {
    receivedAt: "2026-07-03T03:59:59.000Z",
    event: {
      eventId,
      type: "task.pending",
      eventType: "task.pending",
      agentId: "zac-agent",
      taskId,
      pendingOnAgentId: "zac-agent",
      reason: "task.ttl_expired"
    },
    task: {
      task_id: taskId,
      subject: "Expired outgoing request",
      requester_agent_id: "zac-agent",
      target_agent_id: "frank-agent",
      completion_owner_agent_id: "zac-agent",
      pending_on_agent_id: null,
      pending_on_human_id: null,
      status: "expired",
      terminal_reason: "Task expired before frank-agent replied within the configured TTL.",
      messages: [{
        from_agent_id: "zac-agent",
        to_agent_id: "frank-agent",
        role: "user",
        parts: [{ kind: "text", text: "Please reply before the TTL." }]
      }],
      artifacts: []
    }
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

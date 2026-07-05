import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { processInboxEvent } from "../scripts/agentrelay-inbox-intake.mjs";

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
  assert.equal(issue.pendingOnAgentId, "zac-agent");
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
      messages: [{
        from_agent_id: "frank-agent",
        to_agent_id: "zac-agent",
        role: "user",
        parts: [{ kind: "text", text: "Please handle this in the local inbox." }]
      }]
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
      }]
    }
  };
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { executePreparedTaskAction, legacyActionIdempotencyKey } from "../scripts/agentrelay-mcp-task-actions.mjs";
import { approveLocalAction, persistTaskWorkspace, prepareLocalAction, readLocalAction, readLocalApproval, readTaskWorkspace } from "../scripts/agentrelay-task-workspace.mjs";

function task(overrides = {}) {
  return {
    task_id: "task_guard",
    goal_version: 1,
    exchange_epoch: 1,
    status: "claimed",
    pending_on_agent_id: "zac-agent",
    completion_owner_agent_id: "zac-agent",
    messages: [{ message_id: "msg_1", parts: [{ kind: "text", text: "Review this" }] }],
    artifacts: [],
    ...overrides
  };
}

test("prepared action submits once with stable idempotency and refreshes local context", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-"));
  const payload = { text: "Approved response", responseToGoalVersion: 1 };
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  const prepared = await prepareLocalAction({
    stateRoot,
    taskId: "task_guard",
    actionType: "submit_artifact",
    payload,
    clientActionId: "confirmed_1"
  });
  const approval = await approveLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "confirmed_1" });
  const mutationCalls = [];
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "confirmed_1",
    actionType: "submit_artifact",
    payload,
    confirmationRef: approval.confirmationRef,
    fetchTask: async () => task(),
    mutate: async (idempotencyKey) => {
      mutationCalls.push(idempotencyKey);
      return { task: task({ status: "delivery_pending", pending_on_agent_id: "frank-agent" }) };
    },
    localAgentId: "zac-agent"
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(mutationCalls, [prepared.action.idempotencyKey]);
  const stored = await readLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "confirmed_1" });
  assert.equal(stored.action.status, "sent");
  assert.equal(stored.action.confirmationRef, approval.confirmationRef);
  assert.equal(stored.action.authorization.status, "consumed");

  const repeated = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "confirmed_1",
    actionType: "submit_artifact",
    payload,
    fetchTask: async () => { throw new Error("already-sent retry must not fetch"); },
    mutate: async () => { throw new Error("already-sent retry must not mutate"); }
  });
  assert.equal(repeated.status, "already_sent");
});

test("prepared action returns CONTEXT_CHANGED and never mutates Relay", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-"));
  const payload = { terminalReason: "Done" };
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot,
    taskId: "task_guard",
    actionType: "close_task",
    payload,
    clientActionId: "close_1"
  });
  let mutated = false;
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "close_1",
    actionType: "close_task",
    payload,
    fetchTask: async () => task({ goal_version: 2, exchange_epoch: 2 }),
    mutate: async () => { mutated = true; }
  });
  assert.equal(result.code, "CONTEXT_CHANGED");
  assert.deepEqual(result.changedFields, ["goalVersion", "exchangeEpoch"]);
  assert.equal(mutated, false);
  const stored = await readLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "close_1" });
  assert.equal(stored.action.status, "stale");
});

test("prepared action rejects changed payload before fetching or mutating", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-"));
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot,
    taskId: "task_guard",
    actionType: "amend_task",
    payload: { newDoneCriteria: "Original" },
    clientActionId: "amend_1"
  });
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "amend_1",
    actionType: "amend_task",
    payload: { newDoneCriteria: "Changed" },
    fetchTask: async () => { throw new Error("must not fetch"); },
    mutate: async () => { throw new Error("must not mutate"); }
  });
  assert.equal(result.code, "ACTION_PAYLOAD_CHANGED");
});

test("prepared action rejects missing and expired trusted local authorization", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-authorization-"));
  const payload = { text: "Guarded response" };
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot, taskId: "task_guard", actionType: "request_revision", payload, clientActionId: "auth_required"
  });
  let mutated = false;
  const missing = await executePreparedTaskAction({
    stateRoot, taskId: "task_guard", clientActionId: "auth_required", actionType: "request_revision", payload,
    fetchTask: async () => task(), mutate: async () => { mutated = true; }
  });
  assert.equal(missing.code, "LOCAL_AUTHORIZATION_REQUIRED");
  assert.equal(mutated, false);

  await approveLocalAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "auth_required",
    ttlSeconds: 1,
    at: "2026-07-19T00:00:00.000Z"
  });
  const expired = await executePreparedTaskAction({
    stateRoot, taskId: "task_guard", clientActionId: "auth_required", actionType: "request_revision", payload,
    fetchTask: async () => task(), mutate: async () => { mutated = true; },
    now: () => "2026-07-19T00:00:02.000Z"
  });
  assert.equal(expired.code, "LOCAL_AUTHORIZATION_EXPIRED");
  assert.equal(mutated, false);
});

test("prepared action rejects an embedded approval without its Local Inbox record", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-approval-record-"));
  const payload = { text: "record-bound" };
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot, taskId: "task_guard", actionType: "request_revision", payload, clientActionId: "record_required"
  });
  const approved = await approveLocalAction({
    stateRoot, taskId: "task_guard", clientActionId: "record_required"
  });
  const record = await readLocalApproval({
    stateRoot, taskId: "task_guard", approvalId: approved.approvalId
  });
  await rm(record.path);
  let mutated = false;
  const result = await executePreparedTaskAction({
    stateRoot, taskId: "task_guard", clientActionId: "record_required", actionType: "request_revision", payload,
    fetchTask: async () => task(), mutate: async () => { mutated = true; }, localAgentId: "zac-agent"
  });
  assert.equal(result.code, "LOCAL_APPROVAL_RECORD_MISMATCH");
  assert.equal(mutated, false);
});

test("Hermes service policy remains a maximum permission even with human approval", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-hermes-policy-ceiling-"));
  const current = {
    task_id: "task_hermes",
    protocol_version: "agent-collab-v0.5",
    status: "open",
    requester_agent_id: "zac-agent",
    target_agent_id: "project-hermes",
    from_agent_id: "zac-agent",
    to_agent_id: "project-hermes",
    current_message_id: "msg_hermes",
    turn_sequence: 2,
    task_version: 2,
    max_turns: 12,
    messages: [{ message_id: "msg_hermes", delivery_status: "delivered", parts: [{ kind: "text", text: "done" }] }],
    artifacts: []
  };
  await persistTaskWorkspace({ stateRoot, task: current, localAgentId: "project-hermes" });
  await prepareLocalAction({
    stateRoot, taskId: "task_hermes", actionType: "complete_task", payload: {}, clientActionId: "human_override"
  });
  await approveLocalAction({ stateRoot, taskId: "task_hermes", clientActionId: "human_override" });
  let mutated = false;
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_hermes",
    clientActionId: "human_override",
    actionType: "complete_task",
    payload: {},
    fetchTask: async () => current,
    mutate: async () => { mutated = true; },
    localAgentId: "project-hermes",
    servicePolicyPath: fileURLToPath(new URL("../policies/project-hermes.service-policy.json", import.meta.url))
  });
  assert.equal(result.code, "SERVICE_POLICY_OPERATION_DENIED");
  assert.equal(mutated, false);
});

test("ambiguous submission remains retryable with one stable idempotency key", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-"));
  const payload = { text: "Retry me" };
  await persistTaskWorkspace({ stateRoot, task: task(), localAgentId: "zac-agent" });
  const prepared = await prepareLocalAction({
    stateRoot,
    taskId: "task_guard",
    actionType: "request_revision",
    payload,
    clientActionId: "retry_1"
  });
  await approveLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "retry_1" });
  const keys = [];
  await assert.rejects(executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "retry_1",
    actionType: "request_revision",
    payload,
    fetchTask: async () => task(),
    mutate: async (key) => { keys.push(key); throw new Error("socket closed"); }
  }), /socket closed/);
  const stored = await readLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "retry_1" });
  assert.equal(stored.action.status, "submission_unknown");
  await assert.rejects(executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "retry_1",
    actionType: "request_revision",
    payload,
    fetchTask: async () => task(),
    mutate: async (key) => { keys.push(key); throw new Error("still unknown"); }
  }), /still unknown/);
  assert.deepEqual(keys, [prepared.action.idempotencyKey, prepared.action.idempotencyKey]);
});

test("separate confirmations and legacy calls use deterministic idempotency identities", async () => {
  const key = legacyActionIdempotencyKey({ taskId: "task_guard", actionType: "close_task", payload: { reason: "done" } });
  assert.equal(key, legacyActionIdempotencyKey({ taskId: "task_guard", actionType: "close_task", payload: { reason: "done" } }));
  assert.notEqual(key, legacyActionIdempotencyKey({ taskId: "task_guard", actionType: "close_task", payload: { reason: "different" } }));
});

test("Relay stale_task_state refreshes v0.4 workspace and invalidates the prepared action", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-v04-"));
  const initial = task({
    protocol_version: "agent-collab-v0.4",
    root_task_id: "task_guard",
    status: "delivered",
    current_message_id: "msg_1",
    turn_sequence: 1,
    status_version: 2,
    from_agent_id: "frank-agent",
    to_agent_id: "zac-agent"
  });
  const payload = {
    actorAgentId: "zac-agent",
    text: "follow-up",
    currentMessageId: "msg_1",
    turnSequence: 1,
    expectedStatusVersion: 2
  };
  await persistTaskWorkspace({ stateRoot, task: initial, localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot,
    taskId: "task_guard",
    actionType: "send_message_v04",
    payload,
    clientActionId: "v04_stale"
  });
  await approveLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "v04_stale" });
  const current = {
    ...initial,
    status: "submitted",
    current_message_id: "msg_2",
    turn_sequence: 2,
    status_version: 3,
    from_agent_id: "zac-agent",
    to_agent_id: "frank-agent",
    messages: [...initial.messages, { message_id: "msg_2", parts: [{ kind: "text", text: "new" }] }]
  };
  let fetches = 0;
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "v04_stale",
    actionType: "send_message_v04",
    payload,
    fetchTask: async () => {
      fetches += 1;
      if (fetches > 1) throw new Error("full conflict snapshot should avoid a second GET");
      return initial;
    },
    mutate: async () => {
      throw Object.assign(new Error("stale"), {
        code: "stale_task_state",
        currentTask: current,
        statusCode: 409
      });
    },
    localAgentId: "zac-agent"
  });
  assert.equal(result.code, "STALE_TASK_STATE");
  assert.equal(fetches, 1);
  assert.equal(result.contextSyncStatus, "context_ready");
  const stored = await readLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "v04_stale" });
  assert.equal(stored.action.status, "stale");
});

test("follow-up action persists the returned child in its own workspace", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-followup-v04-"));
  const source = task({
    protocol_version: "agent-collab-v0.4", root_task_id: "task_guard", status: "completed",
    current_message_id: "msg_done", turn_sequence: 1, status_version: 5,
    from_agent_id: "frank-agent", to_agent_id: "zac-agent"
  });
  const payload = { requestText: "Continue", doneCriteria: "Follow-up done" };
  await persistTaskWorkspace({ stateRoot, task: source, localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot, taskId: "task_guard", actionType: "create_followup_v04",
    payload, clientActionId: "followup_1"
  });
  await approveLocalAction({ stateRoot, taskId: "task_guard", clientActionId: "followup_1" });
  const child = {
    ...source,
    task_id: "task_child",
    root_task_id: "task_guard",
    status: "submitted",
    current_message_id: "msg_child",
    status_version: 1,
    messages: [{ message_id: "msg_child", parts: [{ kind: "text", text: "Continue" }] }]
  };
  const result = await executePreparedTaskAction({
    stateRoot, taskId: "task_guard", clientActionId: "followup_1",
    actionType: "create_followup_v04", payload, resultTaskMode: "new_task",
    fetchTask: async () => source,
    mutate: async () => ({ task: child }),
    localAgentId: "zac-agent"
  });
  assert.equal(result.resultTaskId, "task_child");
  assert.equal(result.contextSyncStatus, "context_ready");
  const childWorkspace = await readTaskWorkspace({ stateRoot, taskId: "task_child" });
  assert.equal(childWorkspace.task.root_task_id, "task_guard");
});

test("Relay stale_task_version refreshes v0.5 workspace and invalidates the prepared action", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-action-v05-"));
  const initial = {
    task_id: "task_v05_guard", root_task_id: "task_v05_guard", protocol_version: "agent-collab-v0.5",
    requester_agent_id: "zac-agent", target_agent_id: "frank-agent", status: "open",
    current_message_id: "msg_1", turn_sequence: 1, task_version: 2,
    from_agent_id: "frank-agent", to_agent_id: "zac-agent", max_turns: 3,
    messages: [{ message_id: "msg_1", delivery_status: "delivered", parts: [{ kind: "text", text: "pong" }] }],
    artifacts: []
  };
  const payload = {
    actorAgentId: "zac-agent", text: "again", currentMessageId: "msg_1",
    turnSequence: 1, expectedTaskVersion: 2
  };
  await persistTaskWorkspace({ stateRoot, task: initial, localAgentId: "zac-agent" });
  await prepareLocalAction({
    stateRoot, taskId: "task_v05_guard", actionType: "send_message_v05",
    payload, clientActionId: "v05_stale"
  });
  await approveLocalAction({ stateRoot, taskId: "task_v05_guard", clientActionId: "v05_stale" });
  const current = {
    ...initial, current_message_id: "msg_2", task_version: 3,
    messages: [...initial.messages, { message_id: "msg_2", delivery_status: "pending", parts: [] }]
  };
  const result = await executePreparedTaskAction({
    stateRoot, taskId: "task_v05_guard", clientActionId: "v05_stale",
    actionType: "send_message_v05", payload,
    fetchTask: async () => initial,
    mutate: async () => {
      throw Object.assign(new Error("stale"), {
        code: "stale_task_version", currentTask: current, statusCode: 409
      });
    },
    localAgentId: "zac-agent"
  });
  assert.equal(result.code, "STALE_TASK_STATE");
  const stored = await readLocalAction({
    stateRoot, taskId: "task_v05_guard", clientActionId: "v05_stale"
  });
  assert.equal(stored.action.status, "stale");
  assert.deepEqual(stored.action.changedFields, ["currentMessageId", "turnSequence", "taskVersion"]);
});

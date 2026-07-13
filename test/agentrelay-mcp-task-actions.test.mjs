import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executePreparedTaskAction, legacyActionIdempotencyKey } from "../scripts/agentrelay-mcp-task-actions.mjs";
import { persistTaskWorkspace, prepareLocalAction, readLocalAction } from "../scripts/agentrelay-task-workspace.mjs";

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
  const mutationCalls = [];
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: "task_guard",
    clientActionId: "confirmed_1",
    actionType: "submit_artifact",
    payload,
    confirmationRef: "user-confirmed-in-current-session",
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
  assert.equal(stored.action.confirmationRef, "user-confirmed-in-current-session");

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

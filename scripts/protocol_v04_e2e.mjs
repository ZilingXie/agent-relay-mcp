#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processInboxEvent } from "./agentrelay-inbox-intake.mjs";
import { executePreparedTaskAction } from "./agentrelay-mcp-task-actions.mjs";
import { prepareLocalAction, readTaskWorkspace } from "./agentrelay-task-workspace.mjs";
import {
  buildCompletePayloadV04,
  buildCreatePayloadV04,
  buildFailPayloadV04,
  buildFollowupPayloadV04,
  buildMessagePayloadV04,
  validatePreparedActionV04
} from "./agentrelay-v04.mjs";

const baseUrl = String(process.env.AGENTRELAY_E2E_BASE_URL || "https://server.stellarix.space/agentrelay/api").replace(/\/+$/, "");
const agentA = requiredEnv("AGENTRELAY_E2E_AGENT_A_ID", "zac-agent");
const agentB = requiredEnv("AGENTRELAY_E2E_AGENT_B_ID", "frank-agent");
const clientA = relayClient(
  agentA,
  requiredEnv("AGENTRELAY_E2E_AGENT_A_TOKEN"),
  requiredEnv("AGENTRELAY_E2E_AGENT_A_USERNAME", agentA)
);
const clientB = relayClient(
  agentB,
  requiredEnv("AGENTRELAY_E2E_AGENT_B_TOKEN"),
  requiredEnv("AGENTRELAY_E2E_AGENT_B_USERNAME", agentB)
);
const root = await mkdtemp(join(tmpdir(), "agentrelay-v04-e2e-"));
const stateA = join(root, "agent-a-state");
const stateB = join(root, "agent-b-state");
const runId = `${Date.now()}-${process.pid}`;

const created = await clientA.post("/tasks", buildCreatePayloadV04({
  requesterAgentId: agentA,
  targetAgentId: agentB,
  requestText: `Protocol v0.4 E2E request ${runId}`,
  doneCriteria: "Target returns the exact E2E acknowledgement and requester accepts it.",
  subject: `Protocol v0.4 E2E ${runId}`,
  maxTurns: 2,
  taskExpiresAt: Math.floor(Date.now() / 1000) + 900
}, `e2e-create-${runId}`));
let task = unwrapTask(created);
assertSnapshot(task, "submitted", 1, 1, agentA, agentB);
const rootTaskId = task.task_id;

task = await receiveCurrentMessage({ client: clientB, agentId: agentB, stateRoot: stateB, task });
assertSnapshot(task, "delivered", 1, 2, agentA, agentB);

const responseArgs = actionArgs(task, {
  actorAgentId: agentB,
  text: `Protocol v0.4 E2E acknowledgement ${runId}`
});
task = unwrapTask((await runPrepared({
  client: clientB,
  stateRoot: stateB,
  task,
  actionType: "send_message_v04",
  args: responseArgs,
  buildPayload: buildMessagePayloadV04
})).relayResponse);
assertSnapshot(task, "submitted", 1, 3, agentB, agentA);

task = await receiveCurrentMessage({ client: clientA, agentId: agentA, stateRoot: stateA, task });
assertSnapshot(task, "delivered", 1, 4, agentB, agentA);

const completeArgs = actionArgs(task, {
  actorAgentId: agentA,
  completedAgainstMessageId: task.current_message_id
});
task = unwrapTask((await runPrepared({
  client: clientA,
  stateRoot: stateA,
  task,
  actionType: "complete_task_v04",
  args: completeArgs,
  buildPayload: buildCompletePayloadV04
})).relayResponse);
assert.equal(task.status, "completed");
assert.equal(task.completed_against_message_id, task.current_message_id);

const followupArgs = {
  requestText: `Protocol v0.4 follow-up ${runId}`,
  doneCriteria: "Follow-up lineage is visible and then the test target terminates the child.",
  subject: `Protocol v0.4 follow-up ${runId}`,
  maxTurns: 1,
  taskExpiresAt: Math.floor(Date.now() / 1000) + 900
};
const followupResult = await runPrepared({
  client: clientA,
  stateRoot: stateA,
  task,
  actionType: "create_followup_v04",
  args: followupArgs,
  buildPayload: buildFollowupPayloadV04,
  path: `/tasks/${encodeURIComponent(task.task_id)}/followups`,
  resultTaskMode: "new_task"
});
let child = unwrapTask(followupResult.relayResponse);
assert.notEqual(child.task_id, rootTaskId);
assert.equal(child.root_task_id, rootTaskId);
assert.equal((await readTaskWorkspace({ stateRoot: stateA, taskId: child.task_id })).task.root_task_id, rootTaskId);

const lineage = await clientA.get(`/tasks/${encodeURIComponent(rootTaskId)}/lineage`);
const lineageTasks = lineage.tasks || lineage.data?.tasks || [];
assert.deepEqual(new Set(lineageTasks.map((item) => item.task_id)), new Set([rootTaskId, child.task_id]));

child = await receiveCurrentMessage({ client: clientB, agentId: agentB, stateRoot: stateB, task: child });
const failArgs = actionArgs(child, { actorAgentId: agentB, reason: "agent_reported_failure" });
child = unwrapTask((await runPrepared({
  client: clientB,
  stateRoot: stateB,
  task: child,
  actionType: "fail_task_v04",
  args: failArgs,
  buildPayload: buildFailPayloadV04
})).relayResponse);
assert.equal(child.status, "failed");

console.log(JSON.stringify({
  ok: true,
  protocol: "agent-collab-v0.4",
  rootTaskId,
  rootStatus: task.status,
  followupTaskId: child.task_id,
  followupStatus: child.status,
  lineageCount: lineageTasks.length
}, null, 2));

async function receiveCurrentMessage({ client, agentId, stateRoot, task }) {
  const eventsResponse = await client.get(`/workers/${encodeURIComponent(agentId)}/events?include_acked=false&limit=500`);
  const events = eventsResponse.events || eventsResponse.data?.events || [];
  const event = events.find((item) =>
    (item.event_type || item.eventType) === "task.message_pending"
    && (item.task_id || item.taskId) === task.task_id
    && (item.message_id || item.messageId || item.payload?.message_id) === task.current_message_id
  );
  assert(event, `Missing task.message_pending for ${agentId} and ${task.task_id}`);
  const eventPath = join(root, `${agentId}-${event.event_id || event.eventId}.json`);
  await writeFile(eventPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), event }, null, 2)}\n`, { mode: 0o600 });
  const intake = await processInboxEvent({
    eventPath,
    stateRoot,
    projectPath: root,
    agentId,
    ackReceived: true,
    relayClient: {
      getTask: (taskId) => client.get(`/tasks/${encodeURIComponent(taskId)}`),
      ackEvent: ({ agentId: id, eventId, taskId }) => client.post(
        `/workers/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}/ack`,
        { taskId, status: "received" }
      ),
      ackMessage: ({ agentId: id, messageId, payload }) => client.post(
        `/workers/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/ack`,
        payload
      )
    }
  });
  assert.equal(intake.acked, true);
  assert.equal(intake.contextSync.status, "context_ready");
  return intake.contextSync.task;
}

async function runPrepared({ client, stateRoot, task, actionType, args, buildPayload, path, resultTaskMode = "same_task" }) {
  const clientActionId = `e2e_${actionType}_${runId}`;
  await prepareLocalAction({
    stateRoot,
    taskId: task.task_id,
    actionType,
    payload: args,
    clientActionId,
    confirmationRef: `automated-e2e-${runId}`
  });
  const result = await executePreparedTaskAction({
    stateRoot,
    taskId: task.task_id,
    clientActionId,
    actionType,
    payload: args,
    confirmationRef: `automated-e2e-${runId}`,
    fetchTask: (taskId) => client.get(`/tasks/${encodeURIComponent(taskId)}`),
    mutate: (key) => client.post(
      path || defaultMutationPath(actionType, task.task_id),
      buildPayload(args, key)
    ),
    validateCurrentTask: (current) => validatePreparedActionV04(actionType, current, args),
    resultTaskMode,
    localAgentId: client.agentId
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.contextSyncStatus, "context_ready");
  return result;
}

function actionArgs(task, values) {
  return {
    currentMessageId: task.current_message_id,
    turnSequence: task.turn_sequence,
    expectedStatusVersion: task.status_version,
    ...values
  };
}

function defaultMutationPath(actionType, taskId) {
  const suffix = {
    send_message_v04: "messages",
    complete_task_v04: "complete",
    fail_task_v04: "fail"
  }[actionType];
  if (!suffix) throw new Error(`No mutation path for ${actionType}`);
  return `/tasks/${encodeURIComponent(taskId)}/${suffix}`;
}

function relayClient(agentId, token, username) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-AgentRelay-Agent-Id": agentId,
    "X-AgentRelay-Username": username,
    "Content-Type": "application/json"
  };
  async function request(method, path, payload) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const data = JSON.parse(await response.text() || "{}");
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    return data;
  }
  return {
    agentId,
    get: (path) => request("GET", path),
    post: (path, payload) => request("POST", path, payload)
  };
}

function unwrapTask(response) {
  const task = response?.data?.task || response?.task;
  assert(task, `Relay response is missing Task: ${JSON.stringify(response)}`);
  return task;
}

function assertSnapshot(task, status, turn, version, from, to) {
  assert.equal(task.status, status);
  assert.equal(task.turn_sequence, turn);
  assert.equal(task.status_version, version);
  assert.equal(task.from_agent_id, from);
  assert.equal(task.to_agent_id, to);
}

function requiredEnv(name, fallback = "") {
  const value = String(process.env[name] || fallback).trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

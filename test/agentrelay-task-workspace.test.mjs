import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resyncLocalTask } from "../scripts/agentrelay-task-context-sync.mjs";
import {
  backfillTaskWorkspaces,
  compareTaskContextEnvelopes,
  deriveTaskContextEnvelope,
  persistTaskWorkspace,
  prepareLocalAction,
  readLocalAction,
  readTaskIndex,
  readTaskWorkspace,
  sanitizeTaskId,
  taskWorkspacePaths
} from "../scripts/agentrelay-task-workspace.mjs";

test("persistTaskWorkspace writes complete local context and projections atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const task = sampleTask("task_complete");

  const result = await persistTaskWorkspace({
    stateRoot,
    task,
    localAgentId: "zac-agent",
    source: "test",
    eventId: "evt_complete",
    syncedAt: "2026-07-13T01:00:00.000Z",
    agentsMdPath: join(root, "AGENTS.md")
  });

  const workspace = await readTaskWorkspace({ stateRoot, taskId: task.task_id });
  assert.deepEqual(workspace.task, task);
  assert.equal(workspace.sync.status, "context_ready");
  assert.equal(workspace.workflow.handoffType, "normal");
  assert.match(await readFile(workspace.paths.contextPath, "utf8"), /Complete Relay Task JSON/);
  assert.match(await readFile(workspace.paths.contextPath, "utf8"), /Please inspect the dashboard/);
  assert.match(workspace.handoffPrompt, new RegExp(workspace.paths.contextPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await stat(workspace.paths.remotePath)).mode & 0o777, 0o600);
  assert.equal((await stat(workspace.paths.taskDir)).mode & 0o777, 0o700);
  const index = await readTaskIndex({ stateRoot });
  assert.equal(index.tasks.task_complete.contextSyncStatus, "context_ready");
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_complete.subject, "Complete local task");
  assert.equal(result.issue.direction, "incoming");
});

test("resyncLocalTask retries exactly once then writes an investigation handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  let calls = 0;
  const result = await resyncLocalTask({
    stateRoot,
    taskId: "task_failed",
    fetchTask: async () => {
      calls += 1;
      throw Object.assign(new Error("GET failed with token=secret-value"), { statusCode: 503 });
    },
    maxAttempts: 2,
    retryDelayMs: 1,
    sleep: async () => {},
    now: sequenceNow([
      "2026-07-13T01:00:00.000Z",
      "2026-07-13T01:00:01.000Z",
      "2026-07-13T01:00:02.000Z",
      "2026-07-13T01:00:03.000Z"
    ]),
    agentsMdPath: join(root, "AGENTS.md")
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "context_sync_failed");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.error.category, "server_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_failed" });
  assert.equal(workspace.sync.status, "context_sync_failed");
  assert.equal(workspace.workflow.attentionReason, "context_sync_failed");
  assert.match(workspace.handoffPrompt, /After I explicitly ask you to investigate/);
  assert.match(workspace.handoffPrompt, /agentrelay_resync_local_task/);
});

test("resyncLocalTask coalesces concurrent calls for one task", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchTask = async () => {
    calls += 1;
    await gate;
    return { data: { task: sampleTask("task_coalesced") } };
  };
  const first = resyncLocalTask({ stateRoot, taskId: "task_coalesced", fetchTask });
  const second = resyncLocalTask({ stateRoot, taskId: "task_coalesced", fetchTask });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.status, "context_ready");
  assert.deepEqual(b.contextEnvelope, a.contextEnvelope);
});

test("persisting changed task context preserves and stales prepared actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const task = sampleTask("task_stale");
  await persistTaskWorkspace({ stateRoot, task, localAgentId: "zac-agent" });
  const prepared = await prepareLocalAction({
    stateRoot,
    taskId: task.task_id,
    actionType: "submit_artifact",
    clientActionId: "confirmed_reply_1",
    payload: { text: "Confirmed reply" },
    at: "2026-07-13T01:01:00.000Z"
  });
  assert.equal(prepared.action.status, "awaiting_confirmation");

  const changed = structuredClone(task);
  changed.exchange_epoch = 2;
  changed.artifacts.push({
    artifact_id: "artifact_2",
    from_agent_id: "frank-agent",
    to_agent_id: "zac-agent",
    parts: [{ kind: "text", text: "New remote result" }]
  });
  const persisted = await persistTaskWorkspace({
    stateRoot,
    task: changed,
    localAgentId: "zac-agent",
    syncedAt: "2026-07-13T01:02:00.000Z"
  });

  assert.deepEqual(persisted.staleActionIds, ["confirmed_reply_1"]);
  const { action } = await readLocalAction({ stateRoot, taskId: task.task_id, clientActionId: "confirmed_reply_1" });
  assert.equal(action.status, "stale");
  assert.deepEqual(action.changedFields, ["exchangeEpoch", "latestArtifactId"]);
  const workspace = await readTaskWorkspace({ stateRoot, taskId: task.task_id });
  assert.equal(workspace.workflow.attentionReason, "context_changed");
  assert.match(workspace.handoffPrompt, /context changed/i);
});

test("backfillTaskWorkspaces migrates the newest durable task snapshot and archive state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  const task = sampleTask("task_migrate");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(eventPath, `${JSON.stringify({ event: { eventId: "evt_migrate" }, task }, null, 2)}\n`);
  await writeFile(join(stateRoot, "issues.json"), `${JSON.stringify({
    version: 1,
    issues: {
      task_migrate: {
        taskId: "task_migrate",
        localStatus: "archived",
        archivedAt: "2026-07-13T00:00:00.000Z",
        eventIds: ["evt_migrate"]
      }
    },
    events: { evt_migrate: { eventId: "evt_migrate", taskId: "task_migrate", sourcePath: eventPath } }
  }, null, 2)}\n`);

  const result = await backfillTaskWorkspaces({ stateRoot, localAgentId: "zac-agent" });
  assert.equal(result.migrated, 1);
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_migrate" });
  assert.equal(workspace.workflow.localStatus, "archived");
  assert.deepEqual(workspace.task, task);
});

test("context envelopes compare stable ids and reject unsafe task paths", () => {
  const task = sampleTask("task_envelope");
  const envelope = deriveTaskContextEnvelope(task);
  assert.equal(compareTaskContextEnvelopes(envelope, { ...envelope }).matches, true);
  assert.equal(compareTaskContextEnvelopes(envelope, { ...envelope, status: "completed" }).matches, false);
  assert.match(sanitizeTaskId("task/unsafe"), /^task_unsafe-/);
  assert.throws(() => sanitizeTaskId(".."), /Unsafe task id/);
  const paths = taskWorkspacePaths("/tmp/state", "task/unsafe");
  assert.match(paths.taskDir, /task_unsafe-/);
});

function sampleTask(taskId) {
  return {
    task_id: taskId,
    subject: "Complete local task",
    requester_agent_id: "frank-agent",
    target_agent_id: "zac-agent",
    completion_owner_agent_id: "frank-agent",
    pending_on_agent_id: "zac-agent",
    pending_on_human_id: null,
    status: "delivery_pending",
    goal_version: 1,
    exchange_epoch: 1,
    done_criteria: "Return a verified result.",
    messages: [{
      message_id: "message_1",
      from_agent_id: "frank-agent",
      to_agent_id: "zac-agent",
      parts: [{ kind: "text", text: "Please inspect the dashboard." }]
    }],
    artifacts: [{
      artifact_id: "artifact_1",
      from_agent_id: "frank-agent",
      to_agent_id: "zac-agent",
      parts: [{ kind: "text", text: "Initial evidence" }]
    }]
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

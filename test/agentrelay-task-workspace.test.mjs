import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recoverPendingTaskSyncs, resyncLocalTask } from "../scripts/agentrelay-task-context-sync.mjs";
import {
  backfillTaskWorkspaces,
  compareTaskContextEnvelopes,
  deriveTaskContextEnvelope,
  markTaskSyncPending,
  persistTaskWorkspace,
  prepareLocalAction,
  readLocalAction,
  rebuildTaskIndex,
  readTaskIndex,
  readTaskWorkspace,
  sanitizeTaskId,
  taskWorkspacePaths
} from "../scripts/agentrelay-task-workspace.mjs";

test("v0.4 context envelope invalidates actions on message, turn, or status version changes", () => {
  const first = deriveTaskContextEnvelope({
    task_id: "task_v04", root_task_id: "task_root", protocol_version: "agent-collab-v0.4",
    status: "delivered", current_message_id: "msg_1", turn_sequence: 1, status_version: 2,
    from_agent_id: "zac-agent", to_agent_id: "frank-agent", messages: [], artifacts: []
  });
  const next = { ...first, currentMessageId: "msg_2", turnSequence: 2, statusVersion: 3 };
  assert.deepEqual(compareTaskContextEnvelopes(first, next).changedFields, [
    "currentMessageId", "turnSequence", "statusVersion"
  ]);
});

test("persistTaskWorkspace writes complete local context and projections atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const task = sampleTask("task_complete");
  const agentsMdPath = join(root, "AGENTS.md");

  const result = await persistTaskWorkspace({
    stateRoot,
    task,
    localAgentId: "zac-agent",
    source: "test",
    eventId: "evt_complete",
    syncedAt: "2026-07-13T01:00:00.000Z",
    agentsMdPath
  });

  const workspace = await readTaskWorkspace({ stateRoot, taskId: task.task_id });
  assert.deepEqual(workspace.task, task);
  assert.equal(workspace.sync.status, "context_ready");
  assert.equal(workspace.workflow.handoffType, "normal");
  assert.match(await readFile(workspace.paths.contextPath, "utf8"), /Complete Relay Task JSON/);
  assert.match(await readFile(workspace.paths.contextPath, "utf8"), /Please inspect the dashboard/);
  assert.equal(workspace.handoffPrompt, [
    `Handle AgentRelay task task_complete at ${workspace.paths.contextPath}. Follow ${agentsMdPath}.`,
    "",
    "Before analyzing the task, verify this exact binding against context.md and the task directory:",
    "- task_id=task_complete",
    "- current_message_id=none",
    "- relay_status=delivery_pending",
    "- project_hermes=not applicable (the current message carries no project_hermes metadata)",
    "If task_id, current_message_id, or relay_status differs, stop immediately; do not substitute Tasks, draft a reply, or mutate AgentRelay. Explain the mismatch and use read-only resync for this Task.",
    "Discovering another pending Task that looks related does not by itself stop this work: you may continue read-only verification of that task's identity, status, and business association (including business-state queries the task's own skill defines). Never replace or process the other Task in place of this one. Pause and explain the evidence only when a binding conflict is confirmed, or when verification still cannot determine which task you were asked to handle.",
    "",
    "In this turn, only explain what this task asks, what I need to decide or provide, and the exact draft external action or reply.",
    "Do not call agentrelay_prepare_local_action or any AgentRelay mutation in this turn. Stop after the draft and wait for my next message so I can approve it, revise it, or continue discussing the task.",
    "Only after I explicitly approve the exact draft in a later message should you prepare that action and call the matching AgentRelay MCP mutation.",
    ""
  ].join("\n"));
  assert.doesNotMatch(workspace.handoffPrompt, /remote\.json/);
  assert.doesNotMatch(workspace.handoffPrompt, /Local task directory/);
  assert.match(workspace.handoffPrompt, /not applicable \(the current message carries no project_hermes metadata\)/);
  assert.doesNotMatch(workspace.handoffPrompt, /project_hermes=\{\}/);
  assert.match(workspace.handoffPrompt, /continue read-only verification/);
  assert.equal((await stat(workspace.paths.remotePath)).mode & 0o777, 0o600);
  assert.equal((await stat(workspace.paths.taskDir)).mode & 0o777, 0o700);
  const index = await readTaskIndex({ stateRoot });
  assert.equal(index.tasks.task_complete.contextSyncStatus, "context_ready");
  assert.equal(index.tasks.task_complete.taskExpiresAt, 1783070400);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_complete.subject, "Complete local task");
  assert.equal(result.issue.direction, "incoming");
});

test("v0.5 workspace projection follows the current to_agent_id and clears terminal pending owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-v05-pending-"));
  const stateRoot = join(root, "state");
  const initial = v05Task("task_v05_pending", {
    taskVersion: 2,
    fromAgentId: "zac-agent",
    toAgentId: "project-hermes"
  });

  const initialResult = await persistTaskWorkspace({
    stateRoot,
    task: initial,
    localAgentId: "zac-agent",
    syncedAt: "2026-07-19T10:48:51.000Z"
  });
  assert.equal(initialResult.issue.pendingOnAgentId, "project-hermes");
  assert.equal(initialResult.contextEnvelope.pendingOnAgentId, "project-hermes");

  const replied = v05Task("task_v05_pending", {
    taskVersion: 4,
    turnSequence: 1,
    fromAgentId: "project-hermes",
    toAgentId: "zac-agent"
  });
  const repliedResult = await persistTaskWorkspace({
    stateRoot,
    task: replied,
    localAgentId: "zac-agent",
    syncedAt: "2026-07-19T10:49:04.000Z"
  });
  assert.equal(repliedResult.issue.pendingOnAgentId, "zac-agent");
  assert.equal(repliedResult.contextEnvelope.pendingOnAgentId, "zac-agent");
  assert.equal((await readTaskIndex({ stateRoot })).tasks.task_v05_pending.pendingOnAgentId, "zac-agent");

  const completedResult = await persistTaskWorkspace({
    stateRoot,
    task: { ...replied, status: "completed", task_version: 5 },
    localAgentId: "zac-agent",
    syncedAt: "2026-07-19T10:50:00.000Z"
  });
  assert.equal(completedResult.issue.pendingOnAgentId, "");
  assert.equal(completedResult.contextEnvelope.pendingOnAgentId, "");
});

test("v0.5 workspace title prefers Message subject, then legacy Subject line, then done criteria", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-v05-subject-"));
  const stateRoot = join(root, "state");
  const structured = v05Task("task_v05_structured", {
    fromAgentId: "project-hermes",
    toAgentId: "zac-agent"
  });
  structured.messages[0].subject = "Structured title";
  let result = await persistTaskWorkspace({ stateRoot, task: structured, localAgentId: "zac-agent" });
  assert.equal(result.issue.subject, "Structured title");

  const legacy = v05Task("task_v05_legacy", {
    fromAgentId: "project-hermes",
    toAgentId: "zac-agent"
  });
  legacy.messages[0].parts = [{
    kind: "text",
    text: "Project Hermes dispatch.\nSubject：Legacy title from body\nPriority: high"
  }];
  result = await persistTaskWorkspace({ stateRoot, task: legacy, localAgentId: "zac-agent" });
  assert.equal(result.issue.subject, "Legacy title from body");

  const fallback = v05Task("task_v05_fallback", {
    fromAgentId: "project-hermes",
    toAgentId: "zac-agent"
  });
  result = await persistTaskWorkspace({ stateRoot, task: fallback, localAgentId: "zac-agent" });
  assert.equal(result.issue.subject, "Hermes returns an ACK.");
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

test("recoverPendingTaskSyncs resumes durable local jobs without pending-task discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  await markTaskSyncPending({
    stateRoot,
    taskId: "task_recover_local",
    eventId: "evt_recover_local",
    at: "2026-07-13T01:00:00.000Z"
  });
  const fetched = [];

  const result = await recoverPendingTaskSyncs({
    stateRoot,
    fetchTask: async (taskId) => {
      fetched.push(taskId);
      return { task: sampleTask(taskId) };
    },
    localAgentId: "zac-agent"
  });

  assert.deepEqual(fetched, ["task_recover_local"]);
  assert.equal(result.discovered, 1);
  assert.equal(result.ready, 1);
  assert.equal(result.failed, 0);
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_recover_local" });
  assert.equal(workspace.sync.status, "context_ready");
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

test("persistTaskWorkspace ignores an older full snapshot without regressing context", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const current = sampleTask("task_monotonic");
  current.goal_version = 2;
  current.exchange_epoch = 3;
  current.updated_at = 200;
  current.messages.push({ message_id: "message_2", parts: [{ kind: "text", text: "Newest" }] });
  await persistTaskWorkspace({ stateRoot, task: current, localAgentId: "zac-agent" });

  const older = sampleTask("task_monotonic");
  older.updated_at = 100;
  const result = await persistTaskWorkspace({
    stateRoot,
    task: older,
    localAgentId: "zac-agent",
    eventId: "evt_older",
    syncedAt: "2026-07-13T02:00:00.000Z"
  });

  assert.equal(result.ignoredOlderSnapshot, true);
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_monotonic" });
  assert.equal(workspace.task.goal_version, 2);
  assert.equal(workspace.task.messages.at(-1).message_id, "message_2");
  assert.equal(workspace.sync.lastEventId, "evt_older");
});

test("rebuildTaskIndex regenerates task projection only from local workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  await persistTaskWorkspace({ stateRoot, task: sampleTask("task_rebuild"), localAgentId: "zac-agent" });
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_rebuild" });
  await writeFile(workspace.paths.handoffPath, "Old prompt that sends immediately.\n");
  await rm(join(stateRoot, "task-index.json"));

  const result = await rebuildTaskIndex({
    stateRoot,
    localAgentId: "zac-agent",
    agentsMdPath: join(root, "AGENTS.md"),
    now: () => "2026-07-13T02:10:00.000Z"
  });

  assert.equal(result.rebuilt, 1);
  const index = await readTaskIndex({ stateRoot });
  assert.equal(index.tasks.task_rebuild.contextSyncStatus, "context_ready");
  assert.equal(index.tasks.task_rebuild.taskId, "task_rebuild");
  assert.match(index.tasks.task_rebuild.handoffPrompt, /Stop after the draft and wait for my next message/);
  assert.doesNotMatch(index.tasks.task_rebuild.handoffPrompt, /Old prompt/);
  assert.equal(
    await readFile(workspace.paths.handoffPath, "utf8"),
    index.tasks.task_rebuild.handoffPrompt
  );
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

test("handoff binding includes current Message and Project Hermes metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-binding-"));
  const stateRoot = join(root, "state");
  const task = {
    ...v05Task("task_binding", { status: "open", taskVersion: 2, turnSequence: 1, fromAgentId: "project-hermes", toAgentId: "zac-agent" }),
    protocol_version: "agent-collab-v0.6",
    current_message_id: "message_2",
    messages: [{
      message_id: "message_2",
      metadata: {
        project_hermes: {
          task_kind: "card_submission",
          human_event_id: "he-card",
          local_task_id: "task-local"
        }
      },
      delivery_status: "delivered",
      parts: [{ kind: "text", text: "Submit the card." }]
    }]
  };
  try {
    const result = await persistTaskWorkspace({ stateRoot, task, localAgentId: "zac-agent" });
    assert.match(result.handoffPrompt, /task_id=task_binding/);
    assert.match(result.handoffPrompt, /current_message_id=message_2/);
    assert.match(result.handoffPrompt, /card_submission/);
    assert.match(result.handoffPrompt, /he-card/);
    assert.match(result.handoffPrompt, /task-local/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { buildTaskHandoffPrompt, deriveTaskHandoffBinding } from "../scripts/agentrelay-task-workspace.mjs";

function hermesTask(taskId, { metadata, currentMessageId = "message_1", historicalMetadata = null }) {
  const messages = [{
    message_id: "message_1",
    from_agent_id: "frank-agent",
    to_agent_id: "zac-agent",
    parts: [{ kind: "text", text: "Please inspect the dashboard." }],
    ...(metadata !== undefined ? { metadata: { project_hermes: metadata } } : {})
  }];
  if (historicalMetadata !== null) {
    messages.unshift({
      message_id: "message_0",
      from_agent_id: "frank-agent",
      to_agent_id: "zac-agent",
      parts: [{ kind: "text", text: "older message" }],
      metadata: { project_hermes: historicalMetadata }
    });
  }
  return {
    ...sampleTask(taskId),
    current_message_id: currentMessageId,
    messages
  };
}

test("handoff binding metadata matrix: missing, null, empty object, fields, historical-only", () => {
  const agentsMdPath = "/tmp/AGENTS.md";
  const base = { taskId: "t", taskDir: "/tmp/t", contextPath: "/tmp/t/context.md", agentsMdPath };

  const missing = buildTaskHandoffPrompt({ ...base, task: hermesTask("t", { metadata: undefined }) });
  assert.match(missing, /project_hermes=not applicable \(the current message carries no project_hermes metadata\)/);
  assert.doesNotMatch(missing, /project_hermes=\{\}/);
  assert.doesNotMatch(missing, /project_hermes\.task_kind/);

  const nullMetadata = buildTaskHandoffPrompt({ ...base, task: hermesTask("t", { metadata: null }) });
  assert.match(nullMetadata, /project_hermes=not applicable/);

  const emptyObject = buildTaskHandoffPrompt({ ...base, task: hermesTask("t", { metadata: {} }) });
  assert.match(emptyObject, /project_hermes=\{\} \(present on the current message but carries no binding fields\)/);
  assert.doesNotMatch(emptyObject, /not applicable/);

  const fields = buildTaskHandoffPrompt({
    ...base,
    task: hermesTask("t", {
      metadata: { task_kind: "enablement", human_event_id: "he_1", local_task_id: "p2-163" }
    })
  });
  assert.match(fields, /project_hermes\.task_kind=enablement/);
  assert.match(fields, /project_hermes\.human_event_id=he_1/);
  assert.match(fields, /project_hermes\.local_task_id=p2-163/);
  assert.doesNotMatch(fields, /not applicable/);

  // Historical message carries metadata; the CURRENT message does not: the
  // binding must not inherit the historical values.
  const historicalOnly = buildTaskHandoffPrompt({
    ...base,
    task: hermesTask("t", {
      metadata: undefined,
      historicalMetadata: { task_kind: "stale", human_event_id: "old", local_task_id: "old" }
    })
  });
  assert.match(historicalOnly, /project_hermes=not applicable/);
  assert.doesNotMatch(historicalOnly, /stale/);

  const binding = deriveTaskHandoffBinding(
    hermesTask("t", { metadata: { task_kind: "k" } })
  );
  assert.deepEqual(Object.keys(binding.projectHermes), ["task_kind", "human_event_id", "local_task_id"]);
  assert.equal(binding.projectHermesPresent, true);
  const missingBinding = deriveTaskHandoffBinding(hermesTask("t", { metadata: undefined }));
  assert.equal(missingBinding.projectHermesPresent, false);
  assert.equal(missingBinding.projectHermes, null);
});

test("mismatched identity still demands an immediate stop, related task allows read-only verification", () => {
  const agentsMdPath = "/tmp/AGENTS.md";
  const base = { taskId: "t", taskDir: "/tmp/t", contextPath: "/tmp/t/context.md", agentsMdPath };
  const prompt = buildTaskHandoffPrompt({ ...base, task: hermesTask("t", { metadata: {} }) });
  assert.match(prompt, /If task_id, current_message_id, or relay_status differs, stop immediately/);
  assert.match(prompt, /continue read-only verification of that task's identity, status, and business association/);
  assert.match(prompt, /Never replace or process the other Task in place of this one/);
  assert.match(prompt, /Pause and explain the evidence only when a binding conflict is confirmed/);
  // Approval constraints preserved.
  assert.match(prompt, /Do not call agentrelay_prepare_local_action or any AgentRelay mutation in this turn/);
});

test("persistTaskWorkspace renders the not-applicable binding for metadata-free messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const task = hermesTask("task_no_meta", { metadata: undefined });
  await persistTaskWorkspace({
    stateRoot, task, localAgentId: "zac-agent", source: "test",
    eventId: "evt_1", syncedAt: "2026-07-13T01:00:00.000Z",
    agentsMdPath: join(root, "AGENTS.md")
  });
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_no_meta" });
  assert.match(workspace.handoffPrompt, /project_hermes=not applicable/);
  assert.doesNotMatch(workspace.handoffPrompt, /project_hermes=\{\}/);
  assert.match(await readFile(workspace.paths.handoffPath, "utf8"), /not applicable/);
});

test("same-version resync overwrites an old handoff with the new prompt rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  // Old-format task saved with metadata on the current message.
  const oldTask = hermesTask("task_resync", {
    metadata: { task_kind: "enablement", human_event_id: "he_9", local_task_id: "p2-163" }
  });
  await persistTaskWorkspace({
    stateRoot, task: oldTask, localAgentId: "zac-agent", source: "test",
    eventId: "evt_old", syncedAt: "2026-07-13T01:00:00.000Z",
    agentsMdPath: join(root, "AGENTS.md")
  });
  // Simulate an OLD handoff written by the previous generator version.
  const workspaceBefore = await readTaskWorkspace({ stateRoot, taskId: "task_resync" });
  await writeFile(workspaceBefore.paths.handoffPath, "- project_hermes={}\n", "utf8");

  // Same version, metadata REMOVED from the current message after resync.
  const freshTask = hermesTask("task_resync", { metadata: undefined });
  await resyncLocalTask({
    stateRoot, taskId: "task_resync",
    fetchTask: async () => freshTask,
    agentsMdPath: join(root, "AGENTS.md"),
    now: () => new Date("2026-07-13T02:00:00.000Z")
  });
  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_resync" });
  const handoff = await readFile(workspace.paths.handoffPath, "utf8");
  assert.match(handoff, /not applicable/);
  assert.doesNotMatch(handoff, /project_hermes=\{\}/);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = Object.values(inbox.issues || {}).find((entry) => entry.taskId === "task_resync");
  assert.ok(issue, "inbox projection exists");
  assert.match(issue.handoffPrompt, /not applicable/);
  assert.match(issue.handoffPrompt, /continue read-only verification/);
});

test("rebuildTaskIndex regenerates prompts with the new rules and approval constraints", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-task-workspace-"));
  const stateRoot = join(root, "state");
  const tasks = [
    hermesTask("task_rebuild_a", { metadata: { task_kind: "k1", human_event_id: "h1", local_task_id: "l1" } }),
    hermesTask("task_rebuild_b", { metadata: {} })
  ];
  for (const [index, task] of tasks.entries()) {
    await persistTaskWorkspace({
      stateRoot, task, localAgentId: "zac-agent", source: "test",
      eventId: `evt_${index}`, syncedAt: "2026-07-13T01:00:00.000Z",
      agentsMdPath: join(root, "AGENTS.md")
    });
  }
  await rm(join(stateRoot, "task-index.json"), { force: true });
  await rm(join(stateRoot, "issues.json"), { force: true });
  const summary = await rebuildTaskIndex({ stateRoot, agentsMdPath: join(root, "AGENTS.md") });
  assert.equal(summary.rebuilt, 2);
  const index = await readTaskIndex({ stateRoot });
  assert.match(index.tasks.task_rebuild_a.handoffPrompt, /project_hermes\.task_kind=k1/);
  assert.match(index.tasks.task_rebuild_b.handoffPrompt, /present on the current message but carries no binding fields/);
  for (const taskId of ["task_rebuild_a", "task_rebuild_b"]) {
    assert.match(index.tasks[taskId].handoffPrompt, /continue read-only verification/);
    assert.match(index.tasks[taskId].handoffPrompt, /Do not call agentrelay_prepare_local_action or any AgentRelay mutation in this turn/);
  }
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
    task_expires_at: 1783070400,
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

function v05Task(taskId, {
  status = "open",
  taskVersion = 1,
  turnSequence = 0,
  fromAgentId,
  toAgentId
}) {
  const messageId = `message_${taskVersion}`;
  return {
    task_id: taskId,
    root_task_id: taskId,
    protocol_version: "agent-collab-v0.5",
    requester_agent_id: "zac-agent",
    target_agent_id: "project-hermes",
    done_criteria: "Hermes returns an ACK.",
    status,
    task_version: taskVersion,
    turn_sequence: turnSequence,
    current_message_id: messageId,
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    messages: [{
      message_id: messageId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_status: "delivered",
      parts: [{ kind: "text", text: "ACK" }]
    }],
    artifacts: []
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

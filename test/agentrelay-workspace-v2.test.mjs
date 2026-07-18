import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  persistTaskWorkspace,
  readTaskWorkspace,
  taskWorkspacePaths,
  taskWorkspacePathsV2,
  verifyWorkspaceV2Ready
} from "../scripts/agentrelay-task-workspace.mjs";
import { unwrapTask } from "../scripts/agentrelay-task-context-sync.mjs";

function detail() {
  return {
    task: {
      task_id: "task_v05",
      root_task_id: "task_v05",
      protocol_version: "agent-collab-v0.5",
      requester_agent_id: "zac-agent",
      target_agent_id: "frank-agent",
      done_criteria: "pong",
      status: "open",
      current_message_id: "msg_1",
      turn_sequence: 1,
      task_version: 1,
      from_agent_id: "zac-agent",
      to_agent_id: "frank-agent",
      max_turns: 3,
      updated_at: 10
    },
    messages: [{
      message_id: "msg_1",
      task_id: "task_v05",
      turn_sequence: 1,
      from_agent_id: "zac-agent",
      to_agent_id: "frank-agent",
      delivery_status: "pending",
      parts: [{ kind: "text", text: "ping" }]
    }]
  };
}

test("workspace v2 isolates v0.5 and stores Task separately from Messages", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-workspace-v2-"));
  const task = unwrapTask(detail());
  await persistTaskWorkspace({ stateRoot, task, localAgentId: "frank-agent" });

  const v2 = taskWorkspacePathsV2(stateRoot, "task_v05");
  const legacy = taskWorkspacePaths(stateRoot, "task_v05");
  assert.equal(existsSync(legacy.remotePath), false);
  assert.equal(existsSync(v2.remotePath), true);
  assert.equal(existsSync(v2.messagesPath), true);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(v2.remotePath, "utf8")), "messages"), false);
  assert.equal(JSON.parse(await readFile(v2.messagesPath, "utf8")).length, 1);

  const workspace = await readTaskWorkspace({ stateRoot, taskId: "task_v05" });
  assert.equal(workspace.paths.workspaceVersion, 2);
  assert.equal(workspace.task.task_version, 1);
  assert.equal(workspace.task.messages[0].delivery_status, "pending");
});

test("v0.5 detail normalization preserves ordered Messages without inventing artifacts", () => {
  const task = unwrapTask(detail());
  assert.equal(task.messages[0].message_id, "msg_1");
  assert.deepEqual(task.artifacts, []);
});

test("workspace v2 readiness performs a write/read probe without creating a Task", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-workspace-v2-ready-"));
  try {
    assert.deepEqual(await verifyWorkspaceV2Ready({ stateRoot }), { workspaceVersion: 2, verified: true });
    assert.deepEqual(await readdir(join(stateRoot, "collaboration-v2")), ["tasks"]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

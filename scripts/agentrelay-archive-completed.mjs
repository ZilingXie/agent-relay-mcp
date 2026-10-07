#!/usr/bin/env node

// Archive relay tasks whose relay status is terminal (completed, failed,
// cancelled, expired, rejected) so they stop appearing in the active scan
// (duplicate-AppID conflict check, daily summary collection). Archived tasks
// are skipped by the executor and excluded from handoff conflict scans.

import { resolve } from "node:path";
import { readTaskIndex, archiveTaskWorkspace } from "./agentrelay-task-workspace.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired", "rejected"]);
const dryRun = process.argv.includes("--dry-run");

const stateRoot = resolve(process.env.AGENTRELAY_STATE_DIR || resolve(process.cwd(), "state"));
const index = await readTaskIndex({ stateRoot });
const tasks = Object.values(index.tasks || {});

const toArchive = tasks.filter((t) => {
  const relayStatus = String(t.relayStatus || "");
  const localStatus = String(t.localStatus || "");
  return TERMINAL_STATUSES.has(relayStatus) && localStatus !== "archived";
});

const archived = [];
const errors = [];
if (!dryRun) {
  for (const task of toArchive) {
    try {
      await archiveTaskWorkspace({ stateRoot, taskId: task.taskId });
      archived.push(task.taskId);
    } catch (err) {
      errors.push({ taskId: task.taskId, error: String(err) });
    }
  }
}

const result = {
  stateRoot,
  dryRun,
  total_tasks: tasks.length,
  terminal_active: toArchive.length,
  already_archived: tasks.filter((t) => String(t.localStatus || "") === "archived").length,
  non_terminal: tasks.filter((t) => !TERMINAL_STATUSES.has(String(t.relayStatus || ""))).length,
  ...(dryRun ? { would_archive: toArchive.map((t) => ({ taskId: t.taskId, relayStatus: t.relayStatus })) } : { archived, errors })
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

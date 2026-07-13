import {
  markTaskSyncFailed,
  markTaskSyncPending,
  persistTaskWorkspace,
  readTaskIndex,
  sanitizeSyncError,
  withTaskWorkspaceLock
} from "./agentrelay-task-workspace.mjs";

const inFlightResyncs = new Map();

export async function resyncLocalTask({
  stateRoot,
  taskId,
  fetchTask,
  initialTask = null,
  localAgentId = "",
  source = "manual",
  eventId = "",
  maxAttempts = 1,
  retryDelayMs = 250,
  sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  now = () => new Date().toISOString(),
  agentsMdPath
}) {
  if (!stateRoot) throw new Error("State root is required for local task resync");
  if (!taskId) throw new Error("Task id is required for local task resync");
  if (!initialTask && typeof fetchTask !== "function") throw new Error("fetchTask is required for local task resync");
  const key = `${stateRoot}\u0000${taskId}`;
  if (inFlightResyncs.has(key)) return inFlightResyncs.get(key);
  const promise = withTaskWorkspaceLock({ stateRoot, taskId }, async () => {
    const startedAt = now();
    await markTaskSyncPending({ stateRoot, taskId, eventId, source, at: startedAt, lock: false });
    const attempts = [];
    let lastError = null;
    const limit = Math.max(1, Number(maxAttempts || 1));
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const attemptedAt = now();
      try {
        const task = attempt === 1 && initialTask ? initialTask : unwrapTask(await fetchTask(taskId));
        validateTask(task, taskId);
        const result = await persistTaskWorkspace({
          stateRoot,
          task,
          localAgentId,
          source,
          eventId,
          syncedAt: now(),
          agentsMdPath,
          lock: false
        });
        return {
          status: "context_ready",
          taskId: String(taskId),
          attempts: [...attempts, { attempt, at: attemptedAt, status: "succeeded" }],
          contextEnvelope: result.contextEnvelope,
          staleActionIds: result.staleActionIds,
          task: result.task,
          paths: result.paths
        };
      } catch (error) {
        lastError = error;
        attempts.push({ attempt, at: attemptedAt, status: "failed", error: sanitizeSyncError(error) });
        if (attempt < limit) await sleep(retryDelayMs);
      }
    }
    const failedAt = now();
    const result = await markTaskSyncFailed({
      stateRoot,
      taskId,
      eventId,
      source,
      attempts,
      error: lastError,
      at: failedAt,
      agentsMdPath,
      lock: false
    });
    return {
      status: "context_sync_failed",
      taskId: String(taskId),
      attempts,
      error: result.sync.lastError,
      handoffPrompt: result.handoffPrompt,
      paths: result.paths
    };
  });
  inFlightResyncs.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightResyncs.delete(key);
  }
}

export function unwrapTask(response) {
  return response?.data?.task || response?.task || response || null;
}

export async function recoverPendingTaskSyncs({
  stateRoot,
  fetchTask,
  localAgentId = "",
  maxAttempts = 2,
  retryDelayMs = 250,
  sleep,
  now = () => new Date().toISOString(),
  agentsMdPath
}) {
  const index = await readTaskIndex({ stateRoot });
  const pending = Object.values(index.tasks || {}).filter((issue) => issue?.contextSyncStatus === "context_sync_pending");
  const results = [];
  for (const issue of pending) {
    results.push(await resyncLocalTask({
      stateRoot,
      taskId: issue.taskId,
      fetchTask,
      localAgentId,
      source: "local_recovery",
      eventId: issue.lastEventId || "",
      maxAttempts,
      retryDelayMs,
      sleep,
      now,
      agentsMdPath
    }));
  }
  return {
    discovered: pending.length,
    ready: results.filter((result) => result.status === "context_ready").length,
    failed: results.filter((result) => result.status === "context_sync_failed").length,
    results
  };
}

function validateTask(task, expectedTaskId) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("Relay response is missing task snapshot");
  const taskId = task.task_id || task.taskId;
  if (!taskId) throw new Error("Relay task response is missing task id");
  if (String(taskId) !== String(expectedTaskId)) {
    throw new Error(`Relay task id mismatch: expected ${expectedTaskId}, received ${taskId}`);
  }
  if (!Array.isArray(task.messages)) throw new Error("Relay task response is missing ordered messages");
  if (!Array.isArray(task.artifacts)) throw new Error("Relay task response is missing ordered artifacts");
}

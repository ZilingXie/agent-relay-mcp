import {
  compareTaskContextEnvelopes,
  hashStableJson,
  readLocalAction,
  updateLocalAction
} from "./agentrelay-task-workspace.mjs";
import { resyncLocalTask, unwrapTask } from "./agentrelay-task-context-sync.mjs";

export async function executePreparedTaskAction({
  stateRoot,
  taskId,
  clientActionId,
  actionType,
  payload,
  confirmationRef = "",
  fetchTask,
  mutate,
  localAgentId = "",
  now = () => new Date().toISOString(),
  agentsMdPath
}) {
  const { action } = await readLocalAction({ stateRoot, taskId, clientActionId });
  if (action.actionType !== actionType) {
    return rejection("ACTION_TYPE_CHANGED", taskId, clientActionId, {
      expectedActionType: action.actionType,
      receivedActionType: actionType
    });
  }
  const payloadHash = hashStableJson(payload || {});
  if (payloadHash !== action.payloadHash) {
    return rejection("ACTION_PAYLOAD_CHANGED", taskId, clientActionId, {
      expectedPayloadHash: action.payloadHash,
      receivedPayloadHash: payloadHash
    });
  }
  if (action.status === "sent") {
    return {
      ok: true,
      status: "already_sent",
      taskId: String(taskId),
      clientActionId,
      idempotencyKey: action.idempotencyKey,
      relayResponse: action.relayResponse || null
    };
  }
  if (action.status === "stale") {
    return rejection("CONTEXT_CHANGED", taskId, clientActionId, {
      changedFields: action.changedFields || []
    });
  }
  if (!new Set(["awaiting_confirmation", "submission_unknown"]).has(action.status)) {
    return rejection("ACTION_NOT_SUBMITTABLE", taskId, clientActionId, { actionStatus: action.status });
  }

  const syncResult = await resyncLocalTask({
    stateRoot,
    taskId,
    fetchTask,
    localAgentId,
    source: "mutation_guard",
    maxAttempts: 1,
    now,
    agentsMdPath
  });
  if (syncResult.status !== "context_ready") {
    return rejection("CONTEXT_SYNC_FAILED", taskId, clientActionId, {
      error: syncResult.error || null,
      handoffPrompt: syncResult.handoffPrompt || ""
    });
  }
  const comparison = compareTaskContextEnvelopes(action.baseContextEnvelope, syncResult.contextEnvelope);
  if (!comparison.matches) {
    await updateLocalAction({
      stateRoot,
      taskId,
      clientActionId,
      patch: { status: "stale", changedFields: comparison.changedFields, staleAt: now() },
      at: now()
    });
    return rejection("CONTEXT_CHANGED", taskId, clientActionId, {
      changedFields: comparison.changedFields,
      expectedContextEnvelope: action.baseContextEnvelope,
      currentContextEnvelope: syncResult.contextEnvelope
    });
  }

  await updateLocalAction({
    stateRoot,
    taskId,
    clientActionId,
    patch: {
      status: "submitting",
      confirmationRef: String(confirmationRef || action.confirmationRef || ""),
      lastSubmissionAt: now(),
      submissionAttempts: Number(action.submissionAttempts || 0) + 1
    },
    at: now()
  });

  let relayResponse;
  try {
    relayResponse = await mutate(action.idempotencyKey);
  } catch (error) {
    await updateLocalAction({
      stateRoot,
      taskId,
      clientActionId,
      patch: {
        status: "submission_unknown",
        lastSubmissionError: sanitizeSubmissionError(error)
      },
      at: now()
    });
    throw error;
  }

  const returnedTask = unwrapTask(relayResponse);
  const completeReturnedTask = returnedTask && Array.isArray(returnedTask.messages) && Array.isArray(returnedTask.artifacts)
    ? returnedTask
    : null;
  const postSync = await resyncLocalTask({
    stateRoot,
    taskId,
    fetchTask,
    initialTask: completeReturnedTask,
    localAgentId,
    source: "mutation_success",
    maxAttempts: 1,
    now,
    agentsMdPath
  });
  const relayResponseSummary = summarizeRelayResponse(relayResponse);
  await updateLocalAction({
    stateRoot,
    taskId,
    clientActionId,
    patch: {
      status: "sent",
      sentAt: now(),
      relayResponse: relayResponseSummary,
      postSubmitSyncStatus: postSync.status
    },
    at: now()
  });
  return {
    ok: true,
    status: "sent",
    taskId: String(taskId),
    clientActionId,
    idempotencyKey: action.idempotencyKey,
    relayResponse,
    contextSyncStatus: postSync.status
  };
}

export function legacyActionIdempotencyKey({ taskId, actionType, payload }) {
  return `mcp-${actionType}-${hashStableJson({ taskId: String(taskId), payload }).slice(0, 32)}`;
}

function rejection(code, taskId, clientActionId, details = {}) {
  return { ok: false, status: "rejected", code, taskId: String(taskId), clientActionId, ...details };
}

function sanitizeSubmissionError(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0) || null;
  return {
    category: statusCode ? "relay_rejected_or_unavailable" : "network_or_unknown",
    statusCode,
    message: "Relay action result is unknown. Retry the same prepared action id to reuse its idempotency key."
  };
}

function summarizeRelayResponse(response) {
  const task = unwrapTask(response);
  return {
    taskId: String(task?.task_id || task?.taskId || ""),
    status: String(task?.status || ""),
    artifactId: String(response?.artifact?.artifact_id || response?.data?.artifact?.artifact_id || "")
  };
}

import {
  approveLocalAction,
  compareTaskContextEnvelopes,
  hashStableJson,
  isLocalAuthorizationCurrent,
  readLocalAction,
  readLocalApproval,
  updateLocalAction
} from "./agentrelay-task-workspace.mjs";
import { resyncLocalTask, unwrapTask } from "./agentrelay-task-context-sync.mjs";
import {
  authorizeServiceAction,
  loadServicePolicy,
  validateLocalAuthorization
} from "./agentrelay-service-policy.mjs";

export async function authorizePreparedTaskActionWithElicitation({
  stateRoot,
  taskId,
  clientActionId,
  clientName = "mcp-client",
  elicit,
  now = () => new Date().toISOString()
}) {
  const { action } = await readLocalAction({ stateRoot, taskId, clientActionId });
  if (action.status === "sent") {
    return {
      ok: true,
      status: "already_sent",
      taskId: String(taskId),
      clientActionId,
      confirmationRef: action.confirmationRef
    };
  }
  if (action.status === "stale") {
    return rejection("CONTEXT_CHANGED", taskId, clientActionId, {
      changedFields: action.changedFields || []
    });
  }
  if (!new Set(["awaiting_confirmation", "submission_unknown"]).has(action.status)) {
    return rejection("ACTION_NOT_SUBMITTABLE", taskId, clientActionId, {
      actionStatus: action.status
    });
  }
  if (isLocalAuthorizationCurrent(action.authorization, {
    at: now(),
    allowedStatuses: ["active", "submitting"]
  })) {
    return {
      ok: true,
      status: "already_authorized",
      taskId: String(taskId),
      clientActionId,
      confirmationRef: action.confirmationRef
    };
  }
  if (action.status === "submission_unknown") {
    return rejection("LOCAL_AUTHORIZATION_EXPIRED", taskId, clientActionId, {
      message: "The authorization for this ambiguous submission expired. Inspect Relay state before preparing another action."
    });
  }
  if (typeof elicit !== "function") {
    return rejection("MCP_ELICITATION_UNSUPPORTED", taskId, clientActionId, {
      message: "This MCP client cannot show in-session action confirmation. Use a client with MCP form elicitation support or approve the exact action in the Local Inbox.",
      fallbackUrl: "http://127.0.0.1:8787/"
    });
  }

  let response;
  try {
    response = await elicit({
      mode: "form",
      message: buildActionApprovalMessage(action),
      requestedSchema: { type: "object", properties: {} }
    });
  } catch (error) {
    return rejection("MCP_ELICITATION_UNAVAILABLE", taskId, clientActionId, {
      message: `The MCP client could not show action confirmation: ${String(error?.message || error)}`
    });
  }
  if (response?.action !== "accept") {
    return rejection(
      response?.action === "decline" ? "LOCAL_APPROVAL_DECLINED" : "LOCAL_APPROVAL_CANCELLED",
      taskId,
      clientActionId,
      { message: "The AgentRelay action was not sent." }
    );
  }

  const approvedBy = `mcp_elicitation:${sanitizeApprovalActor(clientName)}`;
  const approval = await approveLocalAction({
    stateRoot,
    taskId,
    clientActionId,
    approvedBy,
    at: now()
  });
  return {
    ok: true,
    status: approval.alreadyApproved ? "already_authorized" : "approved",
    taskId: String(taskId),
    clientActionId,
    approvalId: approval.approvalId,
    confirmationRef: approval.confirmationRef,
    expiresAt: approval.expiresAt
  };
}

export async function executePreparedTaskAction({
  stateRoot,
  taskId,
  clientActionId,
  actionType,
  payload,
  confirmationRef = "",
  fetchTask,
  mutate,
  validateCurrentTask,
  resultTaskMode = "same_task",
  localAgentId = "",
  servicePolicyPath = "",
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
  const semanticActionHash = hashStableJson({
    actionType: action.actionType,
    payloadHash: action.payloadHash,
    baseContextEnvelope: action.baseContextEnvelope
  });
  if (action.semanticActionHash && action.semanticActionHash !== semanticActionHash) {
    return rejection("SEMANTIC_ACTION_CHANGED", taskId, clientActionId);
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
  if (typeof validateCurrentTask === "function") {
    try {
      validateCurrentTask(syncResult.task);
    } catch (error) {
      return rejection("INVALID_TASK_TRANSITION", taskId, clientActionId, { message: error.message });
    }
  }

  let authorizedAction = action;
  if (authorizedAction.authorization?.type === "service_policy_grant" && !servicePolicyPath) {
    return rejection("LOCAL_AUTHORIZATION_REQUIRED", taskId, clientActionId);
  }
  if (servicePolicyPath
    && action.status === "awaiting_confirmation") {
    const policy = await loadServicePolicy(servicePolicyPath);
    const decision = authorizeServiceAction({
      policy,
      action: authorizedAction,
      task: syncResult.task,
      localAgentId,
      at: now()
    });
    if (!decision.ok) return rejection(decision.code, taskId, clientActionId);
    authorizedAction = { ...authorizedAction, authorization: decision.grant };
    await updateLocalAction({
      stateRoot,
      taskId,
      clientActionId,
      patch: { authorization: decision.grant },
      at: now()
    });
  }
  let approvalRecord = null;
  if (authorizedAction.authorization?.type === "human_approval") {
    try {
      ({ approval: approvalRecord } = await readLocalApproval({
        stateRoot,
        taskId,
        approvalId: authorizedAction.authorization.approvalId
      }));
    } catch {
      return rejection("LOCAL_APPROVAL_RECORD_MISMATCH", taskId, clientActionId);
    }
  }
  const authorizationCheck = validateLocalAuthorization({
    action: authorizedAction,
    confirmationRef,
    approvalRecord,
    localAgentId,
    now: now()
  });
  if (!authorizationCheck.ok) return rejection(authorizationCheck.code, taskId, clientActionId);
  const submittingAuthorization = { ...authorizationCheck.authorization, status: "submitting" };

  await updateLocalAction({
    stateRoot,
    taskId,
    clientActionId,
    patch: {
      status: "submitting",
      confirmationRef: String(authorizedAction.confirmationRef || ""),
      authorization: submittingAuthorization,
      lastSubmissionAt: now(),
      submissionAttempts: Number(action.submissionAttempts || 0) + 1
    },
    at: now()
  });

  let relayResponse;
  try {
    relayResponse = await mutate(action.idempotencyKey);
  } catch (error) {
    if (new Set(["stale_task_state", "stale_task_version", "stale_message", "stale_turn"]).has(error?.code)) {
      const currentTask = error.currentTask;
      const syncResult = await resyncLocalTask({
        stateRoot,
        taskId,
        fetchTask,
        initialTask: currentTask && Array.isArray(currentTask.messages) ? currentTask : null,
        localAgentId,
        source: "stale_task_state",
        maxAttempts: 1,
        now,
        agentsMdPath
      });
      await updateLocalAction({
        stateRoot,
        taskId,
        clientActionId,
        patch: {
          status: "stale",
          staleAt: now(),
          changedFields: (["agent-collab-v0.5", "agent-collab-v0.6"].includes(action.baseContextEnvelope?.protocolVersion))
            ? ["currentMessageId", "turnSequence", "taskVersion"]
            : ["currentMessageId", "turnSequence", "statusVersion"],
          relayConflictCode: error.code
        },
        at: now()
      });
      return rejection("STALE_TASK_STATE", taskId, clientActionId, {
        currentTask,
        contextSyncStatus: syncResult.status
      });
    }
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
  const returnedTaskId = String(completeReturnedTask?.task_id || completeReturnedTask?.taskId || "");
  const postSyncTaskId = resultTaskMode === "new_task" && returnedTaskId ? returnedTaskId : taskId;
  const postSync = await resyncLocalTask({
    stateRoot,
    taskId: postSyncTaskId,
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
      authorization: { ...submittingAuthorization, status: "consumed", consumedAt: now() },
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
    resultTaskId: postSyncTaskId,
    clientActionId,
    idempotencyKey: action.idempotencyKey,
    relayResponse,
    contextSyncStatus: postSync.status
  };
}

function buildActionApprovalMessage(action) {
  return [
    "Approve this exact AgentRelay action once?",
    "",
    `Task: ${action.taskId}`,
    `Action ID: ${action.clientActionId}`,
    `Action type: ${action.actionType}`,
    "Payload:",
    JSON.stringify(action.payload || {}, null, 2)
  ].join("\n");
}

function sanitizeApprovalActor(value) {
  return String(value || "mcp-client").replace(/[\r\n\t]/g, " ").slice(0, 80) || "mcp-client";
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

import { createHash } from "node:crypto";

export const PROTOCOL_V04 = "agent-collab-v0.4";
export const FAILED_REASONS_V04 = [
  "delivery_retry_exhausted",
  "listener_persistence_failed",
  "relay_persistence_failed",
  "agent_reported_failure",
  "max_turns_exhausted",
  "internal_consistency_error"
];

export function mutationContextV04(task) {
  const currentMessageId = requiredString(task?.current_message_id ?? task?.currentMessageId, "current_message_id");
  return {
    current_message_id: currentMessageId,
    turn_sequence: requiredPositiveInt(task?.turn_sequence ?? task?.turnSequence, "turn_sequence"),
    expected_status_version: requiredPositiveInt(task?.status_version ?? task?.statusVersion, "status_version")
  };
}

export function buildCreatePayloadV04(args, idempotencyKey) {
  return compact({
    protocol_version: PROTOCOL_V04,
    idempotency_key: requiredString(idempotencyKey, "idempotency_key"),
    requester_agent_id: requiredString(args.requesterAgentId, "requesterAgentId"),
    target_agent_id: requiredString(args.targetAgentId, "targetAgentId"),
    subject: args.subject,
    done_criteria: requiredString(args.doneCriteria, "doneCriteria"),
    max_turns: args.maxTurns,
    task_expires_at: args.taskExpiresAt,
    message: { parts: [{ kind: "text", text: requiredString(args.requestText, "requestText") }] }
  });
}

export function buildMessagePayloadV04(args, idempotencyKey) {
  return {
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotency_key"),
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    parts: [{ kind: "text", text: requiredString(args.text, "text") }]
  };
}

export function buildCompletePayloadV04(args, idempotencyKey) {
  return {
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotency_key"),
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    completed_against_message_id: requiredString(args.completedAgainstMessageId, "completedAgainstMessageId")
  };
}

export function buildFailPayloadV04(args, idempotencyKey) {
  const reason = requiredString(args.reason, "reason");
  if (!FAILED_REASONS_V04.includes(reason)) throw new Error(`Unsupported v0.4 failed reason: ${reason}`);
  return {
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotency_key"),
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    reason
  };
}

export function buildFollowupPayloadV04(args, idempotencyKey) {
  return compact({
    idempotency_key: requiredString(idempotencyKey, "idempotency_key"),
    subject: args.subject,
    done_criteria: requiredString(args.doneCriteria, "doneCriteria"),
    max_turns: args.maxTurns,
    task_expires_at: args.taskExpiresAt,
    message: { parts: [{ kind: "text", text: requiredString(args.requestText, "requestText") }] }
  });
}

export function messageAckMetadataV04(event, agentId) {
  const eventType = event?.eventType || event?.event_type || event?.type;
  if (eventType !== "task.message_pending") return null;
  const payload = event.payload || {};
  const messageId = requiredString(event.messageId || event.message_id || payload.message_id, "message_id");
  const taskId = requiredString(event.taskId || event.task_id || payload.task_id, "task_id");
  const turnSequence = requiredPositiveInt(event.turnSequence ?? event.turn_sequence ?? payload.turn_sequence, "turn_sequence");
  const statusVersion = requiredPositiveInt(event.statusVersion ?? event.status_version ?? payload.status_version, "status_version");
  const actor = requiredString(agentId || event.agentId || event.agent_id, "agent_id");
  return {
    agentId: actor,
    messageId,
    taskId,
    payload: {
      task_id: taskId,
      message_id: messageId,
      current_message_id: messageId,
      turn_sequence: turnSequence,
      expected_status_version: statusVersion,
      idempotency_key: `listener-v04-ack-${digest(`${actor}:${taskId}:${messageId}:${turnSequence}:${statusVersion}`)}`
    }
  };
}

export function validatePreparedActionV04(actionType, task, args) {
  if ((task?.protocol_version || task?.protocolVersion) !== PROTOCOL_V04) {
    throw new Error("v0.4 action requires a Protocol v0.4 Task");
  }
  if (["completed", "expired", "failed"].includes(task.status) && actionType !== "create_followup_v04") {
    throw new Error(`Task is terminal: ${task.status}`);
  }
  const context = mutationContextV04(task);
  if (actionType !== "create_followup_v04") {
    if (args.currentMessageId !== context.current_message_id
      || args.turnSequence !== context.turn_sequence
      || args.expectedStatusVersion !== context.expected_status_version) {
      throw new Error("Prepared v0.4 action does not match the current Message/turn/status version");
    }
  }
  if (actionType === "send_message_v04") {
    if (task.status !== "delivered") throw new Error("A new Message requires delivered status");
    if (args.actorAgentId !== (task.to_agent_id || task.toAgentId)) throw new Error("Only current to_agent_id may send the next Message");
    if (args.actorAgentId === (task.from_agent_id || task.fromAgentId)) throw new Error("The same Agent cannot send consecutive Messages");
    const requester = task.requester_agent_id || task.requesterAgentId;
    if (args.actorAgentId === requester && context.turn_sequence >= Number(task.max_turns || task.maxTurns || 12)) {
      throw new Error("max_turns_reached: requester must complete or fail the Task");
    }
  }
  if (actionType === "complete_task_v04") {
    const requester = task.requester_agent_id || task.requesterAgentId;
    const target = task.target_agent_id || task.targetAgentId;
    if (args.actorAgentId !== requester || task.status !== "delivered") throw new Error("Only requester may complete a delivered Task");
    if ((task.from_agent_id || task.fromAgentId) !== target) throw new Error("Completion requires a delivered target response");
    if (args.completedAgainstMessageId !== context.current_message_id) throw new Error("Completion evidence must be the current Message");
  }
  if (actionType === "fail_task_v04") {
    const requester = task.requester_agent_id || task.requesterAgentId;
    if (args.reason === "max_turns_exhausted"
      && (args.actorAgentId !== requester || task.status !== "delivered" || context.turn_sequence < Number(task.max_turns || task.maxTurns || 12))) {
      throw new Error("max_turns_exhausted requires requester at delivered max_turns");
    }
    if (args.reason === "agent_reported_failure"
      && (task.status !== "delivered" || args.actorAgentId !== (task.to_agent_id || task.toAgentId))) {
      throw new Error("agent_reported_failure requires the current action owner in delivered");
    }
  }
  if (actionType === "create_followup_v04" && !["completed", "expired", "failed"].includes(task.status)) {
    throw new Error("Follow-up source Task must be terminal");
  }
}

function mutationArgsContext(args) {
  return {
    current_message_id: requiredString(args.currentMessageId, "currentMessageId"),
    turn_sequence: requiredPositiveInt(args.turnSequence, "turnSequence"),
    expected_status_version: requiredPositiveInt(args.expectedStatusVersion, "expectedStatusVersion")
  };
}

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requiredPositiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

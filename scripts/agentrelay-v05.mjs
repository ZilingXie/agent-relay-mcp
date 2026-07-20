import { createHash } from "node:crypto";

export const PROTOCOL_V05 = "agent-collab-v0.5";
export const FAILED_REASONS_V05 = [
  "delivery_retry_exhausted",
  "listener_persistence_failed",
  "relay_persistence_failed",
  "agent_reported_failure",
  "max_turns_exhausted",
  "internal_consistency_error"
];

export function mutationContextV05(task) {
  return {
    message_id: requiredString(task?.current_message_id ?? task?.currentMessageId, "current_message_id"),
    turn_sequence: requiredPositiveInt(task?.turn_sequence ?? task?.turnSequence, "turn_sequence"),
    expected_task_version: requiredPositiveInt(task?.task_version ?? task?.taskVersion, "task_version")
  };
}

export function buildCreatePayloadV05(args, idempotencyKey) {
  const requester = requiredString(args.requesterAgentId, "requesterAgentId");
  const target = requiredString(args.targetAgentId, "targetAgentId");
  if (requester === target) throw new Error("requesterAgentId and targetAgentId must differ");
  return compact({
    protocol_version: PROTOCOL_V05,
    idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
    requester_agent_id: requester,
    target_agent_id: target,
    done_criteria: requiredValue(args.doneCriteria, "doneCriteria"),
    max_turns: optionalPositiveInt(args.maxTurns, "maxTurns"),
    task_expires_at: optionalPositiveInt(args.taskExpiresAt, "taskExpiresAt"),
    message: requiredInitialMessage(args.message, "message")
  });
}

export function buildMessagePayloadV05(args, idempotencyKey) {
  return {
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
    parts: requiredParts(args.parts, "parts")
  };
}

export function buildCompletePayloadV05(args, idempotencyKey) {
  return {
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
    completed_against_message_id: requiredString(args.completedAgainstMessageId, "completedAgainstMessageId")
  };
}

export function buildFailPayloadV05(args, idempotencyKey) {
  const reason = requiredString(args.reason, "reason");
  if (!FAILED_REASONS_V05.includes(reason)) throw new Error(`Unsupported v0.5 failed reason: ${reason}`);
  return {
    actor_agent_id: requiredString(args.actorAgentId, "actorAgentId"),
    ...mutationArgsContext(args),
    idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
    reason
  };
}

export function buildFollowupPayloadV05(args, idempotencyKey) {
  return compact({
    idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
    done_criteria: requiredValue(args.doneCriteria, "doneCriteria"),
    max_turns: optionalPositiveInt(args.maxTurns, "maxTurns"),
    task_expires_at: optionalPositiveInt(args.taskExpiresAt, "taskExpiresAt"),
    message: requiredInitialMessage(args.message, "message")
  });
}

export function messageAckPayloadV05({ event, task, listenerInstanceId, readinessEpoch }) {
  const eventId = requiredString(event?.eventId ?? event?.event_id, "event_id");
  const eventMessageId = requiredString(event?.messageId ?? event?.message_id, "event.message_id");
  const context = mutationContextV05(task);
  if (eventMessageId !== context.message_id) throw new Error("v0.5 Event does not match the current Message");
  return {
    task_id: requiredString(task?.task_id ?? task?.taskId, "task_id"),
    event_id: eventId,
    ...context,
    idempotency_key: stableDeliveryKey("message-ack", task, eventId),
    listener_instance_id: requiredString(listenerInstanceId, "listener_instance_id"),
    readiness_epoch: requiredPositiveInt(readinessEpoch, "readiness_epoch")
  };
}

export function informationalAckPayloadV05({ event, listenerInstanceId, readinessEpoch }) {
  const eventId = requiredString(event?.eventId ?? event?.event_id, "event_id");
  return {
    idempotency_key: `listener-event-ack-${digest(eventId)}`,
    listener_instance_id: requiredString(listenerInstanceId, "listener_instance_id"),
    readiness_epoch: requiredPositiveInt(readinessEpoch, "readiness_epoch")
  };
}

export function validatePreparedActionV05(actionType, task, args) {
  if ((task?.protocol_version || task?.protocolVersion) !== PROTOCOL_V05) {
    throw new Error("v0.5 action requires a Protocol v0.5 Task");
  }
  const context = mutationContextV05(task);
  const supplied = mutationArgsContext(args);
  if (context.message_id !== supplied.message_id
    || context.turn_sequence !== supplied.turn_sequence
    || context.expected_task_version !== supplied.expected_task_version) {
    throw new Error("Prepared v0.5 action does not match the current Message/turn/task version");
  }
  const currentMessage = currentMessageFor(task);
  const requester = task.requester_agent_id || task.requesterAgentId;
  const target = task.target_agent_id || task.targetAgentId;
  const toAgent = task.to_agent_id || task.toAgentId;
  if (task.status !== "open") throw new Error(`Task is terminal: ${task.status}`);

  if (actionType === "send_message_v05") {
    if (currentMessage?.delivery_status !== "delivered") throw new Error("Current Message must be delivered before replying");
    if (args.actorAgentId !== toAgent) throw new Error("Only current to_agent_id may send the next Message");
    if (args.actorAgentId === requester && context.turn_sequence >= Number(task.max_turns || task.maxTurns || 12)) {
      throw new Error("max_turns_reached: requester must complete or fail the Task");
    }
  } else if (actionType === "complete_task_v05") {
    if (args.actorAgentId !== requester || (task.from_agent_id || task.fromAgentId) !== target) {
      throw new Error("Completion requires requester confirmation of the current target response");
    }
    if (currentMessage?.delivery_status !== "delivered") throw new Error("Completion requires a delivered target response");
    if (args.completedAgainstMessageId !== context.message_id) throw new Error("Completion evidence must be the current Message");
  } else if (actionType === "fail_task_v05") {
    if (args.reason === "max_turns_exhausted"
      && (args.actorAgentId !== requester || context.turn_sequence < Number(task.max_turns || task.maxTurns || 12))) {
      throw new Error("max_turns_exhausted requires requester at max_turns");
    }
    if (args.reason === "agent_reported_failure"
      && (args.actorAgentId !== toAgent || currentMessage?.delivery_status !== "delivered")) {
      throw new Error("agent_reported_failure requires the current action owner after delivery");
    }
  }
}

export function validateFollowupSourceV05(task) {
  if ((task?.protocol_version || task?.protocolVersion) !== PROTOCOL_V05) {
    throw new Error("v0.5 follow-up requires a Protocol v0.5 Task");
  }
  if (!["completed", "expired", "failed"].includes(task.status)) {
    throw new Error("Follow-up source Task must be terminal");
  }
}

function mutationArgsContext(args) {
  return {
    message_id: requiredString(args.currentMessageId, "currentMessageId"),
    turn_sequence: requiredPositiveInt(args.turnSequence, "turnSequence"),
    expected_task_version: requiredPositiveInt(args.expectedTaskVersion, "expectedTaskVersion")
  };
}

function currentMessageFor(task) {
  const id = task.current_message_id || task.currentMessageId;
  return (Array.isArray(task.messages) ? task.messages : []).find((message) => (
    message.message_id || message.messageId
  ) === id);
}

function stableDeliveryKey(prefix, task, eventId) {
  const context = mutationContextV05(task);
  const taskId = task.task_id || task.taskId;
  return `listener-${prefix}-${digest([taskId, context.message_id, context.turn_sequence, context.expected_task_version, eventId].join(":"))}`;
}

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requiredValue(value, field) {
  if ((typeof value === "string" && value.trim()) || (value && typeof value === "object" && !Array.isArray(value))) return value;
  throw new Error(`${field} is required`);
}

function requiredInitialMessage(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is required`);
  const subject = requiredString(value.subject, `${field}.subject`);
  if (subject.length > 120) throw new Error(`${field}.subject must be at most 120 characters`);
  return { subject, parts: requiredParts(value.parts, `${field}.parts`) };
}

function requiredParts(value, field) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((part) => !part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).length === 0)) {
    throw new Error(`${field} must be a non-empty array of non-empty objects`);
  }
  return value;
}

function requiredPositiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function optionalPositiveInt(value, field) {
  return value === undefined || value === null ? undefined : requiredPositiveInt(value, field);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

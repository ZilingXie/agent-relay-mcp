import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const SUPPORTED_POLICY_VERSION = 1;

export async function loadServicePolicy(path) {
  if (!path) return null;
  const policy = JSON.parse(await readFile(path, "utf8"));
  validateServicePolicy(policy);
  return policy;
}

export function validateServicePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Service policy must be an object");
  assertAllowedKeys(policy, ["policy_version", "agent_id", "rules", "denied_operations"], "service policy");
  if (policy.policy_version !== SUPPORTED_POLICY_VERSION) throw new Error(`Unsupported service policy version: ${policy.policy_version}`);
  requiredString(policy.agent_id, "service policy agent_id");
  if (!Array.isArray(policy.rules) || !policy.rules.length) throw new Error("Service policy must define rules");
  const ids = new Set();
  const operations = new Set();
  for (const rule of policy.rules) {
    const id = requiredString(rule?.id, "service policy rule id");
    if (ids.has(id)) throw new Error(`Duplicate service policy rule: ${id}`);
    ids.add(id);
    if (!new Set(["reply", "fail_task", "complete_task"]).has(rule.operation)) {
      throw new Error(`Service policy operation is not allowed: ${rule.operation}`);
    }
    if (operations.has(rule.operation)) throw new Error(`Duplicate service policy operation: ${rule.operation}`);
    operations.add(rule.operation);
    assertAllowedKeys(
      rule,
      rule.operation === "reply"
        ? ["id", "operation", "max_text_bytes", "attachments", "side_effects"]
        : (rule.operation === "fail_task"
            ? ["id", "operation", "allowed_reasons", "side_effects"]
            : ["id", "operation", "side_effects"]),
      `service policy rule ${id}`
    );
    if (rule.side_effects !== "none") throw new Error(`Service policy rule ${id} must forbid local side effects`);
    if (rule.operation === "fail_task") {
      const reasons = rule.allowed_reasons || [];
      if (!Array.isArray(reasons) || reasons.length !== 1 || reasons[0] !== "agent_reported_failure") {
        throw new Error("Service policy may only authorize agent_reported_failure");
      }
    }
    if (rule.operation === "reply" && (!Number.isInteger(rule.max_text_bytes) || rule.max_text_bytes < 1)) {
      throw new Error(`Invalid max_text_bytes for service policy rule: ${id}`);
    }
    if (rule.operation === "reply") validateAttachmentPolicy(rule.attachments, id);
  }
  const denied = policy.denied_operations;
  const requiredDenied = ["amend_task", "change_participants", "create_followup", "create_task"];
  if (!Array.isArray(denied)
    || JSON.stringify([...denied].sort()) !== JSON.stringify(requiredDenied)) {
    throw new Error("Service policy denied_operations must explicitly cover requester-owned mutations");
  }
  return policy;
}

export function authorizeServiceAction({ policy, action, task, localAgentId, at = new Date().toISOString() }) {
  validateServicePolicy(policy);
  if (policy.agent_id !== localAgentId) return rejection("SERVICE_POLICY_AGENT_MISMATCH");
  if (!task || !["agent-collab-v0.5", "agent-collab-v0.6"].includes(task.protocol_version)) {
    return rejection("SERVICE_POLICY_PROTOCOL_MISMATCH");
  }
  if (task.status !== "open") return rejection("SERVICE_POLICY_TASK_NOT_OPEN");
  const current = (task.messages || []).find((message) => message.message_id === task.current_message_id);
  if (!current || current.delivery_status !== "delivered") return rejection("SERVICE_POLICY_MESSAGE_NOT_DELIVERED");
  if (action.actionType === "complete_task") {
    const completionOwner = task.completion_owner_agent_id || task.requester_agent_id;
    if (completionOwner !== localAgentId
      || task.requester_agent_id !== localAgentId
      || task.to_agent_id !== localAgentId
      || task.from_agent_id !== task.target_agent_id) {
      return rejection("SERVICE_POLICY_NOT_COMPLETION_OWNER");
    }
  } else if (task.target_agent_id !== localAgentId || task.to_agent_id !== localAgentId) {
    return rejection("SERVICE_POLICY_NOT_CURRENT_OWNER");
  }
  const rule = policy.rules.find((candidate) => candidate.operation === action.actionType);
  if (!rule) return rejection("SERVICE_POLICY_OPERATION_DENIED");
  if (action.actionType === "reply") {
    if (!serviceReplyAllowed(action.payload, rule)) {
      return rejection("SERVICE_POLICY_CONTENT_DENIED");
    }
  }
  if (action.actionType === "fail_task" && !(rule.allowed_reasons || []).includes(action.payload?.reason)) {
    return rejection("SERVICE_POLICY_REASON_DENIED");
  }
  const issuedAt = new Date(at);
  const grant = {
    version: 1,
    type: "service_policy_grant",
    grantId: `policy_grant_${randomUUID()}`,
    policyVersion: policy.policy_version,
    ruleId: rule.id,
    agentId: localAgentId,
    actionType: action.actionType,
    payloadHash: action.payloadHash,
    contextHash: hashStableJson(action.baseContextEnvelope),
    semanticActionHash: action.semanticActionHash || hashStableJson({
      actionType: action.actionType,
      payloadHash: action.payloadHash,
      baseContextEnvelope: action.baseContextEnvelope
    }),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    status: "active"
  };
  return { ok: true, grant };
}

function validateAttachmentPolicy(attachments, ruleId) {
  if (attachments === undefined) return;
  if (!attachments || typeof attachments !== "object" || Array.isArray(attachments)) {
    throw new Error(`Invalid attachments policy for service policy rule: ${ruleId}`);
  }
  assertAllowedKeys(
    attachments,
    ["enabled", "allowed_roots", "allowed_mime_types", "max_files", "max_total_bytes"],
    `attachments policy ${ruleId}`
  );
  if (typeof attachments.enabled !== "boolean") throw new Error(`attachments.enabled must be boolean: ${ruleId}`);
  if (!attachments.enabled) return;
  if (!Array.isArray(attachments.allowed_roots) || attachments.allowed_roots.length === 0
    || attachments.allowed_roots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error(`attachments.allowed_roots must contain absolute paths: ${ruleId}`);
  }
  if (!Array.isArray(attachments.allowed_mime_types) || attachments.allowed_mime_types.length === 0
    || attachments.allowed_mime_types.some((mime) => typeof mime !== "string" || !mime.trim())) {
    throw new Error(`attachments.allowed_mime_types must be non-empty: ${ruleId}`);
  }
  if (!Number.isInteger(attachments.max_files) || attachments.max_files < 1 || attachments.max_files > 8) {
    throw new Error(`attachments.max_files must be between 1 and 8: ${ruleId}`);
  }
  if (!Number.isInteger(attachments.max_total_bytes) || attachments.max_total_bytes < 1
    || attachments.max_total_bytes > 64 * 1024 * 1024) {
    throw new Error(`attachments.max_total_bytes is invalid: ${ruleId}`);
  }
}

function serviceReplyAllowed(payload, rule) {
  const parts = typeof payload?.text === "string"
    ? [{ kind: "text", text: payload.text }]
    : payload?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  const textParts = parts.filter((part) => part?.kind === "text" && typeof part.text === "string");
  const fileParts = parts.filter((part) => part?.kind === "file");
  if (textParts.length + fileParts.length !== parts.length || textParts.length === 0) return false;
  const text = textParts.map((part) => part.text).join("\n");
  if (!text || Buffer.byteLength(text, "utf8") > Number(rule.max_text_bytes || 20000)) return false;
  if (fileParts.length === 0) return true;
  const attachments = rule.attachments;
  if (!attachments?.enabled || fileParts.length > attachments.max_files) return false;
  let totalBytes = 0;
  for (const part of fileParts) {
    if (!serviceFilePartAllowed(part, attachments)) return false;
    totalBytes += Number(part.size_bytes);
  }
  return totalBytes <= attachments.max_total_bytes;
}

function serviceFilePartAllowed(part, attachments) {
  try {
    if (typeof part.local_path !== "string" || !isAbsolute(part.local_path)) return false;
    const actualPath = realpathSync(part.local_path);
    const withinAllowedRoot = attachments.allowed_roots.some((root) => {
      try {
        const actualRoot = realpathSync(resolve(root));
        const child = relative(actualRoot, actualPath);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
      } catch {
        return false;
      }
    });
    if (!withinAllowedRoot) return false;
    const info = statSync(actualPath);
    if (!info.isFile() || info.size < 1 || info.size !== Number(part.size_bytes)) return false;
    const mimeType = String(part.mime_type || "application/octet-stream").toLowerCase();
    return attachments.allowed_mime_types.includes(mimeType);
  } catch {
    return false;
  }
}

export function validateLocalAuthorization({
  action,
  confirmationRef = "",
  approvalRecord = null,
  localAgentId = "",
  now = new Date()
}) {
  const authorization = action?.authorization;
  if (!authorization) return rejection("LOCAL_AUTHORIZATION_REQUIRED");
  if (!new Set(["human_approval", "service_policy_grant"]).has(authorization.type)) {
    return rejection("LOCAL_AUTHORIZATION_TYPE_INVALID");
  }
  if (!new Set(["active", "submitting"]).has(authorization.status)) return rejection("LOCAL_AUTHORIZATION_CONSUMED");
  const semanticActionHash = action.semanticActionHash || hashStableJson({
    actionType: action.actionType,
    payloadHash: action.payloadHash,
    baseContextEnvelope: action.baseContextEnvelope
  });
  if (authorization.actionType !== action.actionType
    || authorization.payloadHash !== action.payloadHash
    || authorization.contextHash !== hashStableJson(action.baseContextEnvelope)
    || (authorization.semanticActionHash && authorization.semanticActionHash !== semanticActionHash)) {
    return rejection("LOCAL_AUTHORIZATION_SCOPE_MISMATCH");
  }
  const issuedAt = new Date(authorization.issuedAt).getTime();
  const expiresAt = new Date(authorization.expiresAt).getTime();
  const checkedAt = new Date(now).getTime();
  if (![issuedAt, expiresAt, checkedAt].every(Number.isFinite) || expiresAt <= issuedAt || issuedAt > checkedAt) {
    return rejection("LOCAL_AUTHORIZATION_TIME_INVALID");
  }
  if (expiresAt <= checkedAt) return rejection("LOCAL_AUTHORIZATION_EXPIRED");
  if (authorization.type === "human_approval") {
    const expectedRef = `local-approval:${authorization.approvalId}`;
    if (action.confirmationRef !== expectedRef || (confirmationRef && confirmationRef !== expectedRef)) {
      return rejection("LOCAL_AUTHORIZATION_REFERENCE_MISMATCH");
    }
    if (!approvalRecord
      || approvalRecord.taskId !== action.taskId
      || approvalRecord.clientActionId !== action.clientActionId
      || !authorizationFieldsMatch(authorization, approvalRecord)) {
      return rejection("LOCAL_APPROVAL_RECORD_MISMATCH");
    }
  }
  if (authorization.type === "service_policy_grant"
    && (!localAgentId || authorization.agentId !== localAgentId)) {
    return rejection("SERVICE_POLICY_AGENT_MISMATCH");
  }
  return { ok: true, authorization };
}

export function hashStableJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
  return value.trim();
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value || {})) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function authorizationFieldsMatch(authorization, record) {
  return [
    "version", "type", "approvalId", "approvedBy", "actionType", "payloadHash",
    "contextHash", "semanticActionHash", "issuedAt", "expiresAt"
  ].every((field) => authorization[field] === record[field]);
}

function rejection(code) {
  return { ok: false, code };
}

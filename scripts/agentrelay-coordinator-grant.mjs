import crypto from "node:crypto";

export const COORDINATOR_GRANT_OPERATIONS = Object.freeze([
  "batch",
  "complete-own",
  "create",
  "read"
]);

const PROTOCOL_VERSION = "agent-collab-v0.6";

export class CoordinatorGrantClient {
  constructor({ baseUrl, token, agentId, username = "", fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.identityToken = String(token || "");
    this.agentId = requiredString(agentId, "agentId");
    this.username = String(username || "");
    this.fetchImpl = fetchImpl;
    this.grants = new Map();
    this.handlesByGrantId = new Map();
  }

  async issue(input) {
    const claims = normalizeGrantClaims(input, this.agentId);
    const response = await this.request("POST", "/coordinator-grants", claims);
    const token = requiredString(response?.coordinator_grant_token, "coordinator_grant_token");
    const grant = validateIssuedGrant(response?.grant, claims);
    let handle = this.handlesByGrantId.get(grant.grant_id);
    if (!handle) {
      handle = `cgh_${crypto.randomUUID().replaceAll("-", "")}`;
      this.handlesByGrantId.set(grant.grant_id, handle);
    }
    this.grants.set(handle, { token, grant, claims });
    return { grant_handle: handle, grant };
  }

  async createTask(handle, input) {
    const entry = this.requireHandle(handle);
    const payload = buildCoordinatorTaskPayload(entry.claims, input);
    return this.withGrantRetry(handle, () => this.request(
      "POST",
      "/tasks",
      payload,
      this.grantHeaders(this.requireHandle(handle).token)
    ));
  }

  async resolveTask(handle, { idempotencyKey, workItemId } = {}) {
    const entry = this.requireHandle(handle);
    const payload = {
      idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
      ...(workItemId ? { work_item_id: requiredString(workItemId, "workItemId") } : {})
    };
    return this.withGrantRetry(handle, () => {
      const current = this.requireHandle(handle);
      return this.request(
        "POST",
        `/coordinator-grants/${encodeURIComponent(current.grant.grant_id)}/tasks/resolve`,
        payload,
        this.grantHeaders(current.token)
      );
    });
  }

  async getTask(handle, taskId) {
    const normalizedTaskId = requiredString(taskId, "taskId");
    return this.withGrantRetry(handle, () => this.request(
      "GET",
      `/tasks/${encodeURIComponent(normalizedTaskId)}`,
      undefined,
      this.grantHeaders(this.requireHandle(handle).token)
    ));
  }

  async getTaskVisibilityBatch(handle, taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 100) {
      throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "taskIds must contain 1 to 100 Task ids");
    }
    const normalized = [...new Set(taskIds.map((taskId) => requiredString(taskId, "taskId")))];
    return this.withGrantRetry(handle, () => this.request(
      "POST",
      "/task-visibility/batch",
      { task_ids: normalized },
      this.grantHeaders(this.requireHandle(handle).token)
    ));
  }

  async completeOwnTask(handle, { taskId, idempotencyKey } = {}) {
    const normalizedTaskId = requiredString(taskId, "taskId");
    const detail = await this.getTask(handle, normalizedTaskId);
    const task = detail?.task;
    if (!task || task.task_id !== normalizedTaskId) {
      throw clientError("COORDINATOR_GRANT_TASK_MISMATCH", "Relay Task snapshot does not match taskId");
    }
    if (task.requester_agent_id !== this.agentId) {
      throw clientError("COORDINATOR_GRANT_TASK_NOT_OWNED", "Coordinator can complete only its own Task");
    }
    const payload = {
      actor_agent_id: this.agentId,
      message_id: requiredString(task.current_message_id, "task.current_message_id"),
      turn_sequence: requiredPositiveInteger(task.turn_sequence, "task.turn_sequence"),
      expected_task_version: requiredPositiveInteger(task.task_version, "task.task_version"),
      idempotency_key: requiredString(idempotencyKey, "idempotencyKey"),
      completed_against_message_id: task.current_message_id
    };
    return this.withGrantRetry(handle, () => this.request(
      "POST",
      `/tasks/${encodeURIComponent(normalizedTaskId)}/complete`,
      payload,
      this.grantHeaders(this.requireHandle(handle).token)
    ));
  }

  publicGrant(handle) {
    const entry = this.requireHandle(handle);
    return { grant_handle: handle, grant: structuredClone(entry.grant) };
  }

  requireHandle(handle) {
    const normalized = requiredString(handle, "grantHandle");
    const entry = this.grants.get(normalized);
    if (!entry) {
      throw clientError(
        "COORDINATOR_GRANT_HANDLE_UNKNOWN",
        "Coordinator Grant handle is unknown in this process; reissue with the original issuance key"
      );
    }
    return entry;
  }

  async withGrantRetry(handle, operation) {
    this.requireHandle(handle);
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "invalid_coordinator_grant") throw error;
      const entry = this.requireHandle(handle);
      await this.issue(entry.claims);
      return operation();
    }
  }

  grantHeaders(token) {
    return { "X-AgentRelay-Coordinator-Grant": token };
  }

  async request(method, path, payload, extraHeaders = {}) {
    if (!this.baseUrl) throw clientError("AGENTRELAY_BASE_URL_MISSING", "Missing AgentRelay base URL");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.identityToken ? { Authorization: `Bearer ${this.identityToken}` } : {}),
        "X-AgentRelay-Agent-Id": this.agentId,
        ...(this.username ? { "X-AgentRelay-Username": this.username } : {}),
        ...extraHeaders
      },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw clientError("AGENTRELAY_NON_JSON_RESPONSE", `AgentRelay returned non-JSON response (${response.status})`);
    }
    if (response.ok) return data;
    const error = clientError(
      data?.error?.code || data?.code || "AGENTRELAY_REQUEST_FAILED",
      `AgentRelay ${method} ${path} failed (${response.status})`
    );
    error.statusCode = response.status;
    error.responseData = data;
    throw error;
  }
}

export function normalizeGrantClaims(input, coordinatorAgentId) {
  const targets = input?.targetAgentIds || input?.target_agent_ids;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "targetAgentIds must contain 1 to 100 Agent ids");
  }
  const normalizedTargets = [...new Set(targets.map((target) => requiredString(target, "targetAgentId")))].sort();
  if (normalizedTargets.length !== targets.length) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "targetAgentIds must be unique");
  }
  const taskExpiresAt = requiredPositiveInteger(
    input?.taskExpiresAt ?? input?.task_expires_at,
    "taskExpiresAt"
  );
  const grantExpiresAt = requiredPositiveInteger(
    input?.grantExpiresAt ?? input?.grant_expires_at,
    "grantExpiresAt"
  );
  if (grantExpiresAt <= taskExpiresAt) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "grantExpiresAt must be later than taskExpiresAt");
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    issuance_key: requiredString(input?.issuanceKey ?? input?.issuance_key, "issuanceKey"),
    coordinator_agent_id: requiredString(coordinatorAgentId, "coordinatorAgentId"),
    investigation_id: requiredString(input?.investigationId ?? input?.investigation_id, "investigationId"),
    round_id: requiredString(input?.roundId ?? input?.round_id, "roundId"),
    approved_plan_digest: requiredString(
      input?.approvedPlanDigest ?? input?.approved_plan_digest,
      "approvedPlanDigest"
    ),
    authority_ref: requiredString(input?.authorityRef ?? input?.authority_ref, "authorityRef"),
    target_agent_ids: normalizedTargets,
    task_count: requiredPositiveInteger(input?.taskCount ?? input?.task_count, "taskCount"),
    task_expires_at: taskExpiresAt,
    grant_expires_at: grantExpiresAt,
    operations: [...COORDINATOR_GRANT_OPERATIONS]
  };
}

export function buildCoordinatorTaskPayload(claims, input) {
  const targetAgentId = requiredString(input?.targetAgentId, "targetAgentId");
  if (!claims.target_agent_ids.includes(targetAgentId)) {
    throw clientError("COORDINATOR_GRANT_CLAIM_MISMATCH", "Task target is outside the Grant target set");
  }
  const workItemId = requiredString(input?.workItemId, "workItemId");
  const message = input?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "message must be an object");
  }
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "message.metadata must be an object");
  }
  const expectedMetadata = {
    investigation_id: claims.investigation_id,
    round_id: claims.round_id,
    work_item_id: workItemId,
    approved_plan_digest: claims.approved_plan_digest
  };
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (metadata[key] !== value) {
      throw clientError("COORDINATOR_GRANT_CLAIM_MISMATCH", `message.metadata.${key} does not match the Grant`);
    }
  }
  if (!Array.isArray(message.parts) || message.parts.length < 1) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "message.parts must be non-empty");
  }
  const doneCriteria = input?.doneCriteria;
  if (doneCriteria === undefined || doneCriteria === null) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", "doneCriteria is required");
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: requiredString(input?.idempotencyKey, "idempotencyKey"),
    requester_agent_id: claims.coordinator_agent_id,
    target_agent_id: targetAgentId,
    done_criteria: structuredClone(doneCriteria),
    max_turns: 1,
    task_expires_at: claims.task_expires_at,
    message: {
      subject: requiredString(message.subject, "message.subject"),
      metadata: structuredClone(metadata),
      parts: structuredClone(message.parts)
    }
  };
}

function validateIssuedGrant(grant, claims) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw clientError("COORDINATOR_GRANT_RESPONSE_INVALID", "Grant response is missing grant metadata");
  }
  const exact = {
    coordinator_agent_id: claims.coordinator_agent_id,
    investigation_id: claims.investigation_id,
    round_id: claims.round_id,
    approved_plan_digest: claims.approved_plan_digest,
    authority_ref: claims.authority_ref,
    task_count: claims.task_count,
    task_expires_at: claims.task_expires_at,
    grant_expires_at: claims.grant_expires_at
  };
  for (const [key, value] of Object.entries(exact)) {
    if (grant[key] !== value) {
      throw clientError("COORDINATOR_GRANT_RESPONSE_INVALID", `Grant response ${key} does not match the request`);
    }
  }
  const operations = [...(grant.operations || [])].sort();
  if (JSON.stringify(operations) !== JSON.stringify(COORDINATOR_GRANT_OPERATIONS)) {
    throw clientError("COORDINATOR_GRANT_RESPONSE_INVALID", "Grant response operations do not match the fixed contract");
  }
  requiredString(grant.grant_id, "grant.grant_id");
  requiredString(grant.claims_digest, "grant.claims_digest");
  requiredPositiveInteger(grant.token_version, "grant.token_version");
  return structuredClone(grant);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requiredPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw clientError("COORDINATOR_GRANT_INVALID_INPUT", `${name} must be a positive integer`);
  }
  return value;
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export const PROTOCOL_RUNTIME_VERSION = "0.3.0";
export const PROTOCOL_RUNTIME_CAPABILITIES = [
  "dynamic_protocol_bundle_v0.1",
  "semantic_protocol_adapter_v2",
  "local_authorization_v1"
];
export const SUPPORTED_PROTOCOL_VERSIONS = ["agent-collab-v0.5"];
export const ADAPTER_ENGINE = "semantic_protocol_adapter_v2";
export const ADAPTER_CONTRACT_VERSION = 1;

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_POINTER_DEPTH = 16;
const MAX_POINTER_LENGTH = 512;
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const PROTECTED_SLOTS = new Set([
  "actor_agent_id",
  "requester_agent_id",
  "target_agent_id",
  "idempotency_key",
  "message_id",
  "turn_sequence",
  "expected_task_version",
  "completed_against_message_id",
  "failure_reason"
]);

const OPERATION_CONTRACTS = {
  create_task: operationContract("POST", "/tasks", "task-create-v05.schema.json", {
    protocol_version: fixedValue("agent-collab-v0.5"),
    idempotency_key: trustedSource("runtime.idempotency_key"),
    requester_agent_id: trustedSource("identity.agent_id"),
    target_agent_id: trustedSource("input.targetAgentId"),
    done_criteria: trustedSource("input.doneCriteria"),
    max_turns: trustedSource("input.maxTurns", true),
    task_expires_at: trustedSource("input.taskExpiresAt", true),
    message_kind: fixedValue("text"),
    request_text: trustedSource("input.requestText")
  }),
  reply: operationContract("POST", "/tasks/{task_id}/messages", "task-message-v05.schema.json", {
    actor_agent_id: trustedSource("identity.agent_id"),
    message_id: trustedSource("task.current_message_id"),
    turn_sequence: trustedSource("task.turn_sequence"),
    expected_task_version: trustedSource("task.task_version"),
    idempotency_key: trustedSource("runtime.idempotency_key"),
    message_kind: fixedValue("text"),
    reply_text: trustedSource("input.text")
  }),
  complete_task: operationContract("POST", "/tasks/{task_id}/complete", "task-terminal-v05.schema.json", {
    actor_agent_id: trustedSource("identity.agent_id"),
    message_id: trustedSource("task.current_message_id"),
    turn_sequence: trustedSource("task.turn_sequence"),
    expected_task_version: trustedSource("task.task_version"),
    idempotency_key: trustedSource("runtime.idempotency_key"),
    completed_against_message_id: trustedSource("task.current_message_id")
  }),
  fail_task: operationContract("POST", "/tasks/{task_id}/fail", "task-terminal-v05.schema.json", {
    actor_agent_id: trustedSource("identity.agent_id"),
    message_id: trustedSource("task.current_message_id"),
    turn_sequence: trustedSource("task.turn_sequence"),
    expected_task_version: trustedSource("task.task_version"),
    idempotency_key: trustedSource("runtime.idempotency_key"),
    failure_reason: trustedSource("input.reason")
  }),
  create_followup: operationContract("POST", "/tasks/{task_id}/followups", "task-followup-v05.schema.json", {
    idempotency_key: trustedSource("runtime.idempotency_key"),
    done_criteria: trustedSource("input.doneCriteria"),
    max_turns: trustedSource("input.maxTurns", true),
    task_expires_at: trustedSource("input.taskExpiresAt", true),
    message_kind: fixedValue("text"),
    request_text: trustedSource("input.requestText")
  })
};

export function canonicalDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function authorityCacheKey(authority) {
  const id = requiredString(authority?.id, "authority.id");
  const origin = normalizedAuthorityOrigin(authority?.origin);
  return createHash("sha256").update(`${id}\n${origin}`).digest("hex").slice(0, 24);
}

export function protocolAuthorityRoot(cacheRoot, authority) {
  return resolve(cacheRoot, "authorities", authorityCacheKey(authority));
}

export async function readActiveProtocol({ cacheRoot, authority }) {
  try {
    return JSON.parse(await readFile(resolve(protocolAuthorityRoot(cacheRoot, authority), "active.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function buildNegotiationRequest({ active = null, lastKnownGood = null } = {}) {
  return compact({
    runtime_version: PROTOCOL_RUNTIME_VERSION,
    runtime_capabilities: PROTOCOL_RUNTIME_CAPABILITIES,
    supported_protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
    active: active ? protocolPointer(active) : undefined,
    last_known_good: lastKnownGood ? protocolPointer(lastKnownGood) : undefined
  });
}

export function validateNegotiationResponse(value, { baseUrl } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Protocol negotiation response must be an object");
  }
  if (!["up_to_date", "hot_patch", "client_release_required", "hot_rollback"].includes(value.action)) {
    throw new Error(`Unsupported protocol negotiation action: ${value.action}`);
  }
  const target = value.target || {};
  requiredString(target.version, "target.version");
  requiredString(target.bundle_digest, "target.bundle_digest");
  requiredString(target.bundle_url, "target.bundle_url");
  if (!Number.isInteger(target.bundle_revision) || target.bundle_revision < 0) {
    throw new Error("target.bundle_revision must be a non-negative integer");
  }
  const authority = value.authority || {};
  requiredString(authority.id, "authority.id");
  normalizedAuthorityOrigin(authority.origin);
  if (baseUrl) assertUrlWithinBase(target.bundle_url, baseUrl, "negotiated bundle URL");
  assertUrlWithinBase(target.bundle_url, authority.origin, "protocol authority");
  if ((target.required_client_capabilities || []).includes(ADAPTER_ENGINE)
    && target.adapter_contract_version !== ADAPTER_CONTRACT_VERSION) {
    throw new Error(`Unsupported adapter contract version: ${target.adapter_contract_version}`);
  }
  if ((target.required_client_capabilities || []).includes(ADAPTER_ENGINE)) {
    validateBundleWindow(target, "target");
  }
  return value;
}

export function validateProtocolBundle(bundle, { expectedTarget, authority, baseUrl } = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Protocol bundle must be an object");
  }
  const manifest = bundle.manifest || {};
  const content = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "manifest"));
  const bundleBytes = Buffer.byteLength(canonicalJson(bundle), "utf8");
  if (bundleBytes > MAX_BUNDLE_BYTES) throw new Error(`Protocol bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  const digest = canonicalDigest(content);
  const expectedDigest = expectedTarget?.bundle_digest || manifest.bundle_digest;
  if (!expectedDigest || digest !== expectedDigest || manifest.bundle_digest !== digest) {
    throw new Error(`Protocol bundle digest mismatch: expected ${expectedDigest || "missing"}, calculated ${digest}`);
  }
  if (expectedTarget?.version && manifest.version !== expectedTarget.version) {
    throw new Error(`Protocol bundle version mismatch: expected ${expectedTarget.version}, got ${manifest.version}`);
  }
  if (expectedTarget?.bundle_revision !== undefined && manifest.bundle_revision !== expectedTarget.bundle_revision) {
    throw new Error("Protocol bundle revision does not match negotiation target");
  }
  const requiresAdapter = requiresAdapterContract(expectedTarget, manifest);
  if (requiresAdapter) {
    if (!expectedTarget) throw new Error("Protocol adapter bundle requires a verified negotiation target");
    validateBundleWindow(manifest, "manifest");
    if (expectedTarget.published_at !== manifest.published_at
      || expectedTarget.expires_at !== manifest.expires_at) {
      throw new Error("Protocol bundle validity window does not match negotiation target");
    }
  }
  const schemaDigest = canonicalDigest(bundle.schemas || {});
  if (manifest.schema_digest !== schemaDigest
    || (expectedTarget?.schema_digest && expectedTarget.schema_digest !== schemaDigest)) {
    throw new Error(`Protocol schema digest mismatch: calculated ${schemaDigest}`);
  }
  const manifestAuthority = manifest.authority || authority;
  if (!manifestAuthority) throw new Error("Protocol bundle authority is missing");
  if (authority && (manifestAuthority.id !== authority.id
    || normalizedAuthorityOrigin(manifestAuthority.origin) !== normalizedAuthorityOrigin(authority.origin))) {
    throw new Error("Protocol bundle authority does not match negotiation authority");
  }
  if (baseUrl) assertAuthorityMatchesBase(manifestAuthority.origin, baseUrl);
  if (requiresAdapter || bundle.adapters) {
    if (manifest.adapter_contract_version !== ADAPTER_CONTRACT_VERSION
      || (expectedTarget?.adapter_contract_version !== undefined
        && expectedTarget.adapter_contract_version !== ADAPTER_CONTRACT_VERSION)) {
      throw new Error(`Unsupported adapter contract version: ${manifest.adapter_contract_version}`);
    }
    validateAdapterDefinition(bundle.adapters);
  }
  createBundleValidator(bundle);
  return {
    protocol: requiredString(manifest.protocol, "manifest.protocol"),
    version: requiredString(manifest.version, "manifest.version"),
    semver: requiredString(manifest.semver, "manifest.semver"),
    bundle_revision: manifest.bundle_revision,
    schema_digest: schemaDigest,
    bundle_digest: digest,
    authority: manifestAuthority,
    bundle
  };
}

export function validateAdapterDefinition(adapters) {
  if (!adapters || adapters.engine !== ADAPTER_ENGINE) {
    throw new Error(`Protocol bundle requires the ${ADAPTER_ENGINE} engine`);
  }
  if (adapters.contract_version !== ADAPTER_CONTRACT_VERSION) {
    throw new Error(`Unsupported adapter contract version: ${adapters.contract_version}`);
  }
  assertAllowedKeys(adapters, ["engine", "contract_version", "allowed_binding_sources", "protected_slots", "operations"], "protocol adapter");
  if (canonicalJson([...(adapters.allowed_binding_sources || [])].sort())
    !== canonicalJson(["identity", "input", "runtime", "task"])) {
    throw new Error("Protocol adapter binding sources do not match the compiled contract");
  }
  if (canonicalJson([...(adapters.protected_slots || [])].sort())
    !== canonicalJson([...PROTECTED_SLOTS].sort())) {
    throw new Error("Protocol adapter protected slots do not match the compiled contract");
  }
  const operations = adapters.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
    throw new Error("Protocol adapters.operations must be an object");
  }
  const expectedOperations = Object.keys(OPERATION_CONTRACTS);
  if (Object.keys(operations).length !== expectedOperations.length
    || expectedOperations.some((operation) => !Object.hasOwn(operations, operation))) {
    throw new Error("Protocol adapter operations do not match the compiled operation contract");
  }
  for (const [operation, definition] of Object.entries(operations)) {
    const contract = OPERATION_CONTRACTS[operation];
    if (!contract) throw new Error(`Protocol adapter operation is not allowed: ${operation}`);
    assertAllowedKeys(definition, ["method", "path", "request_schema", "bindings"], `protocol operation ${operation}`);
    if (definition.method !== contract.method || definition.path !== contract.path) {
      throw new Error(`Protocol adapter route is not allowed for ${operation}`);
    }
    if (definition.request_schema !== contract.requestSchema) {
      throw new Error(`Protocol adapter schema is not allowed for ${operation}`);
    }
    if (!Array.isArray(definition.bindings) || definition.bindings.length === 0) {
      throw new Error(`Protocol adapter bindings are missing for ${operation}`);
    }
    validateOperationBindings(definition.bindings, operation, contract);
  }
  return adapters;
}

export function buildSemanticRequest({ bundle, operation, input = {}, identity = {}, task = {}, runtime = {} }) {
  validateAdapterDefinition(bundle?.adapters);
  const definition = bundle.adapters.operations[operation];
  if (!definition) throw new Error(`Protocol bundle does not define operation ${operation}`);
  validateSemanticInput(operation, input, identity, task, runtime);
  const sources = { input, identity, task: normalizeTask(task), runtime };
  const payload = Object.create(null);
  for (const binding of definition.bindings) {
    const value = Object.hasOwn(binding, "value") ? binding.value : readSource(sources, binding.from);
    if (value === undefined && binding.optional === true) continue;
    if (value === undefined) throw new Error(`Protocol binding source is missing: ${binding.from}`);
    setJsonPointer(payload, binding.to, value);
  }
  const path = definition.path.includes("{task_id}")
    ? definition.path.replace("{task_id}", encodeURIComponent(requiredString(
        input.taskId || task.task_id || task.taskId,
        "taskId"
      )))
    : definition.path;
  validateOperationPayload(bundle, definition.request_schema, payload);
  return { method: definition.method, path, payload };
}

export function validateOperationPayload(bundle, schemaName, payload) {
  const validator = createBundleValidator(bundle);
  const schema = bundle.schemas?.[schemaName];
  if (!schema) throw new Error(`Protocol bundle schema is missing: ${schemaName}`);
  const validate = validator.getSchema(schema.$id) || validator.compile(schema);
  if (!validate(payload)) {
    throw new Error(`Protocol payload failed ${schemaName}: ${validator.errorsText(validate.errors)}`);
  }
  return payload;
}

export function validateSemanticTransition(operation, task, identityAgentId, input = {}) {
  const normalized = normalizeTask(task);
  if (operation === "create_task") {
    if (identityAgentId === input.targetAgentId) throw new Error("requester and target agents must differ");
    return;
  }
  if (!normalized.task_id) throw new Error("Current Task context is required");
  if (operation === "create_followup") {
    if (!["completed", "expired", "failed"].includes(normalized.status)) {
      throw new Error("Follow-up requires a terminal Task");
    }
    return;
  }
  if (normalized.status !== "open") throw new Error(`Task is terminal: ${normalized.status}`);
  if (operation === "reply") {
    if (normalized.current_message_delivery_status !== "delivered") {
      throw new Error("Current Message must be delivered before replying");
    }
    if (identityAgentId !== normalized.to_agent_id) throw new Error("Only the current action owner may reply");
    if (identityAgentId === normalized.requester_agent_id && normalized.turn_sequence >= normalized.max_turns) {
      throw new Error("max_turns_reached: requester must complete or fail the Task");
    }
  } else if (operation === "complete_task") {
    if (identityAgentId !== normalized.requester_agent_id || normalized.from_agent_id !== normalized.target_agent_id) {
      throw new Error("Completion requires requester confirmation of the current target response");
    }
    if (normalized.current_message_delivery_status !== "delivered") {
      throw new Error("Completion requires a delivered target response");
    }
  } else if (operation === "fail_task") {
    if (!new Set(["agent_reported_failure", "max_turns_exhausted"]).has(input.reason)) {
      throw new Error(`Unsupported local failure reason: ${input.reason}`);
    }
    if (input.reason === "agent_reported_failure"
      && (identityAgentId !== normalized.to_agent_id || normalized.current_message_delivery_status !== "delivered")) {
      throw new Error("agent_reported_failure requires the current action owner after delivery");
    }
    if (input.reason === "max_turns_exhausted"
      && (identityAgentId !== normalized.requester_agent_id || normalized.turn_sequence < normalized.max_turns)) {
      throw new Error("max_turns_exhausted requires requester at max_turns");
    }
  }
}

function createBundleValidator(bundle) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  for (const schema of Object.values(bundle.schemas || {})) {
    if (schema && typeof schema === "object") ajv.addSchema(schema);
  }
  return ajv;
}

function validateOperationBindings(bindings, operation, contract) {
  const seenSlots = new Set();
  const seenTargets = new Set();
  for (const binding of bindings) {
    validateBinding(binding, operation, contract, seenSlots, seenTargets);
  }
  for (const [slot, rule] of Object.entries(contract.slots)) {
    if (!rule.optional && !seenSlots.has(slot)) throw new Error(`Protocol adapter slot is missing: ${operation}.${slot}`);
  }
}

function validateBinding(binding, operation, contract, seenSlots, seenTargets) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Protocol adapter binding must be an object for ${operation}`);
  }
  const allowedKeys = new Set(["slot", "to", "from", "value", "optional"]);
  for (const key of Object.keys(binding)) {
    if (!allowedKeys.has(key)) throw new Error(`Protocol adapter binding key is not allowed: ${key}`);
  }
  const slot = requiredString(binding.slot, `${operation}.binding.slot`);
  const rule = contract.slots[slot];
  if (!rule) throw new Error(`Protocol adapter slot is not allowed: ${operation}.${slot}`);
  if (seenSlots.has(slot)) throw new Error(`Duplicate protocol adapter slot: ${operation}.${slot}`);
  seenSlots.add(slot);
  const target = requiredString(binding.to, `${operation}.binding.to`);
  parseSafeJsonPointer(target);
  if (seenTargets.has(target)) throw new Error(`Duplicate protocol adapter target: ${target}`);
  seenTargets.add(target);
  const hasFrom = Object.hasOwn(binding, "from");
  const hasValue = Object.hasOwn(binding, "value");
  if (hasFrom === hasValue) throw new Error(`Binding ${target} must define exactly one of from or value`);
  if (rule.source !== undefined && binding.from !== rule.source) {
    throw new Error(`Protocol slot ${operation}.${slot} must use ${rule.source}`);
  }
  if (rule.value !== undefined && (!hasValue || binding.value !== rule.value)) {
    throw new Error(`Protocol slot ${operation}.${slot} must use its compiled constant`);
  }
  if (Boolean(binding.optional) !== Boolean(rule.optional)) {
    throw new Error(`Protocol slot ${operation}.${slot} optionality does not match the compiled contract`);
  }
}

function normalizeTask(task) {
  const messages = Array.isArray(task?.messages) ? task.messages : [];
  const currentMessageId = task?.current_message_id ?? task?.currentMessageId;
  const currentMessage = messages.find((item) => (item.message_id ?? item.messageId) === currentMessageId) || null;
  return {
    task_id: task?.task_id ?? task?.taskId,
    status: task?.status,
    requester_agent_id: task?.requester_agent_id ?? task?.requesterAgentId,
    target_agent_id: task?.target_agent_id ?? task?.targetAgentId,
    from_agent_id: task?.from_agent_id ?? task?.fromAgentId,
    to_agent_id: task?.to_agent_id ?? task?.toAgentId,
    current_message_id: currentMessageId,
    current_message_delivery_status: currentMessage?.delivery_status ?? currentMessage?.deliveryStatus,
    turn_sequence: task?.turn_sequence ?? task?.turnSequence,
    task_version: task?.task_version ?? task?.taskVersion,
    max_turns: Number(task?.max_turns ?? task?.maxTurns ?? 12)
  };
}

function readSource(sources, path) {
  return path.split(".").reduce((value, key) => {
    if (value === null || value === undefined || !Object.hasOwn(Object(value), key)) return undefined;
    return value[key];
  }, sources);
}

function setJsonPointer(root, pointer, value) {
  const parts = parseSafeJsonPointer(pointer);
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const nextKey = parts[index + 1];
    if (!Object.hasOwn(current, key)) current[key] = /^\d+$/.test(nextKey) ? [] : Object.create(null);
    if (current[key] === null || typeof current[key] !== "object") {
      throw new Error(`Protocol target crosses a scalar value: ${pointer}`);
    }
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

function parseSafeJsonPointer(pointer) {
  if (!pointer.startsWith("/") || pointer.length > MAX_POINTER_LENGTH) {
    throw new Error(`Invalid JSON Pointer target: ${pointer}`);
  }
  const rawParts = pointer.split("/").slice(1);
  if (!rawParts.length || rawParts.length > MAX_POINTER_DEPTH) throw new Error(`Invalid JSON Pointer target: ${pointer}`);
  const parts = rawParts.map((value) => {
    if (/~(?![01])/u.test(value)) throw new Error(`Invalid JSON Pointer escape: ${pointer}`);
    const decoded = value.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!decoded || DANGEROUS_PROPERTY_NAMES.has(decoded)) throw new Error(`Unsafe JSON Pointer target: ${pointer}`);
    return decoded;
  });
  return parts;
}

function protocolPointer(value) {
  return compact({
    version: value.version,
    semver: value.semver,
    bundle_revision: value.bundle_revision,
    bundle_digest: value.bundle_digest
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizedAuthorityOrigin(value) {
  const parsed = new URL(requiredString(value, "authority.origin"));
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function assertUrlWithinBase(candidate, base, label) {
  const candidateUrl = new URL(candidate);
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (candidateUrl.origin !== baseUrl.origin
    || (candidateUrl.pathname !== basePath && !candidateUrl.pathname.startsWith(`${basePath}/`))) {
    throw new Error(`${label} must use the configured Relay authority path`);
  }
}

function assertAuthorityMatchesBase(authorityOrigin, base) {
  const authority = new URL(authorityOrigin);
  const baseUrl = new URL(base);
  const authorityPath = authority.pathname.replace(/\/+$/, "");
  if (authority.origin !== baseUrl.origin
    || (baseUrl.pathname !== authorityPath && !baseUrl.pathname.startsWith(`${authorityPath}/`))) {
    throw new Error("Protocol authority must contain the configured Relay API path");
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
  return value.trim();
}

function requiresAdapterContract(expectedTarget, manifest) {
  return (expectedTarget?.required_client_capabilities || manifest.required_client_capabilities || [])
    .includes(ADAPTER_ENGINE);
}

function validateBundleWindow(value, field) {
  const publishedAt = requiredTimestamp(value.published_at, `${field}.published_at`);
  const expiresAt = requiredTimestamp(value.expires_at, `${field}.expires_at`);
  const now = Date.now();
  if (publishedAt > now) throw new Error(`${field}.published_at cannot be in the future`);
  if (expiresAt <= now) throw new Error(`${field}.expires_at has expired`);
  if (expiresAt <= publishedAt) throw new Error(`${field}.expires_at must be after published_at`);
}

function requiredTimestamp(value, field) {
  requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${field} must be a valid date-time`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid date-time`);
  return timestamp;
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value || {})) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function operationContract(method, path, requestSchema, slots) {
  return { method, path, requestSchema, slots };
}

function trustedSource(source, optional = false) {
  return { source, optional };
}

function fixedValue(value, optional = false) {
  return { value, optional };
}

function validateSemanticInput(operation, input, identity, task, runtime) {
  requiredString(identity?.agent_id, "identity.agent_id");
  requiredString(runtime?.idempotency_key, "runtime.idempotency_key");
  if (operation === "create_task" || operation === "create_followup") {
    requiredString(input.requestText, "input.requestText");
    requiredString(input.doneCriteria, "input.doneCriteria");
  }
  if (operation === "create_task") requiredString(input.targetAgentId, "input.targetAgentId");
  if (operation === "reply") requiredString(input.text, "input.text");
  if (operation === "fail_task" && !new Set(["agent_reported_failure", "max_turns_exhausted"]).has(input.reason)) {
    throw new Error(`Unsupported local failure reason: ${input.reason}`);
  }
  if (operation !== "create_task") {
    const normalized = normalizeTask(task);
    requiredString(normalized.task_id, "task.task_id");
    requiredString(normalized.current_message_id, "task.current_message_id");
    if (!Number.isInteger(normalized.turn_sequence) || normalized.turn_sequence < 1) throw new Error("Invalid task.turn_sequence");
    if (!Number.isInteger(normalized.task_version) || normalized.task_version < 1) throw new Error("Invalid task.task_version");
  }
}

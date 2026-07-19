import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export const PROTOCOL_RUNTIME_VERSION = "0.2.0";
export const PROTOCOL_RUNTIME_CAPABILITIES = [
  "dynamic_protocol_bundle_v0.1",
  "semantic_protocol_adapter_v1"
];
export const SUPPORTED_PROTOCOL_VERSIONS = ["agent-collab-v0.5"];

const ALLOWED_OPERATIONS = {
  create_task: { method: "POST", path: "/tasks" },
  reply: { method: "POST", path: "/tasks/{task_id}/messages" },
  complete_task: { method: "POST", path: "/tasks/{task_id}/complete" },
  fail_task: { method: "POST", path: "/tasks/{task_id}/fail" },
  create_followup: { method: "POST", path: "/tasks/{task_id}/followups" }
};

const TRUSTED_PROTECTED_BINDINGS = {
  "/actor_agent_id": "identity.agent_id",
  "/requester_agent_id": "identity.agent_id",
  "/target_agent_id": "input.targetAgentId",
  "/idempotency_key": "runtime.idempotency_key"
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
  if (baseUrl) assertSameOrigin(target.bundle_url, baseUrl, "negotiated bundle URL");
  assertSameOrigin(target.bundle_url, authority.origin, "protocol authority");
  return value;
}

export function validateProtocolBundle(bundle, { expectedTarget, authority, baseUrl } = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Protocol bundle must be an object");
  }
  const manifest = bundle.manifest || {};
  const content = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "manifest"));
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
  const manifestAuthority = manifest.authority || authority;
  if (!manifestAuthority) throw new Error("Protocol bundle authority is missing");
  if (authority && (manifestAuthority.id !== authority.id
    || normalizedAuthorityOrigin(manifestAuthority.origin) !== normalizedAuthorityOrigin(authority.origin))) {
    throw new Error("Protocol bundle authority does not match negotiation authority");
  }
  if (baseUrl) assertSameOrigin(manifestAuthority.origin, baseUrl, "protocol authority");
  const requiresAdapter = (expectedTarget?.required_client_capabilities || manifest.required_client_capabilities || [])
    .includes("semantic_protocol_adapter_v1");
  if (requiresAdapter || bundle.adapters) validateAdapterDefinition(bundle.adapters);
  createBundleValidator(bundle);
  return {
    protocol: requiredString(manifest.protocol, "manifest.protocol"),
    version: requiredString(manifest.version, "manifest.version"),
    semver: requiredString(manifest.semver, "manifest.semver"),
    bundle_revision: manifest.bundle_revision,
    schema_digest: requiredString(manifest.schema_digest, "manifest.schema_digest"),
    bundle_digest: digest,
    authority: manifestAuthority,
    bundle
  };
}

export function validateAdapterDefinition(adapters) {
  if (!adapters || adapters.engine !== "semantic_protocol_adapter_v1") {
    throw new Error("Protocol bundle requires the semantic_protocol_adapter_v1 engine");
  }
  const operations = adapters.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
    throw new Error("Protocol adapters.operations must be an object");
  }
  for (const [operation, definition] of Object.entries(operations)) {
    const allowed = ALLOWED_OPERATIONS[operation];
    if (!allowed) throw new Error(`Protocol adapter operation is not allowed: ${operation}`);
    if (definition.method !== allowed.method || definition.path !== allowed.path) {
      throw new Error(`Protocol adapter route is not allowed for ${operation}`);
    }
    requiredString(definition.request_schema, `${operation}.request_schema`);
    if (!Array.isArray(definition.bindings) || definition.bindings.length === 0) {
      throw new Error(`Protocol adapter bindings are missing for ${operation}`);
    }
    for (const binding of definition.bindings) validateBinding(binding, operation);
  }
  return adapters;
}

export function buildSemanticRequest({ bundle, operation, input = {}, identity = {}, task = {}, runtime = {} }) {
  validateAdapterDefinition(bundle?.adapters);
  const definition = bundle.adapters.operations[operation];
  if (!definition) throw new Error(`Protocol bundle does not define operation ${operation}`);
  const sources = { input, identity, task: normalizeTask(task), runtime };
  const payload = {};
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

function validateBinding(binding, operation) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Protocol adapter binding must be an object for ${operation}`);
  }
  const allowedKeys = new Set(["to", "from", "value", "optional"]);
  for (const key of Object.keys(binding)) {
    if (!allowedKeys.has(key)) throw new Error(`Protocol adapter binding key is not allowed: ${key}`);
  }
  const target = requiredString(binding.to, `${operation}.binding.to`);
  if (!target.startsWith("/") || target.includes("..")) throw new Error(`Invalid JSON Pointer target: ${target}`);
  const hasFrom = Object.hasOwn(binding, "from");
  const hasValue = Object.hasOwn(binding, "value");
  if (hasFrom === hasValue) throw new Error(`Binding ${target} must define exactly one of from or value`);
  if (hasFrom) {
    const source = requiredString(binding.from, `${operation}.binding.from`);
    if (!/^(input|identity|task|runtime)\.[A-Za-z0-9_.]+$/.test(source)) {
      throw new Error(`Protocol binding source is not allowed: ${source}`);
    }
  }
  if (TRUSTED_PROTECTED_BINDINGS[target] && binding.from !== TRUSTED_PROTECTED_BINDINGS[target]) {
    throw new Error(`Protected protocol target ${target} must use ${TRUSTED_PROTECTED_BINDINGS[target]}`);
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
  return path.split(".").reduce((value, key) => value?.[key], sources);
}

function setJsonPointer(root, pointer, value) {
  const parts = pointer.split("/").slice(1).map(unescapePointer);
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const nextKey = parts[index + 1];
    if (current[key] === undefined) current[key] = /^\d+$/.test(nextKey) ? [] : {};
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

function unescapePointer(value) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
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

function assertSameOrigin(left, right, label) {
  if (new URL(left).origin !== new URL(right).origin) {
    throw new Error(`${label} must use the configured Relay origin`);
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
  return value.trim();
}

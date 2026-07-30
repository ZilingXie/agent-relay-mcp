import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  negotiateCurrentProtocol,
  readCachedVerifiedProtocol
} from "./protocol-sync.mjs";
import {
  buildSemanticRequest,
  PROTOCOL_RUNTIME_CAPABILITIES,
  PROTOCOL_RUNTIME_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateProtocolBundle,
  validateSemanticTransition
} from "./protocol-runtime.mjs";

export const DETERMINISTIC_SEMANTIC_RETRY_CAPABILITY = "deterministic_semantic_retry_v1";

export async function executeSemanticCreate({
  input,
  identity,
  idempotencyKey,
  baseUrl,
  headers = {},
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR,
  fetchImpl = fetch,
  log = null,
  onProtocolActivated
}) {
  const semanticInput = normalizeCreateSemanticInput(input);
  let request = await buildCurrentCreateRequest({
    input: semanticInput,
    identity,
    idempotencyKey,
    baseUrl,
    headers,
    cacheRoot,
    fetchImpl,
    log,
    onProtocolActivated
  });
  try {
    return await sendSemanticRequest({ request, baseUrl, headers, fetchImpl });
  } catch (error) {
    if (error.statusCode !== 426 || error.code !== "protocol_patch_required") throw error;
    assertAutomaticCreateRetryAllowed(error.responseData);
    const originalIdempotencyKey = request.payload.idempotency_key;
    request = await buildCurrentCreateRequest({
      input: semanticInput,
      identity,
      idempotencyKey,
      baseUrl,
      headers,
      cacheRoot,
      fetchImpl,
      log,
      onProtocolActivated
    });
    if (request.payload.idempotency_key !== originalIdempotencyKey) {
      throw new Error("Protocol create retry changed the original idempotency_key");
    }
    return sendSemanticRequest({ request, baseUrl, headers, fetchImpl });
  }
}

function normalizeCreateSemanticInput(input) {
  const normalized = structuredClone(input || {});
  const message = normalized.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const messageSubject = String(message.subject || "").trim();
    const subject = String(normalized.subject || "").trim();
    if (subject && messageSubject && subject !== messageSubject) {
      throw new Error("Semantic create subject conflicts with message.subject");
    }
    if (!subject && messageSubject) normalized.subject = messageSubject;

    const parts = Array.isArray(message.parts) ? message.parts : [];
    const messageText = parts.length === 1 && parts[0]?.kind === "text"
      ? String(parts[0].text || "").trim()
      : "";
    const requestText = String(normalized.requestText || "").trim();
    if (requestText && messageText && requestText !== messageText) {
      throw new Error("Semantic create requestText conflicts with the single text Message part");
    }
    if (!requestText && messageText) normalized.requestText = messageText;
  }
  if (!normalized.message && normalized.subject && normalized.requestText) {
    normalized.message = {
      subject: normalized.subject,
      parts: [{ kind: "text", text: normalized.requestText }]
    };
  }
  return normalized;
}

async function buildCurrentCreateRequest(options) {
  const bundle = await loadCurrentSemanticBundle(options);
  validateSemanticTransition("create_task", {}, options.identity?.agent_id, options.input);
  return {
    ...buildSemanticRequest({
      bundle,
      operation: "create_task",
      input: options.input,
      identity: options.identity,
      runtime: { idempotency_key: options.idempotencyKey }
    }),
    protocolVersion: bundle.manifest.version,
    bundleRevision: bundle.manifest.bundle_revision,
    bundleDigest: bundle.manifest.bundle_digest,
    adapterContractVersion: bundle.manifest.adapter_contract_version
  };
}

async function loadCurrentSemanticBundle({
  baseUrl,
  headers,
  cacheRoot,
  fetchImpl,
  log,
  onProtocolActivated
}) {
  let result;
  try {
    result = await negotiateCurrentProtocol({ baseUrl, headers, cacheRoot, fetchImpl, log });
  } catch (error) {
    const cached = await readCachedVerifiedProtocol({ baseUrl, cacheRoot });
    if (!cached) throw error;
    result = { status: "offline_cached_bundle", active: cached, last_error: String(error?.message || error) };
  }
  if (result.status === "client_release_required") {
    throw protocolError("CLIENT_RELEASE_REQUIRED", "The Relay current protocol requires a newer AgentRelay client runtime", result);
  }
  const active = result.active;
  if (!active?.cache_dir) {
    throw protocolError("PROTOCOL_BUNDLE_UNAVAILABLE", "No verified bundle is available for the Relay current protocol", result);
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(active.version)) {
    throw protocolError("CLIENT_RELEASE_REQUIRED", `Protocol ${active.version} is outside this client's compiled protocol range`, result);
  }
  const bundle = JSON.parse(await readFile(active.bundle_path || resolve(active.cache_dir, "bundle.json"), "utf8"));
  validateProtocolBundle(bundle, { expectedTarget: active, authority: active.authority, baseUrl });
  if (bundle.adapters?.engine !== "semantic_protocol_adapter_v2") {
    throw new Error("The active protocol bundle does not provide the semantic protocol adapter");
  }
  await onProtocolActivated?.(active, result);
  return bundle;
}

async function sendSemanticRequest({ request, baseUrl, headers, fetchImpl }) {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}${request.path}`, {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      "X-AgentRelay-Task-Protocol": request.protocolVersion,
      "X-AgentRelay-Bundle-Revision": String(request.bundleRevision),
      "X-AgentRelay-Bundle-Digest": request.bundleDigest,
      "X-AgentRelay-Adapter-Contract": String(request.adapterContractVersion),
      "X-AgentRelay-Runtime-Version": PROTOCOL_RUNTIME_VERSION,
      "X-AgentRelay-Runtime-Capabilities": PROTOCOL_RUNTIME_CAPABILITIES.join(",")
    },
    body: JSON.stringify(request.payload)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`AgentRelay returned non-JSON response (${response.status}): ${text}`);
  }
  if (response.ok) return data;
  const error = new Error(`AgentRelay ${request.method} ${request.path} failed (${response.status}): ${JSON.stringify(data)}`);
  error.statusCode = response.status;
  error.code = data?.error?.code || data?.code || "";
  error.responseData = data;
  throw error;
}

function assertAutomaticCreateRetryAllowed(responseData) {
  const detail = responseData?.error?.detail || {};
  if (!detail.redraft_policy?.safe_to_auto_redraft?.includes("task_create")) {
    throw new Error("Relay did not authorize deterministic task_create reconstruction");
  }
  if (detail.retry_policy?.max_automatic_retries < 1 || detail.retry_policy?.preserve_idempotency_key !== true) {
    throw new Error("Relay protocol retry policy does not allow one idempotent automatic retry");
  }
  const required = detail.upgrade?.required_client_capabilities || [];
  if (!required.includes(DETERMINISTIC_SEMANTIC_RETRY_CAPABILITY)) {
    throw new Error("Relay protocol response did not require deterministic semantic retry capability");
  }
}

function protocolError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

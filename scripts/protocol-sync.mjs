#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  buildNegotiationRequest,
  protocolAuthorityRoot,
  readActiveProtocol,
  validateNegotiationResponse,
  validateProtocolBundle
} from "./protocol-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
loadDotEnv(process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));

export const LOCAL_PROTOCOL_VERSION = "agent-collab-v0.3";
export const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
export const DEFAULT_PROTOCOL_CACHE_ROOT = "~/.agentrelay/protocols";

if (isMainModule()) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export async function syncCurrentProtocol({
  baseUrl = process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  fetchImpl = fetch,
  log = console.error,
  headers = {}
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const manifest = await fetchJson(fetchImpl, `${normalizedBaseUrl}/protocols/current`, headers);
  const bundleUrl = manifest?.urls?.bundle;
  if (!bundleUrl) {
    throw new Error(`Protocol manifest did not include urls.bundle: ${JSON.stringify(manifest)}`);
  }
  return syncProtocolBundle({
    bundleUrl,
    cacheRoot,
    fetchImpl,
    log,
    baseUrl: normalizedBaseUrl,
    authority: manifest.authority,
    expectedTarget: manifestTarget(manifest),
    headers
  });
}

export async function syncProtocolVersion({
  version,
  baseUrl = process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  fetchImpl = fetch,
  log = console.error,
  headers = {}
} = {}) {
  const match = /^agent-collab-(v\d+\.\d+)$/.exec(String(version || ""));
  if (!match) throw new Error("version must look like agent-collab-v0.4");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const manifest = await fetchJson(fetchImpl, `${normalizedBaseUrl}/protocols/agent-collab/${match[1]}/manifest`, headers);
  const bundleUrl = manifest?.urls?.bundle;
  if (!bundleUrl) throw new Error(`Protocol manifest did not include urls.bundle: ${JSON.stringify(manifest)}`);
  return syncProtocolBundle({
    bundleUrl,
    cacheRoot,
    fetchImpl,
    log,
    baseUrl: normalizedBaseUrl,
    authority: manifest.authority,
    expectedTarget: manifestTarget(manifest),
    headers
  });
}

export async function negotiateCurrentProtocol({
  baseUrl = process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  fetchImpl = fetch,
  headers = {},
  log = console.error,
  timeoutMs = 5000
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const manifest = await fetchJson(
    fetchImpl,
    `${normalizedBaseUrl}/protocols/current`,
    headers,
    AbortSignal.timeout(timeoutMs)
  );
  if (!manifest.authority) throw new Error("Current protocol manifest did not include authority");
  const active = await readActiveProtocol({ cacheRoot: resolveHome(cacheRoot), authority: manifest.authority });
  const negotiation = validateNegotiationResponse(
    await postJson(
      fetchImpl,
      `${normalizedBaseUrl}/protocols/negotiate`,
      buildNegotiationRequest({ active }),
      headers,
      AbortSignal.timeout(timeoutMs)
    ),
    { baseUrl: normalizedBaseUrl }
  );
  if (negotiation.action === "client_release_required") {
    return { status: "client_release_required", negotiation, active };
  }
  if (negotiation.action === "up_to_date") {
    return { status: "up_to_date", negotiation, active };
  }
  const synced = await syncProtocolBundle({
    bundleUrl: negotiation.target.bundle_url,
    cacheRoot,
    fetchImpl,
    log,
    baseUrl: normalizedBaseUrl,
    authority: negotiation.authority,
    expectedTarget: negotiation.target,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { status: negotiation.action === "hot_rollback" ? "hot_rollback_applied" : "hot_patch_applied", negotiation, active: synced };
}

export async function syncProtocolBundle({
  bundleUrl,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  fetchImpl = fetch,
  log = console.error,
  baseUrl,
  authority,
  expectedTarget,
  headers = {},
  signal
}) {
  if (!bundleUrl) throw new Error("syncProtocolBundle requires bundleUrl");
  const bundle = await fetchJson(fetchImpl, bundleUrl, headers, signal);
  const verified = validateProtocolBundle(bundle, { expectedTarget, authority, baseUrl });
  const authorityRoot = protocolAuthorityRoot(resolveHome(cacheRoot), verified.authority);
  const dir = resolveProtocolDir(
    cacheRoot,
    verified.protocol,
    verified.version,
    verified.authority,
    verified.bundle_digest
  );
  await withActivationLock(authorityRoot, async () => {
    if (!existsSync(dir)) {
      const staging = resolve(authorityRoot, `.staging-${randomUUID()}`);
      try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        await writeJson(resolve(staging, "manifest.json"), bundle.manifest);
        await writeJson(resolve(staging, "bundle.json"), bundle);
        await writeNamedFiles(resolve(staging, "schemas"), bundle.schemas || {}, ".json");
        await writeNamedFiles(resolve(staging, "examples"), bundle.examples || {}, ".json");
        await writeNamedTextFiles(resolve(staging, "docs"), bundle.docs || {});
        await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
        await rename(staging, dir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const pointer = {
      protocol: verified.protocol,
      version: verified.version,
      semver: verified.semver,
      bundle_revision: verified.bundle_revision,
      schema_digest: verified.schema_digest,
      bundle_digest: verified.bundle_digest,
      authority: verified.authority,
      cache_dir: dir,
      activated_at: new Date().toISOString()
    };
    const previous = await readActiveProtocol({ cacheRoot: resolveHome(cacheRoot), authority: verified.authority });
    if (previous && previous.bundle_digest !== pointer.bundle_digest) {
      await writeJsonAtomic(resolve(authorityRoot, "last-known-good.json"), previous);
    }
    await writeJsonAtomic(resolve(authorityRoot, "active.json"), pointer);
  });
  log?.(`AgentRelay protocol bundle activated: ${verified.protocol} ${verified.version} ${verified.bundle_digest} -> ${dir}`);
  return {
    protocol: verified.protocol,
    version: verified.version,
    semver: verified.semver,
    bundle_revision: verified.bundle_revision,
    schema_digest: verified.schema_digest,
    bundle_digest: verified.bundle_digest,
    authority: verified.authority,
    cache_dir: dir,
    manifest_path: resolve(dir, "manifest.json"),
    bundle_path: resolve(dir, "bundle.json"),
  };
}

export async function maybeHandleProtocolNegotiation({
  responseData,
  method,
  path,
  payload,
  retryRequest,
  baseUrl = process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = fetch,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  log = console.error,
  headers = {}
}) {
  const error = responseData?.error;
  if (!error || error.type !== "protocol_negotiation") return null;
  const detail = error.detail || {};
  const bundleUrl = detail.upgrade?.bundle_url;
  if (error.code === "protocol_patch_required") {
    let synced = null;
    let syncError = null;
    try {
      synced = await syncProtocolBundle({ bundleUrl, cacheRoot, fetchImpl, log, baseUrl, headers });
    } catch (error_) {
      syncError = error_.message;
    }
    const operation = inferProtocolOperation(method, path);
    const repairedPayload = synced
      ? buildAutoRedraftedPayload({
          payload,
          targetProtocolVersion: synced.version,
          operation,
          redraftPolicy: detail.redraft_policy
        })
      : null;
    if (repairedPayload && typeof retryRequest === "function") {
      try {
        return await retryRequest(repairedPayload, {
          operation,
          originalPayload: payload,
          synced
        });
      } catch (error_) {
        return buildProtocolRecoveryResult({
          error,
          detail,
          method,
          path,
          payload,
          synced,
          syncError,
          status: "auto_protocol_retry_failed",
          nextAction: `Synced the protocol bundle and auto-redrafted ${operation}, but the retry failed: ${error_.message}. Review the original request and retry manually.`,
          retryError: error_.message,
          redraftedPayload: repairedPayload
        });
      }
    }
    return {
      ok: false,
      error,
      protocol_recovery: {
        status: synced ? "protocol_bundle_synced" : "protocol_bundle_sync_failed",
        local_protocol_version: LOCAL_PROTOCOL_VERSION,
        server_protocol: detail.server_protocol || null,
        synced,
        sync_error: syncError,
        original_request: {
          method,
          path,
          payload,
        },
        next_action: synced
          ? nextProtocolRecoveryAction({ operation, repairedPayload, retryRequest })
          : "Unable to fetch the protocol bundle. Retry later or upgrade AgentRelay MCP with: npx github:ZilingXie/agent-relay-mcp install",
      },
    };
  }
  if (error.code === "client_upgrade_required") {
    return {
      ok: false,
      error,
      protocol_recovery: {
        status: "client_upgrade_required",
        local_protocol_version: LOCAL_PROTOCOL_VERSION,
        server_protocol: detail.server_protocol || null,
        next_action: "Upgrade AgentRelay MCP with: npx github:ZilingXie/agent-relay-mcp install. This protocol change may require new client code, tools, endpoints, or workflow semantics.",
      },
    };
  }
  return null;
}

export function inferProtocolOperation(method, path) {
  const normalizedMethod = String(method || "").toUpperCase();
  const normalizedPath = String(path || "");
  if (normalizedMethod === "POST" && normalizedPath === "/tasks") return "task_create";
  if (normalizedMethod === "POST" && /^\/tasks\/[^/]+\/artifacts$/.test(normalizedPath)) return "artifact_submit";
  if (normalizedMethod === "POST" && /^\/tasks\/[^/]+\/amend$/.test(normalizedPath)) return "task_amend";
  if (normalizedMethod === "POST" && /^\/tasks\/[^/]+\/close$/.test(normalizedPath)) return "task_close";
  return `${normalizedMethod} ${normalizedPath}`.trim();
}

export function buildAutoRedraftedPayload({
  payload,
  targetProtocolVersion,
  operation,
  redraftPolicy
}) {
  if (!isPlainObject(payload) || !targetProtocolVersion) return null;
  const safeOperations = redraftPolicy?.safe_to_auto_redraft;
  if (!Array.isArray(safeOperations) || !safeOperations.includes(operation)) return null;
  if (payload.protocol_version === targetProtocolVersion) return null;
  return {
    ...payload,
    protocol_version: targetProtocolVersion
  };
}

function buildProtocolRecoveryResult({
  error,
  detail,
  method,
  path,
  payload,
  synced,
  syncError,
  status,
  nextAction,
  retryError,
  redraftedPayload
}) {
  return {
    ok: false,
    error,
    protocol_recovery: {
      status,
      local_protocol_version: LOCAL_PROTOCOL_VERSION,
      server_protocol: detail.server_protocol || null,
      synced,
      sync_error: syncError,
      retry_error: retryError,
      redrafted_payload: redraftedPayload,
      original_request: {
        method,
        path,
        payload,
      },
      next_action: nextAction,
    },
  };
}

function nextProtocolRecoveryAction({ operation, repairedPayload, retryRequest }) {
  if (repairedPayload && typeof retryRequest !== "function") {
    return `Auto-redraft is available for ${operation}, but this caller did not provide an automatic retry hook. Retry with the redrafted protocol_version and preserve idempotency.`;
  }
  if (!repairedPayload) {
    return "Ask the local agent to redraft the original payload using the synced protocol bundle without changing user intent, then retry with idempotency protection.";
  }
  return "Synced the protocol bundle. Retry with the redrafted payload and preserve idempotency.";
}

export function resolveProtocolDir(cacheRoot, protocol, version, authority, bundleDigest) {
  if (!authority || !bundleDigest) return resolve(resolveHome(cacheRoot), protocol, version);
  return resolve(
    protocolAuthorityRoot(resolveHome(cacheRoot), authority),
    protocol,
    version,
    bundleDigest.replace(":", "-")
  );
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncCurrentProtocol({
    baseUrl: args["base-url"] || process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
    cacheRoot: args["cache-dir"] || process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  });
  console.log(JSON.stringify({ ok: true, protocol: result }, null, 2));
}

async function fetchJson(fetchImpl, url, headers = {}, signal) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Protocol endpoint returned non-JSON (${response.status}): ${text}`);
  }
  if (!response.ok) {
    throw new Error(`Protocol endpoint failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function postJson(fetchImpl, url, payload, headers = {}, signal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Protocol negotiation returned non-JSON (${response.status}): ${text}`);
  }
  if (!response.ok) throw new Error(`Protocol negotiation failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
}

async function withActivationLock(authorityRoot, operation) {
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 });
  const lockPath = resolve(authorityRoot, ".activation.lock");
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`Unable to acquire protocol activation lock: ${error.message}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function manifestTarget(manifest) {
  return {
    version: manifest.version,
    semver: manifest.semver,
    bundle_revision: manifest.bundle_revision,
    schema_digest: manifest.schema_digest,
    bundle_digest: manifest.bundle_digest,
    required_client_capabilities: manifest.required_client_capabilities || []
  };
}

async function writeNamedFiles(dir, values, suffix) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(values)) {
    if (!safeFileName(name) || !name.endsWith(suffix)) continue;
    await writeJson(resolve(dir, name), value);
  }
}

async function writeNamedTextFiles(dir, values) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(values)) {
    if (!safeFileName(name) || typeof value !== "string") continue;
    await writeFile(resolve(dir, name), value, { mode: 0o600 });
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--help" || entry === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!entry.startsWith("--")) throw new Error(`Unexpected argument: ${entry}`);
    const [rawKey, inlineValue] = entry.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    parsed[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/protocol-sync.mjs [--base-url URL] [--cache-dir PATH]

Fetches the current AgentRelay protocol manifest and bundle, then caches schemas,
examples, docs, manifest.json, and bundle.json under ~/.agentrelay/protocols.`);
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

function safeFileName(name) {
  return typeof name === "string" && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

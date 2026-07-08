#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
  log = console.error
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const manifest = await fetchJson(fetchImpl, `${normalizedBaseUrl}/protocols/current`);
  const bundleUrl = manifest?.urls?.bundle;
  if (!bundleUrl) {
    throw new Error(`Protocol manifest did not include urls.bundle: ${JSON.stringify(manifest)}`);
  }
  return syncProtocolBundle({ bundleUrl, cacheRoot, fetchImpl, log });
}

export async function syncProtocolBundle({
  bundleUrl,
  cacheRoot = process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  fetchImpl = fetch,
  log = console.error
}) {
  if (!bundleUrl) throw new Error("syncProtocolBundle requires bundleUrl");
  const bundle = await fetchJson(fetchImpl, bundleUrl);
  const manifest = bundle.manifest || {};
  const protocol = requiredString(manifest.protocol, "manifest.protocol");
  const version = requiredString(manifest.version, "manifest.version");
  const digest = requiredString(manifest.schema_digest, "manifest.schema_digest");
  const dir = resolveProtocolDir(cacheRoot, protocol, version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJson(resolve(dir, "manifest.json"), manifest);
  await writeJson(resolve(dir, "bundle.json"), bundle);
  await writeJson(resolve(resolveHome(cacheRoot), "latest.json"), {
    protocol,
    version,
    schema_digest: digest,
    cache_dir: dir,
    synced_at: new Date().toISOString(),
  });
  await writeNamedFiles(resolve(dir, "schemas"), bundle.schemas || {}, ".json");
  await writeNamedFiles(resolve(dir, "examples"), bundle.examples || {}, ".json");
  await writeNamedTextFiles(resolve(dir, "docs"), bundle.docs || {});
  log?.(`AgentRelay protocol bundle synced: ${protocol} ${version} ${digest} -> ${dir}`);
  return {
    protocol,
    version,
    schema_digest: digest,
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
  log = console.error
}) {
  const error = responseData?.error;
  if (!error || error.type !== "protocol_negotiation") return null;
  const detail = error.detail || {};
  const bundleUrl = detail.upgrade?.bundle_url;
  if (error.code === "protocol_patch_required") {
    let synced = null;
    let syncError = null;
    try {
      synced = await syncProtocolBundle({ bundleUrl, cacheRoot, fetchImpl, log });
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

export function resolveProtocolDir(cacheRoot, protocol, version) {
  return resolve(resolveHome(cacheRoot), protocol, version);
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncCurrentProtocol({
    baseUrl: args["base-url"] || process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL,
    cacheRoot: args["cache-dir"] || process.env.AGENTRELAY_PROTOCOL_CACHE_DIR || DEFAULT_PROTOCOL_CACHE_ROOT,
  });
  console.log(JSON.stringify({ ok: true, protocol: result }, null, 2));
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
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

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

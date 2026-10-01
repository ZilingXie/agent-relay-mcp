import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { protocolV2Bundle } from "./protocol-v2-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const REMOTE_DELAY_MS = 2500;
const CONNECT_BUDGET_MS = 2000;

test("initialize completes before a slow remote answers and hides dynamic tools", async (t) => {
  const relay = await startFakeRelay({ protocolDelayMs: REMOTE_DELAY_MS });
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-cold-"));
  let session;
  try {
    const startedAt = Date.now();
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const initializeMs = Date.now() - startedAt;
    t.diagnostic(`initialize with ${REMOTE_DELAY_MS}ms remote delay took ${initializeMs}ms`);
    assert.ok(initializeMs < CONNECT_BUDGET_MS, `initialize waited for the remote (${initializeMs}ms >= ${CONNECT_BUDGET_MS}ms)`);

    const tools = await session.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(!toolNames.includes("agentrelay_create_task"), "dynamic create tool must stay hidden before the first negotiation");
    assert.ok(toolNames.includes("agentrelay_protocol_status"), "static protocol status tool missing");
    assert.ok(toolNames.includes("agentrelay_prepare_local_action"), "static local action tool missing");
  } finally {
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified cache serves dynamic Agent tools before the remote answers", async (t) => {
  const relay = await startFakeRelay();
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-cache-"));
  let warmSession;
  let session;
  try {
    warmSession = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const warmed = await callJson(warmSession.client, "agentrelay_protocol_status", {});
    assert.equal(warmed.status, "hot_patch_applied", "warm-up negotiation did not cache a bundle");
    assert.equal(warmed.agent_tools.status, "active", "warm-up negotiation did not activate dynamic tools");
    await closeSession(warmSession);
    warmSession = null;

    relay.setBehavior({ protocolDelayMs: REMOTE_DELAY_MS });
    const startedAt = Date.now();
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const initializeMs = Date.now() - startedAt;
    t.diagnostic(`cached initialize with ${REMOTE_DELAY_MS}ms remote delay took ${initializeMs}ms`);
    assert.ok(initializeMs < CONNECT_BUDGET_MS, `cached initialize waited for the remote (${initializeMs}ms >= ${CONNECT_BUDGET_MS}ms)`);

    const tools = await session.client.listTools();
    const createTool = tools.tools.find((tool) => tool.name === "agentrelay_create_task");
    assert.ok(createTool, "cached dynamic create tool missing before the remote answered");
    assert.ok(createTool.inputSchema.required.includes("message"), "cached create tool did not use the verified dynamic schema");
    assert.ok(!createTool.inputSchema.properties.requester_agent_id, "cached create tool exposed legacy requester identity");
    assert.ok(!session.stderrText().includes("UnhandledPromiseRejection"), "server reported an unhandled rejection");
  } finally {
    await closeSession(warmSession);
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing remote with no cache keeps static tools and surfaces the failure", async (t) => {
  const relay = await startFakeRelay({ protocolFail: true });
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-fail-"));
  let session;
  try {
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const status = await callJson(session.client, "agentrelay_protocol_status", {});
    assert.equal(status.status, "protocol_check_failed", "failed negotiation was not reported");
    assert.equal(status.agent_tools.status, "unavailable", "dynamic tools must stay unavailable without a cache");
    assert.ok(status.last_error, "negotiation failure reason missing");

    const tools = await session.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(!toolNames.includes("agentrelay_create_task"), "dynamic create tool must stay hidden after a failed negotiation");
    assert.ok(toolNames.includes("agentrelay_protocol_status"), "static tools were disabled by a protocol failure");
    assert.ok(!session.stderrText().includes("UnhandledPromiseRejection"), "server reported an unhandled rejection");
  } finally {
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("background negotiation enables dynamic tools and emits tools/list_changed", async (t) => {
  const relay = await startFakeRelay();
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-background-"));
  let session;
  try {
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const status = await callJson(session.client, "agentrelay_protocol_status", {});
    assert.equal(status.agent_tools.status, "active", "background negotiation did not activate dynamic tools");
    await sleep(150);

    assert.ok(session.listChangedCount() >= 1, "no tools/list_changed notification after enabling dynamic tools");
    const tools = await session.client.listTools();
    const createTool = tools.tools.find((tool) => tool.name === "agentrelay_create_task");
    assert.ok(createTool, "dynamic create tool missing after background negotiation");
    assert.ok(createTool.inputSchema.required.includes("message"), "dynamic create tool did not use the negotiated schema");
  } finally {
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unchanged bundle does not emit tools/list_changed again", async (t) => {
  const relay = await startFakeRelay();
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-unchanged-"));
  let warmSession;
  let session;
  try {
    warmSession = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const warmed = await callJson(warmSession.client, "agentrelay_protocol_status", {});
    assert.equal(warmed.agent_tools.status, "active", "warm-up negotiation did not activate dynamic tools");
    await closeSession(warmSession);
    warmSession = null;

    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const status = await callJson(session.client, "agentrelay_protocol_status", {});
    assert.equal(status.status, "up_to_date", "second negotiation should find the cached bundle current");
    await sleep(300);

    assert.equal(session.listChangedCount(), 0, "unchanged bundle emitted tools/list_changed");
    const tools = await session.client.listTools();
    const createTool = tools.tools.find((tool) => tool.name === "agentrelay_create_task");
    assert.ok(createTool, "cached dynamic create tool missing");
    assert.ok(createTool.inputSchema.required.includes("message"), "cached create tool lost the dynamic schema");
  } finally {
    await closeSession(warmSession);
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("manual refresh joins the background in-flight negotiation", async (t) => {
  const relay = await startFakeRelay({ protocolDelayMs: 1500 });
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-inflight-"));
  let session;
  try {
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const joined = await callJson(session.client, "agentrelay_protocol_status", { refresh: true });
    assert.equal(joined.agent_tools.status, "active", "joined refresh did not activate dynamic tools");
    assert.equal(relay.hits.current, 1, `background and manual refresh issued ${relay.hits.current} manifest fetches`);
    assert.equal(relay.hits.negotiate, 1, `background and manual refresh issued ${relay.hits.negotiate} negotiations`);

    const refreshed = await callJson(session.client, "agentrelay_protocol_status", { refresh: true });
    assert.equal(refreshed.status, "up_to_date", "sequential manual refresh did not run");
    assert.equal(relay.hits.current, 2, "sequential manual refresh did not issue a new manifest fetch");
  } finally {
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed refresh preserves cached dynamic tools", async (t) => {
  const relay = await startFakeRelay();
  const root = await mkdtemp(join(tmpdir(), "agentrelay-startup-offline-"));
  let warmSession;
  let session;
  try {
    warmSession = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const warmed = await callJson(warmSession.client, "agentrelay_protocol_status", {});
    assert.equal(warmed.agent_tools.status, "active", "warm-up negotiation did not activate dynamic tools");
    await closeSession(warmSession);
    warmSession = null;

    relay.setBehavior({ protocolFail: true });
    session = await startMcpSession({ relayBaseUrl: relay.baseUrl, root });
    const before = await session.client.listTools();
    assert.ok(before.tools.some((tool) => tool.name === "agentrelay_create_task"), "cached dynamic tool missing before refresh");

    const status = await callJson(session.client, "agentrelay_protocol_status", {});
    assert.equal(status.status, "offline_cached_bundle", "failed negotiation did not fall back to the cache");
    assert.ok(status.last_error, "offline fallback lost the failure reason");
    assert.equal(status.agent_tools.status, "active", "offline fallback dropped the cached dynamic tools");

    const after = await session.client.listTools();
    assert.ok(after.tools.some((tool) => tool.name === "agentrelay_create_task"), "failed refresh cleared the cached dynamic tools");
    assert.ok(!session.stderrText().includes("UnhandledPromiseRejection"), "server reported an unhandled rejection");
  } finally {
    await closeSession(warmSession);
    await closeSession(session);
    await closeRelay(relay);
    await rm(root, { recursive: true, force: true });
  }
});

function startFakeRelay(initialBehavior = {}) {
  const behavior = { protocolDelayMs: 0, protocolFail: false, ...initialBehavior };
  const hits = { current: 0, negotiate: 0, bundle: 0 };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const payload = await readJson(request);
    if (!path.startsWith("/agentrelay/protocols/")) {
      return sendJson(response, { ok: true }, 200);
    }
    if (behavior.protocolDelayMs > 0) await sleep(behavior.protocolDelayMs);
    if (behavior.protocolFail) return sendJson(response, { error: "protocol endpoint unavailable" }, 500);

    const bundle = protocolV2Bundle({ origin: `http://${request.headers.host}/agentrelay` });
    bundle.manifest.urls.bundle = `http://${request.headers.host}/agentrelay/protocols/agent-collab/v0.5/bundle`;
    const manifest = bundle.manifest;
    if (request.method === "GET" && path === "/agentrelay/protocols/current") {
      hits.current += 1;
      return sendJson(response, manifest);
    }
    if (request.method === "GET" && path === "/agentrelay/protocols/agent-collab/v0.5/bundle") {
      hits.bundle += 1;
      return sendJson(response, bundle);
    }
    if (request.method === "POST" && path === "/agentrelay/protocols/negotiate") {
      hits.negotiate += 1;
      const current = payload.active?.bundle_digest === manifest.bundle_digest;
      return sendJson(response, {
        action: current ? "up_to_date" : "hot_patch",
        reason: current ? "current" : "sync required",
        runtime_version: payload.runtime_version,
        missing_capabilities: [],
        authority: manifest.authority,
        target: {
          protocol: manifest.protocol,
          version: manifest.version,
          semver: manifest.semver,
          bundle_revision: manifest.bundle_revision,
          schema_digest: manifest.schema_digest,
          bundle_digest: manifest.bundle_digest,
          bundle_url: manifest.urls.bundle,
          adapter_contract_version: manifest.adapter_contract_version,
          published_at: manifest.published_at,
          expires_at: manifest.expires_at,
          required_client_capabilities: manifest.required_client_capabilities
        },
        retry_policy: { max_automatic_retries: 1, preserve_idempotency_key: true }
      });
    }
    sendJson(response, { error: `not found: ${request.method} ${path}` }, 404);
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListen({
        server,
        hits,
        baseUrl: `http://127.0.0.1:${port}/agentrelay`,
        setBehavior: (next) => Object.assign(behavior, next),
        close: () => new Promise((resolveClose) => server.close(resolveClose))
      });
    });
  });
}

async function startMcpSession({ relayBaseUrl, root }) {
  const client = new Client({ name: "agentrelay-mcp-startup-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp/server.mjs"],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: relayBaseUrl,
      AGENTRELAY_AGENT_ID: "startup-test-agent",
      AGENTRELAY_AGENT_ROLE: "personal_agent",
      AGENTRELAY_TOKEN: "startup-test-token",
      AGENTRELAY_STATE_DIR: join(root, "state"),
      AGENTRELAY_PROTOCOL_CACHE_DIR: join(root, "protocol-cache"),
      AGENTRELAY_PROTOCOL_VERSION: "",
      AGENTRELAY_COORDINATOR_TOOLS_ENABLED: "",
      AGENTRELAY_EXPOSE_LEGACY_PROTOCOL_TOOLS: ""
    },
    stderr: "pipe"
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
  const listChanged = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged.push(true);
  });
  await client.connect(transport);
  return {
    client,
    transport,
    stderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
    listChangedCount: () => listChanged.length
  };
}

async function closeSession(session) {
  if (!session) return;
  await session.transport.close().catch(() => {});
  await session.client.close().catch(() => {});
}

async function closeRelay(relay) {
  if (relay) await relay.close();
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} did not return text content`);
  }
  return JSON.parse(first.text);
}

async function readJson(request) {
  if (request.method === "GET") return {};
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

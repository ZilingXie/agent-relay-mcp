import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { approveLocalAction } from "../scripts/agentrelay-task-workspace.mjs";
import { protocolV2Bundle, resignProtocolV2Bundle } from "./protocol-v2-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP stable create tool uses the verified v0.6 semantic bundle", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-v06-"));
  let createPayload;
  let legacyReplyPayload = null;
  let legacyReplyHeaders;
  const seenRequests = [];
  const legacyTask = {
    task_id: "task_mcp_v05_drain",
    root_task_id: "task_mcp_v05_drain",
    protocol_version: "agent-collab-v0.5",
    requester_agent_id: "vivi-agent",
    target_agent_id: "zac-agent",
    status: "open",
    current_message_id: "msg_mcp_v05_drain",
    turn_sequence: 1,
    task_version: 2,
    max_turns: 12,
    from_agent_id: "vivi-agent",
    to_agent_id: "zac-agent"
  };
  const relay = http.createServer(async (request, response) => {
    const baseUrl = `http://${request.headers.host}/agentrelay`;
    const bundle = v06Bundle(baseUrl);
    const legacyBundle = protocolV2Bundle({ origin: baseUrl, authorityId: "mcp-v06-test" });
    const url = new URL(request.url, "http://localhost");
    seenRequests.push(`${request.method} ${url.pathname}`);
    const body = await readJson(request);
    if (request.method === "GET" && url.pathname === "/agentrelay/protocols/current") {
      return sendJson(response, 200, bundle.manifest);
    }
    if (request.method === "GET" && url.pathname === "/agentrelay/protocols/agent-collab/v0.6/manifest") {
      return sendJson(response, 200, bundle.manifest);
    }
    if (request.method === "GET" && url.pathname === "/agentrelay/protocols/agent-collab/v0.6/bundle") {
      return sendJson(response, 200, bundle);
    }
    if (request.method === "GET" && url.pathname === "/agentrelay/protocols/agent-collab/v0.5/manifest") {
      return sendJson(response, 200, legacyBundle.manifest);
    }
    if (request.method === "GET" && new Set([
      "/agentrelay/protocols/agent-collab/v0.5/bundle",
      "/agentrelay/api/protocols/agent-collab/v0.5/bundle"
    ]).has(url.pathname)) {
      return sendJson(response, 200, legacyBundle);
    }
    if (request.method === "POST" && url.pathname === "/agentrelay/protocols/negotiate") {
      return sendJson(
        response,
        200,
        negotiation(body.task_protocol_version === "agent-collab-v0.5" ? legacyBundle : bundle, body)
      );
    }
    if (request.method === "POST" && url.pathname === "/agentrelay/tasks") {
      createPayload = body;
      return sendJson(response, 201, {
        task: {
          task_id: "task_mcp_v06",
          protocol_version: "agent-collab-v0.6",
          requester_agent_id: "zac-agent",
          target_agent_id: "vivi-agent",
          status: "open"
        }
      });
    }
    if (request.method === "GET" && url.pathname === `/agentrelay/tasks/${legacyTask.task_id}`) {
      return sendJson(response, 200, {
        task: legacyTask,
        messages: [{
          message_id: legacyTask.current_message_id,
          from_agent_id: "vivi-agent",
          to_agent_id: "zac-agent",
          delivery_status: "delivered",
          parts: [{ kind: "text", text: "continue after upgrade" }]
        }]
      });
    }
    if (request.method === "GET" && url.pathname === "/agentrelay/tasks/task_mcp_v06") {
      return sendJson(response, 200, {
        task: {
          task_id: "task_mcp_v06",
          protocol_version: "agent-collab-v0.6",
          requester_agent_id: "zac-agent",
          target_agent_id: "vivi-agent",
          status: "open",
          current_message_id: "msg_mcp_v06",
          turn_sequence: 1,
          task_version: 1,
          max_turns: 12,
          from_agent_id: "vivi-agent",
          to_agent_id: "zac-agent"
        }
      });
    }
    if (request.method === "POST" && url.pathname === `/agentrelay/tasks/${legacyTask.task_id}/messages`) {
      legacyReplyPayload = body;
      legacyReplyHeaders = request.headers;
      legacyTask.task_version += 1;
      legacyTask.current_message_id = "msg_mcp_v05_reply";
      legacyTask.from_agent_id = "zac-agent";
      legacyTask.to_agent_id = "vivi-agent";
      return sendJson(response, 201, { task: legacyTask, messages: [] });
    }
    sendJson(response, 404, { code: "not_found" });
  });
  await new Promise((resolveListen) => relay.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => relay.close(resolveClose)));

  const client = new Client(
    { name: "agentrelay-v06-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  const elicitationRequests = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicitationRequests.push(request.params);
    return { action: "decline" };
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/server.mjs"],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: `http://127.0.0.1:${relay.address().port}/agentrelay`,
      AGENTRELAY_AGENT_ID: "zac-agent",
      AGENTRELAY_USERNAME: "zac",
      AGENTRELAY_TOKEN: "test-token",
      AGENTRELAY_PROTOCOL_VERSION: "agent-collab-v0.6",
      AGENTRELAY_ALLOW_DIRECT_CREATE: "1",
      AGENTRELAY_STATE_DIR: stateRoot,
      AGENTRELAY_PROTOCOL_CACHE_DIR: join(stateRoot, "protocol-cache")
    },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  });
  await client.connect(transport);
  const protocolStatusResult = await client.callTool({ name: "agentrelay_protocol_status", arguments: {} });
  const protocolStatus = JSON.parse(protocolStatusResult.content[0].text);
  assert.equal(protocolStatus.human_approval_mode, "conversation");
  const tools = await client.listTools();
  const createTool = tools.tools.find((tool) => tool.name === "agentrelay_create_task");
  assert.ok(createTool, `${JSON.stringify(protocolStatus)}\n${tools.tools.map((tool) => tool.name).join(",")}\n${stderr}`);
  assert.ok(createTool.inputSchema.required.includes("message"));
  const result = await client.callTool({
    name: "agentrelay_create_task",
    arguments: {
      targetAgentId: "vivi-agent",
      doneCriteria: "listener recovers the Task",
      message: { subject: "Offline task", parts: [{ kind: "text", text: "ping" }] }
    }
  });
  assert.notEqual(result.isError, true);
  assert.equal(createPayload.protocol_version, "agent-collab-v0.6");
  assert.equal(createPayload.requester_agent_id, "zac-agent");
  assert.equal(createPayload.target_agent_id, "vivi-agent");

  assert.ok(!tools.tools.some((tool) => tool.name === "agentrelay_send_message_v05"));
  await client.callTool({
    name: "agentrelay_resync_local_task",
    arguments: { taskId: legacyTask.task_id }
  });
  await client.callTool({
    name: "agentrelay_prepare_local_action",
    arguments: {
      taskId: legacyTask.task_id,
      actionType: "reply",
      clientActionId: "v05-drain-reply-expired",
      payloadJson: JSON.stringify({ parts: [{ kind: "text", text: "reply through v0.5" }] })
    }
  });
  await approveLocalAction({
    stateRoot,
    taskId: legacyTask.task_id,
    clientActionId: "v05-drain-reply-expired",
    ttlSeconds: 1,
    at: "2020-01-01T00:00:00.000Z"
  });
  await client.callTool({
    name: "agentrelay_prepare_local_action",
    arguments: {
      taskId: legacyTask.task_id,
      actionType: "reply",
      clientActionId: "v05-drain-reply-current",
      payloadJson: JSON.stringify({ parts: [{ kind: "text", text: "reply through v0.5" }] })
    }
  });
  const replyResult = await client.callTool({
    name: "agentrelay_reply",
    arguments: {
      taskId: legacyTask.task_id,
      parts: [{ kind: "text", text: "reply through v0.5" }]
    }
  });
  assert.notEqual(replyResult.isError, true, `${replyResult.content?.[0]?.text}\n${seenRequests.join("\n")}`);
  assert.equal(elicitationRequests.length, 0);
  assert.equal(legacyReplyPayload.message_id, "msg_mcp_v05_drain");
  assert.equal(legacyReplyHeaders["x-agentrelay-task-protocol"], "agent-collab-v0.5");
  assert.equal(legacyReplyHeaders["x-agentrelay-bundle-digest"], legacyBundleDigest(baseUrlFor(relay)));
  const afterReplyStatus = JSON.parse((await client.callTool({
    name: "agentrelay_protocol_status",
    arguments: {}
  })).content[0].text);
  assert.equal(afterReplyStatus.active.version, "agent-collab-v0.6");

  const legacyClient = new Client({ name: "agentrelay-v06-legacy-opt-in-test", version: "1.0.0" });
  const legacyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/server.mjs"],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: baseUrlFor(relay),
      AGENTRELAY_AGENT_ID: "zac-agent",
      AGENTRELAY_USERNAME: "zac",
      AGENTRELAY_TOKEN: "test-token",
      AGENTRELAY_PROTOCOL_VERSION: "agent-collab-v0.6",
      AGENTRELAY_HUMAN_APPROVAL_MODE: "elicitation",
      AGENTRELAY_EXPOSE_LEGACY_PROTOCOL_TOOLS: "1",
      AGENTRELAY_STATE_DIR: stateRoot,
      AGENTRELAY_PROTOCOL_CACHE_DIR: join(stateRoot, "legacy-protocol-cache")
    },
    stderr: "pipe"
  });
  await legacyClient.connect(legacyTransport);
  try {
    const legacyStatus = JSON.parse((await legacyClient.callTool({
      name: "agentrelay_protocol_status",
      arguments: {}
    })).content[0].text);
    assert.equal(legacyStatus.human_approval_mode, "elicitation");
    const legacyTools = await legacyClient.listTools();
    assert.ok(legacyTools.tools.some((tool) => tool.name === "agentrelay_send_message_v05"));
    const mismatchResult = await legacyClient.callTool({
      name: "agentrelay_send_message_v05",
      arguments: {
        taskId: "task_mcp_v06",
        actorAgentId: "zac-agent",
        text: "wrong protocol",
        currentMessageId: "msg_mcp_v06",
        turnSequence: 1,
        expectedTaskVersion: 1,
        clientActionId: "wrong-protocol-action"
      }
    });
    const mismatch = JSON.parse(mismatchResult.content[0].text);
    assert.equal(mismatch.code, "LEGACY_TOOL_PROTOCOL_MISMATCH");
    assert.equal(mismatch.replacementTool, "agentrelay_reply");
  } finally {
    await legacyTransport.close().catch(() => {});
    await legacyClient.close().catch(() => {});
  }
});

function baseUrlFor(relay) {
  return `http://127.0.0.1:${relay.address().port}/agentrelay`;
}

function legacyBundleDigest(origin) {
  return protocolV2Bundle({ origin, authorityId: "mcp-v06-test" }).manifest.bundle_digest;
}

function v06Bundle(origin) {
  const bundle = protocolV2Bundle({ origin, authorityId: "mcp-v06-test" });
  bundle.manifest.version = "agent-collab-v0.6";
  bundle.manifest.semver = "0.6.0";
  bundle.manifest.urls.bundle = `${origin}/protocols/agent-collab/v0.6/bundle`;
  bundle.schemas = Object.fromEntries(Object.entries(bundle.schemas).map(([name, schema]) => {
    const v06Name = name.replace("-v05.", "-v06.");
    return [v06Name, { ...schema, $id: schema.$id.replace("-v05.", "-v06.") }];
  }));
  for (const operation of Object.values(bundle.adapters.operations)) {
    operation.request_schema = operation.request_schema.replace("-v05.", "-v06.");
    for (const binding of operation.bindings) {
      if (binding.slot === "protocol_version") binding.value = "agent-collab-v0.6";
    }
  }
  return resignProtocolV2Bundle(bundle);
}

function negotiation(bundle, request) {
  return {
    action: request.active?.bundle_digest === bundle.manifest.bundle_digest ? "up_to_date" : "hot_patch",
    reason: "v0.6 test bundle",
    runtime_version: request.runtime_version,
    missing_capabilities: [],
    authority: bundle.manifest.authority,
    target: {
      protocol: bundle.manifest.protocol,
      version: bundle.manifest.version,
      semver: bundle.manifest.semver,
      bundle_revision: bundle.manifest.bundle_revision,
      schema_digest: bundle.manifest.schema_digest,
      bundle_digest: bundle.manifest.bundle_digest,
      bundle_url: bundle.manifest.urls.bundle,
      adapter_contract_version: bundle.manifest.adapter_contract_version,
      published_at: bundle.manifest.published_at,
      expires_at: bundle.manifest.expires_at,
      required_client_capabilities: bundle.manifest.required_client_capabilities
    },
    retry_policy: { max_automatic_retries: 1, preserve_idempotency_key: true }
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

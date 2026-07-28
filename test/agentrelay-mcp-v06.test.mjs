import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { protocolV2Bundle, resignProtocolV2Bundle } from "./protocol-v2-fixture.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("MCP stable create tool uses the verified v0.6 semantic bundle", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-v06-"));
  let createPayload;
  const relay = http.createServer(async (request, response) => {
    const baseUrl = `http://${request.headers.host}/agentrelay`;
    const bundle = v06Bundle(baseUrl);
    const url = new URL(request.url, "http://localhost");
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
    if (request.method === "POST" && url.pathname === "/agentrelay/protocols/negotiate") {
      return sendJson(response, 200, negotiation(bundle, body));
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
    sendJson(response, 404, { code: "not_found" });
  });
  await new Promise((resolveListen) => relay.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => relay.close(resolveClose)));

  const client = new Client({ name: "agentrelay-v06-test", version: "1.0.0" });
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
});

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

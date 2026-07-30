import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeSemanticCreate } from "../scripts/agentrelay-semantic-client.mjs";
import { protocolV1Bundle, protocolV2Bundle } from "./protocol-v2-fixture.mjs";

const baseUrl = "https://relay.example/agentrelay/api";

test("semantic create stops after one explicit protocol retry", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "agentrelay-semantic-retry-"));
  const bundle = protocolV2Bundle({ origin: baseUrl, authorityId: "semantic-retry-test" });
  let createAttempts = 0;
  const fetchImpl = protocolFetch(bundle, async () => {
    createAttempts += 1;
    return jsonResponse(426, protocolPatchRequired(bundle));
  });

  await assert.rejects(
    executeSemanticCreate({
      input: semanticInput(),
      identity: { agent_id: "zac-agent" },
      idempotencyKey: "same-key",
      baseUrl,
      cacheRoot,
      fetchImpl
    }),
    (error) => error.code === "protocol_patch_required"
  );
  assert.equal(createAttempts, 2);
});

test("semantic create rebuilds contract v1 request text as a contract v2 Message", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "agentrelay-semantic-contract-upgrade-"));
  const authorityId = "semantic-contract-upgrade-test";
  const v1 = protocolV1Bundle({ origin: baseUrl, authorityId, revision: 1 });
  const v2 = protocolV2Bundle({ origin: baseUrl, authorityId, revision: 2 });
  let current = v1;
  const payloads = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (options.method === "POST" && parsed.pathname.endsWith("/protocols/negotiate")) {
      return jsonResponse(200, negotiation(current, JSON.parse(options.body)));
    }
    if (options.method === "POST" && parsed.pathname.endsWith("/tasks")) {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) {
        current = v2;
        return jsonResponse(426, protocolPatchRequired(v2));
      }
      return jsonResponse(201, { task: { task_id: "task_contract_upgrade" } });
    }
    if (parsed.pathname.endsWith("/protocols/current")) return jsonResponse(200, current.manifest);
    if (parsed.pathname.endsWith("/bundle")) return jsonResponse(200, current);
    return jsonResponse(404, { code: "not_found" });
  };

  await executeSemanticCreate({
    input: {
      targetAgentId: "vivi-agent",
      subject: "Contract upgrade",
      requestText: "preserve this request",
      doneCriteria: "reply once"
    },
    identity: { agent_id: "zac-agent" },
    idempotencyKey: "contract-upgrade-key",
    baseUrl,
    cacheRoot,
    fetchImpl
  });

  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].message, { parts: [{ kind: "text", text: "preserve this request" }] });
  assert.deepEqual(payloads[1].message, {
    subject: "Contract upgrade",
    parts: [{ kind: "text", text: "preserve this request" }]
  });
  assert.equal(payloads[0].idempotency_key, "contract-upgrade-key");
  assert.equal(payloads[1].idempotency_key, "contract-upgrade-key");
});

test("semantic create does not retry an ambiguous network failure", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "agentrelay-semantic-network-"));
  const bundle = protocolV2Bundle({ origin: baseUrl, authorityId: "semantic-network-test" });
  let createAttempts = 0;
  const fetchImpl = protocolFetch(bundle, async () => {
    createAttempts += 1;
    throw new TypeError("connection closed after request write");
  });

  await assert.rejects(
    executeSemanticCreate({
      input: semanticInput(),
      identity: { agent_id: "zac-agent" },
      idempotencyKey: "network-key",
      baseUrl,
      cacheRoot,
      fetchImpl
    }),
    /connection closed after request write/
  );
  assert.equal(createAttempts, 1);
});

test("semantic create only retries protocol_patch_required returned with HTTP 426", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "agentrelay-semantic-status-"));
  const bundle = protocolV2Bundle({ origin: baseUrl, authorityId: "semantic-status-test" });
  let createAttempts = 0;
  const fetchImpl = protocolFetch(bundle, async () => {
    createAttempts += 1;
    return jsonResponse(409, protocolPatchRequired(bundle));
  });

  await assert.rejects(
    executeSemanticCreate({
      input: semanticInput(),
      identity: { agent_id: "zac-agent" },
      idempotencyKey: "wrong-status-key",
      baseUrl,
      cacheRoot,
      fetchImpl
    }),
    (error) => error.statusCode === 409 && error.code === "protocol_patch_required"
  );
  assert.equal(createAttempts, 1);
});

function protocolFetch(bundle, createHandler) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (options.method === "POST" && parsed.pathname.endsWith("/protocols/negotiate")) {
      const request = JSON.parse(options.body);
      return jsonResponse(200, negotiation(bundle, request));
    }
    if (options.method === "POST" && parsed.pathname.endsWith("/tasks")) {
      return createHandler(options);
    }
    if (parsed.pathname.endsWith("/protocols/current")) return jsonResponse(200, bundle.manifest);
    if (parsed.pathname.endsWith("/bundle")) return jsonResponse(200, bundle);
    return jsonResponse(404, { code: "not_found" });
  };
}

function semanticInput() {
  return {
    targetAgentId: "vivi-agent",
    doneCriteria: "reply once",
    message: { subject: "Retry", parts: [{ kind: "text", text: "ping" }] }
  };
}

function negotiation(bundle, request) {
  return {
    action: request.active?.bundle_digest === bundle.manifest.bundle_digest ? "up_to_date" : "hot_patch",
    reason: "semantic retry test",
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

function protocolPatchRequired(bundle) {
  return {
    error: {
      type: "protocol_negotiation",
      code: "protocol_patch_required",
      detail: {
        upgrade: {
          bundle_url: bundle.manifest.urls.bundle,
          required_client_capabilities: [
            ...bundle.manifest.required_client_capabilities,
            "deterministic_semantic_retry_v1"
          ]
        },
        redraft_policy: { safe_to_auto_redraft: ["task_create"] },
        retry_policy: { max_automatic_retries: 1, preserve_idempotency_key: true }
      }
    }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

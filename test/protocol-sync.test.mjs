import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAutoRedraftedPayload,
  inferProtocolOperation,
  maybeHandleProtocolNegotiation,
  negotiateCurrentProtocol,
  resolveProtocolDir,
  syncCurrentProtocol,
  syncProtocolBundle,
  syncProtocolVersion
} from "../scripts/protocol-sync.mjs";
import { canonicalDigest, protocolAuthorityRoot } from "../scripts/protocol-runtime.mjs";
import { protocolV2Bundle } from "./protocol-v2-fixture.mjs";

test("syncProtocolVersion fetches accepted non-default v0.4 explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const manifestUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/manifest";
  const bundleUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle";
  const result = await syncProtocolVersion({
    version: "agent-collab-v0.4",
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      [manifestUrl]: { urls: { bundle: bundleUrl } },
      [bundleUrl]: fakeBundle()
    }),
    log: null
  });
  assert.equal(result.version, "agent-collab-v0.4");
});

test("syncProtocolVersion fetches the v0.5 maintenance bundle explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-v05-"));
  const manifestUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.5/manifest";
  const bundleUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.5/bundle";
  const bundle = protocolV2Bundle();
  const result = await syncProtocolVersion({
    version: "agent-collab-v0.5",
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      [manifestUrl]: { urls: { bundle: bundleUrl } },
      [bundleUrl]: bundle
    }),
    log: null
  });
  assert.equal(result.version, "agent-collab-v0.5");
  assert.equal(result.schema_digest, canonicalDigest(bundle.schemas));
});

test("syncProtocolBundle writes manifest, bundle, schemas, examples, and docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const result = await syncProtocolBundle({
    bundleUrl: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": fakeBundle()
    }),
    log: null
  });

  assert.equal(result.protocol, "agent-collab");
  assert.equal(result.version, "agent-collab-v0.4");
  assert.equal(result.schema_digest, canonicalDigest(fakeBundle().schemas));
  assert.equal(result.cache_dir, resolveProtocolDir(
    root,
    "agent-collab",
    "agent-collab-v0.4",
    result.authority,
    result.bundle_digest
  ));
  assert.equal(existsSync(join(result.cache_dir, "manifest.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "bundle.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "schemas", "task-create.schema.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "examples", "create-task.request.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "docs", "README.md")), true);
  const latest = JSON.parse(await readFile(join(protocolAuthorityRoot(root, result.authority), "active.json"), "utf8"));
  assert.equal(latest.version, "agent-collab-v0.4");
});

test("syncCurrentProtocol follows the server manifest bundle URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const bundle = fakeBundle();
  const result = await syncCurrentProtocol({
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/current": bundle.manifest,
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": bundle
    }),
    log: null
  });

  assert.equal(result.version, "agent-collab-v0.4");
});

test("concurrent protocol activation converges on one immutable bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-concurrent-"));
  const bundleUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle";
  const bundle = fakeBundle();
  const results = await Promise.all(Array.from({ length: 4 }, () => syncProtocolBundle({
    bundleUrl,
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({ [bundleUrl]: bundle }),
    log: null
  })));
  assert.equal(new Set(results.map((item) => item.cache_dir)).size, 1);
  const active = JSON.parse(await readFile(join(protocolAuthorityRoot(root, bundle.manifest.authority), "active.json"), "utf8"));
  assert.equal(active.bundle_digest, bundle.manifest.bundle_digest);
});

test("protocol caches are isolated by Relay authority and origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-authorities-"));
  const first = fakeBundle({ origin: "https://relay-a.example/agentrelay", authorityId: "relay-a" });
  const second = fakeBundle({ origin: "https://relay-b.example/agentrelay", authorityId: "relay-b" });
  const firstResult = await syncProtocolBundle({
    bundleUrl: first.manifest.urls.bundle,
    baseUrl: "https://relay-a.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({ [first.manifest.urls.bundle]: first }),
    log: null
  });
  const secondResult = await syncProtocolBundle({
    bundleUrl: second.manifest.urls.bundle,
    baseUrl: "https://relay-b.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({ [second.manifest.urls.bundle]: second }),
    log: null
  });
  assert.notEqual(firstResult.cache_dir, secondResult.cache_dir);
  assert.notEqual(protocolAuthorityRoot(root, firstResult.authority), protocolAuthorityRoot(root, secondResult.authority));
});

test("activating a new bundle preserves the prior verified pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-lkg-"));
  const first = fakeBundle({ revision: 1 });
  const second = fakeBundle({ revision: 2 });
  await syncProtocolBundle({
    bundleUrl: first.manifest.urls.bundle,
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({ [first.manifest.urls.bundle]: first }),
    log: null
  });
  await syncProtocolBundle({
    bundleUrl: second.manifest.urls.bundle,
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({ [second.manifest.urls.bundle]: second }),
    log: null
  });
  const lastKnownGood = JSON.parse(await readFile(
    join(protocolAuthorityRoot(root, second.manifest.authority), "last-known-good.json"),
    "utf8"
  ));
  assert.equal(lastKnownGood.bundle_digest, first.manifest.bundle_digest);
});

test("protocol activation rejects unsafe cache names and unauthorized downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-guardrail-"));
  const bundleUrl = "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle";
  const unsafe = fakeBundle({ revision: 3 });
  unsafe.docs["../escape.md"] = "no";
  refreshDigests(unsafe);
  await assert.rejects(syncProtocolBundle({
    bundleUrl, cacheRoot: root, fetchImpl: fakeFetch({ [bundleUrl]: unsafe }), log: null
  }), /Unsafe protocol bundle text file/);

  const current = fakeBundle({ revision: 2 });
  await syncProtocolBundle({ bundleUrl, cacheRoot: root, fetchImpl: fakeFetch({ [bundleUrl]: current }), log: null });
  const older = fakeBundle({ revision: 1 });
  await assert.rejects(syncProtocolBundle({
    bundleUrl, cacheRoot: root, fetchImpl: fakeFetch({ [bundleUrl]: older }), log: null
  }), /downgrade requires an authorized hot_rollback/);
  const rolledBack = await syncProtocolBundle({
    bundleUrl,
    cacheRoot: root,
    fetchImpl: fakeFetch({ [bundleUrl]: older }),
    activationAction: "hot_rollback",
    log: null
  });
  assert.equal(rolledBack.bundle_revision, 1);
});

test("local emergency disable prevents negotiation and bundle activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-disabled-"));
  const bundle = protocolV2Bundle();
  const manifestUrl = "https://relay.example/agentrelay/api/protocols/current";
  const previous = process.env.AGENTRELAY_DISABLE_HOT_UPDATE;
  process.env.AGENTRELAY_DISABLE_HOT_UPDATE = "1";
  try {
    const result = await negotiateCurrentProtocol({
      baseUrl: "https://relay.example/agentrelay/api",
      cacheRoot: root,
      fetchImpl: fakeFetch({ [manifestUrl]: bundle.manifest }),
      log: null
    });
    assert.equal(result.status, "hot_update_disabled");
    assert.equal(result.active, null);
  } finally {
    if (previous === undefined) delete process.env.AGENTRELAY_DISABLE_HOT_UPDATE;
    else process.env.AGENTRELAY_DISABLE_HOT_UPDATE = previous;
  }
});

test("maybeHandleProtocolNegotiation auto-redrafts safe task create payloads and retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const retryPayloads = [];
  const result = await maybeHandleProtocolNegotiation({
    responseData: {
      ok: false,
      error: {
        type: "protocol_negotiation",
        code: "protocol_patch_required",
        detail: {
          server_protocol: { version: "agent-collab-v0.4", schema_digest: "sha256:test-v04" },
          upgrade: { bundle_url: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle" },
          redraft_policy: redraftPolicy()
        }
      }
    },
    method: "POST",
    path: "/tasks",
    payload: { protocol_version: "agent-collab-v0.3", idempotency_key: "same-key" },
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": fakeBundle()
    }),
    retryRequest: async (redraftedPayload) => {
      retryPayloads.push(redraftedPayload);
      return { ok: true, data: { task_id: "task-1" } };
    },
    log: null
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.task_id, "task-1");
  assert.deepEqual(retryPayloads, [{
    protocol_version: "agent-collab-v0.4",
    idempotency_key: "same-key"
  }]);
});

test("maybeHandleProtocolNegotiation still returns guidance when no retry hook is provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const recovery = await maybeHandleProtocolNegotiation({
    responseData: protocolPatchRequiredResponse(),
    method: "POST",
    path: "/tasks",
    payload: { protocol_version: "agent-collab-v0.3", idempotency_key: "same-key" },
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": fakeBundle()
    }),
    log: null
  });

  assert.equal(recovery.ok, false);
  assert.equal(recovery.protocol_recovery.status, "protocol_bundle_synced", JSON.stringify(recovery));
  assert.equal(recovery.protocol_recovery.synced.version, "agent-collab-v0.4");
  assert.deepEqual(recovery.protocol_recovery.original_request.payload, {
    protocol_version: "agent-collab-v0.3",
    idempotency_key: "same-key"
  });
  assert.match(recovery.protocol_recovery.next_action, /automatic retry hook/);
});

test("buildAutoRedraftedPayload refuses task close payloads that need local review", () => {
  assert.equal(inferProtocolOperation("POST", "/tasks/task-1/close"), "task_close");
  const redrafted = buildAutoRedraftedPayload({
    payload: { protocol_version: "agent-collab-v0.3", idempotency_key: "close-key" },
    targetProtocolVersion: "agent-collab-v0.4",
    operation: "task_close",
    redraftPolicy: redraftPolicy()
  });
  assert.equal(redrafted, null);
});

test("maybeHandleProtocolNegotiation reports client upgrade without pretending schema sync is enough", async () => {
  const recovery = await maybeHandleProtocolNegotiation({
    responseData: {
      ok: false,
      error: {
        type: "protocol_negotiation",
        code: "client_upgrade_required",
        detail: {
          server_protocol: { version: "agent-collab-v0.5", schema_digest: "sha256:test-v05" }
        }
      }
    },
    method: "POST",
    path: "/tasks",
    payload: {}
  });

  assert.equal(recovery.protocol_recovery.status, "client_upgrade_required");
  assert.match(recovery.protocol_recovery.next_action, /npx github:ZilingXie\/agent-relay-mcp install/);
});

function fakeBundle({
  origin = "https://relay.example/agentrelay",
  authorityId = "relay.example/agentrelay",
  revision = 1
} = {}) {
  const bundle = {
    manifest: {
      protocol: "agent-collab",
      version: "agent-collab-v0.4",
      semver: "0.4.0",
      bundle_revision: revision,
      authority: { id: authorityId, origin },
      required_client_capabilities: ["dynamic_protocol_bundle_v0.1"],
      redraft_policy: redraftPolicy(),
      urls: {
        bundle: `${origin}/api/protocols/agent-collab/v0.4/bundle`
      }
    },
    schemas: {
      "task-create.schema.json": { type: "object", required: ["protocol_version"] }
    },
    examples: {
      "create-task.request.json": { protocol_version: "agent-collab-v0.4" }
    },
    docs: {
      "README.md": `# AgentRelay Protocol v0.4 revision ${revision}`
    }
  };
  const content = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "manifest"));
  bundle.manifest.schema_digest = canonicalDigest(bundle.schemas);
  bundle.manifest.bundle_digest = canonicalDigest(content);
  return bundle;
}

function refreshDigests(bundle) {
  bundle.manifest.schema_digest = canonicalDigest(bundle.schemas);
  bundle.manifest.bundle_digest = canonicalDigest(Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== "manifest")
  ));
  return bundle;
}

function protocolPatchRequiredResponse() {
  return {
    ok: false,
    error: {
      type: "protocol_negotiation",
      code: "protocol_patch_required",
      detail: {
        server_protocol: { version: "agent-collab-v0.4", schema_digest: "sha256:test-v04" },
        upgrade: { bundle_url: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle" },
        redraft_policy: redraftPolicy()
      }
    }
  };
}

function redraftPolicy() {
  return {
    safe_to_auto_redraft: ["task_create", "artifact_submit"],
    requires_local_agent_review: ["task_amend", "task_close"]
  };
}

function fakeFetch(responses) {
  return async (url) => {
    const data = responses[String(url)];
    if (!data) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: "not found" })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data)
    };
  };
}

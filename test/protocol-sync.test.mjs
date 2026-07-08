import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maybeHandleProtocolNegotiation,
  resolveProtocolDir,
  syncCurrentProtocol,
  syncProtocolBundle
} from "../scripts/protocol-sync.mjs";

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
  assert.equal(result.schema_digest, "sha256:test-v04");
  assert.equal(result.cache_dir, resolveProtocolDir(root, "agent-collab", "agent-collab-v0.4"));
  assert.equal(existsSync(join(result.cache_dir, "manifest.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "bundle.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "schemas", "task-create.schema.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "examples", "create-task.request.json")), true);
  assert.equal(existsSync(join(result.cache_dir, "docs", "README.md")), true);
  const latest = JSON.parse(await readFile(join(root, "latest.json"), "utf8"));
  assert.equal(latest.version, "agent-collab-v0.4");
});

test("syncCurrentProtocol follows the server manifest bundle URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const result = await syncCurrentProtocol({
    baseUrl: "https://relay.example/agentrelay/api",
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/current": {
        protocol: "agent-collab",
        version: "agent-collab-v0.4",
        schema_digest: "sha256:test-v04",
        urls: { bundle: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle" }
      },
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": fakeBundle()
    }),
    log: null
  });

  assert.equal(result.version, "agent-collab-v0.4");
});

test("maybeHandleProtocolNegotiation syncs patchable protocol bundle and returns redraft guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-protocol-cache-"));
  const recovery = await maybeHandleProtocolNegotiation({
    responseData: {
      ok: false,
      error: {
        type: "protocol_negotiation",
        code: "protocol_patch_required",
        detail: {
          server_protocol: { version: "agent-collab-v0.4", schema_digest: "sha256:test-v04" },
          upgrade: { bundle_url: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle" }
        }
      }
    },
    method: "POST",
    path: "/tasks",
    payload: { protocol_version: "agent-collab-v0.3", idempotency_key: "same-key" },
    cacheRoot: root,
    fetchImpl: fakeFetch({
      "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle": fakeBundle()
    }),
    log: null
  });

  assert.equal(recovery.ok, false);
  assert.equal(recovery.protocol_recovery.status, "protocol_bundle_synced");
  assert.equal(recovery.protocol_recovery.synced.version, "agent-collab-v0.4");
  assert.deepEqual(recovery.protocol_recovery.original_request.payload, {
    protocol_version: "agent-collab-v0.3",
    idempotency_key: "same-key"
  });
  assert.match(recovery.protocol_recovery.next_action, /redraft/);
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

function fakeBundle() {
  return {
    manifest: {
      protocol: "agent-collab",
      version: "agent-collab-v0.4",
      schema_digest: "sha256:test-v04",
      urls: {
        bundle: "https://relay.example/agentrelay/api/protocols/agent-collab/v0.4/bundle"
      }
    },
    schemas: {
      "task-create.schema.json": { type: "object", required: ["protocol_version"] }
    },
    examples: {
      "create-task.request.json": { protocol_version: "agent-collab-v0.4" }
    },
    docs: {
      "README.md": "# AgentRelay Protocol v0.4"
    }
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

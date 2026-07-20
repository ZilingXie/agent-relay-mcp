#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildSemanticRequest, validateProtocolBundle } from "./protocol-runtime.mjs";
import { negotiateCurrentProtocol } from "./protocol-sync.mjs";

const serverRoot = resolve(process.env.AGENTRELAY_SERVER_REPO || "../agentRelay");
if (!existsSync(join(serverRoot, "server", "app.py"))) {
  throw new Error("Set AGENTRELAY_SERVER_REPO to the AgentRelay Server checkout");
}

const root = await mkdtemp(join(tmpdir(), "agentrelay-guardrail-e2e-"));
const signingKeyPath = join(root, "protocol-signing-key.pem");
const signingKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
await writeFile(signingKeyPath, signingKey, { mode: 0o600 });
const port = await availablePort();
const relayRoot = `http://127.0.0.1:${port}/agentrelay`;
const baseUrl = `${relayRoot}/api`;
const headers = {
  Authorization: "Bearer zac-token",
  "X-AgentRelay-Agent-Id": "zac-agent",
  "X-AgentRelay-Username": "zac"
};
const server = spawn("python3", ["-m", "server.app"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    AGENTRELAY_HOST: "127.0.0.1",
    AGENTRELAY_PORT: String(port),
    AGENTRELAY_DB_PATH: join(root, "legacy.sqlite3"),
    AGENTRELAY_V05_DB_PATH: join(root, "v05.sqlite3"),
    AGENTRELAY_MUTATION_MODE: "v05",
    AGENTRELAY_DYNAMIC_AGENT_TOOLS_ENABLED: "1",
    AGENTRELAY_PROTOCOL_SIGNING_KEY_FILE: signingKeyPath,
    AGENTRELAY_PROTOCOL_SIGNING_KEY_ID: "local-guardrail-e2e-key",
    AGENTRELAY_PUBLIC_BASE_URL: relayRoot,
    AGENTRELAY_PROTOCOL_AUTHORITY_ID: "local-guardrail-e2e",
    AGENTRELAY_TOKENS: "zac:zac-agent:zac-token"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverStderr = "";
server.stderr.on("data", (chunk) => {
  serverStderr += chunk.toString();
});

try {
  await waitForHealth();
  const first = await negotiateCurrentProtocol({
    baseUrl,
    cacheRoot: join(root, "protocol-cache"),
    headers,
    log: null
  });
  assert.equal(first.status, "hot_patch_applied");
  assert.equal(first.active.bundle_revision, 4);
  assert.equal(first.active.adapter_contract_version, 2);

  const bundle = JSON.parse(await readFile(first.active.bundle_path, "utf8"));
  validateProtocolBundle(bundle, {
    expectedTarget: first.active,
    authority: first.active.authority,
    baseUrl
  });
  const reply = buildSemanticRequest({
    bundle,
    operation: "reply",
    input: { taskId: "task-e2e", parts: [{ kind: "text", text: "guardrail-e2e" }] },
    identity: { agent_id: "zac-agent" },
    task: {
      task_id: "task-e2e",
      current_message_id: "msg-e2e",
      turn_sequence: 2,
      task_version: 4
    },
    runtime: { idempotency_key: "guardrail-e2e-key" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(reply.payload)), {
    actor_agent_id: "zac-agent",
    message_id: "msg-e2e",
    turn_sequence: 2,
    expected_task_version: 4,
    idempotency_key: "guardrail-e2e-key",
    parts: [{ kind: "text", text: "guardrail-e2e" }]
  });

  const second = await negotiateCurrentProtocol({
    baseUrl,
    cacheRoot: join(root, "protocol-cache"),
    headers,
    log: null
  });
  assert.equal(second.status, "up_to_date");
  console.log(JSON.stringify({
    ok: true,
    first: first.status,
    second: second.status,
    revision: first.active.bundle_revision,
    digest: first.active.bundle_digest
  }, null, 2));
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
  await rm(root, { recursive: true, force: true });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Guardrail E2E Server did not become healthy: ${serverStderr.trim() || "no server error output"}`);
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const socket = net.createServer();
    socket.once("error", rejectPort);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

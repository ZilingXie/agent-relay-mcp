import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const installer = resolve("scripts/install-codex-app-inbox-example.mjs");

test("installer dry-run reports target agentInbox and env wiring", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-install-"));
  const envPath = join(root, ".env");
  await writeFile(envPath, [
    "AGENTRELAY_BASE_URL=https://relay.example/api",
    "AGENTRELAY_WS_URL=wss://relay.example/api",
    "AGENTRELAY_AGENT_ID=test-agent",
    "AGENTRELAY_USERNAME=test",
    "AGENTRELAY_TOKEN=test-token",
    ""
  ].join("\n"));

  const result = await runNode([
    installer,
    "--project-path", root,
    "--env", envPath,
    "--codex-cli", "/tmp/codex"
  ]);

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "dry-run");
  assert.equal(payload.projectPath, root);
  assert.equal(payload.inboxPath, join(root, "agentInbox"));
  assert.equal(payload.listenerHook, join(root, "agentInbox/scripts/agentrelay-thread-adapter.mjs"));
});

test("installer refuses repo root default target", async () => {
  const envPath = join(await mkdtemp(join(tmpdir(), "agentrelay-install-")), ".env");
  await writeFile(envPath, "AGENTRELAY_TOKEN=test\n");

  const result = await runNode([installer, "--env", envPath], { cwd: process.cwd() });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to install agentInbox/);
});

function runNode(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

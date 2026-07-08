import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const installer = resolve("scripts/install-codex-mcp.mjs");

test("installer preserves an existing env file by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-install-"));
  const envPath = join(root, ".env");
  const configPath = join(root, "config.toml");
  const originalEnv = [
    "AGENTRELAY_BASE_URL=https://relay.example/api",
    "AGENTRELAY_WS_URL=wss://relay.example/api",
    "AGENTRELAY_AGENT_ID=existing-agent",
    "AGENTRELAY_USERNAME=existing-user",
    "AGENTRELAY_TOKEN=existing-token",
    ""
  ].join("\n");
  await writeFile(envPath, originalEnv, { mode: 0o600 });

  const result = await runNode([
    installer,
    "--write",
    "--config", configPath,
    "--env", envPath,
    "--agent-id", "new-agent",
    "--username", "new-user"
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Env file: preserved existing/);
  assert.equal(await readFile(envPath, "utf8"), originalEnv);
});

test("installer writes an env template when no env file exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-install-"));
  const envPath = join(root, ".env");
  const configPath = join(root, "config.toml");

  const result = await runNode([
    installer,
    "--write",
    "--config", configPath,
    "--env", envPath,
    "--base-url", "https://relay.example/api",
    "--ws-url", "wss://relay.example/api",
    "--agent-id", "template-agent",
    "--username", "template-user"
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Env file: .*\.env/);
  const env = await readFile(envPath, "utf8");
  assert.match(env, /AGENTRELAY_BASE_URL="https:\/\/relay\.example\/api"/);
  assert.match(env, /AGENTRELAY_AGENT_ID="template-agent"/);
  assert.match(env, /AGENTRELAY_TOKEN="replace-with-cloud-token"/);
});

test("installer overwrites an existing env file only when explicitly requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-install-"));
  const envPath = join(root, ".env");
  const configPath = join(root, "config.toml");
  await writeFile(envPath, "AGENTRELAY_AGENT_ID=old-agent\nAGENTRELAY_TOKEN=old-token\n", { mode: 0o600 });

  const result = await runNode([
    installer,
    "--write",
    "--overwrite-env",
    "--config", configPath,
    "--env", envPath,
    "--agent-id", "new-agent",
    "--username", "new-user",
    "--token", "new-token"
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /Env backup written:/);
  const env = await readFile(envPath, "utf8");
  assert.match(env, /AGENTRELAY_AGENT_ID="new-agent"/);
  assert.match(env, /AGENTRELAY_TOKEN="new-token"/);
});

test("installer quiet mode suppresses final guidance output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-install-"));
  const envPath = join(root, ".env");
  const configPath = join(root, "config.toml");

  const result = await runNode([
    installer,
    "--write",
    "--quiet",
    "--config", configPath,
    "--env", envPath,
    "--agent-id", "quiet-agent",
    "--username", "quiet-user"
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /Next steps/);
});

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
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

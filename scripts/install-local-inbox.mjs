#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export function buildLocalInboxEnvBlock({
  repoRoot,
  inboxDir = resolve(repoRoot, ".agentrelay", "inbox"),
  stateDir = resolve(repoRoot, "state"),
  hookCommand = `${process.execPath} ${resolve(repoRoot, "scripts/agentrelay-inbox-intake.mjs")}`,
  localAgentRunner = "codex",
  host = "127.0.0.1",
  port = 8787
}) {
  return [
    "# BEGIN AgentRelay Local Inbox managed block",
    `AGENTRELAY_INBOX_DIR=${envValue(inboxDir)}`,
    `AGENTRELAY_STATE_DIR=${envValue(stateDir)}`,
    `AGENTRELAY_LISTENER_HOOK=${envValue(hookCommand)}`,
    "AGENTRELAY_ACK_ON_INBOX_RECEIVED=1",
    "AGENTRELAY_PROCESS_INBOX_ON_RECEIVE=1",
    "AGENTRELAY_EXECUTE_INBOX_ON_RECEIVE=1",
    `AGENTRELAY_LOCAL_AGENT_RUNNER=${envValue(localAgentRunner)}`,
    `AGENTRELAY_INBOX_UI_HOST=${envValue(host)}`,
    `AGENTRELAY_INBOX_UI_PORT=${envValue(String(port))}`,
    "# END AgentRelay Local Inbox managed block",
    ""
  ].join("\n");
}

export function upsertLocalInboxEnvBlock(current, block) {
  const pattern = /# BEGIN AgentRelay Local Inbox managed block\n[\s\S]*?# END AgentRelay Local Inbox managed block\n?/m;
  const normalized = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
  if (pattern.test(normalized)) return normalized.replace(pattern, block);
  return `${normalized}${normalized ? "\n" : ""}${block}`;
}

export function buildInitialEnv({ baseUrl, wsUrl, agentId, username, token, localBlock }) {
  return [
    "# AgentRelay local credentials. Keep this file private.",
    "# Fill all values, then restart Codex App or open a new Codex session.",
    `AGENTRELAY_BASE_URL=${envValue(baseUrl)}`,
    `AGENTRELAY_WS_URL=${envValue(wsUrl)}`,
    `AGENTRELAY_AGENT_ID=${envValue(agentId || "replace-with-agent-id")}`,
    `AGENTRELAY_USERNAME=${envValue(username || "replace-with-username")}`,
    `AGENTRELAY_TOKEN=${envValue(token || "replace-with-cloud-token")}`,
    "",
    localBlock
  ].join("\n");
}

async function installLocalInbox({
  args = parseArgs(process.argv.slice(2)),
  root = repoRoot,
  nodePath = process.execPath
} = {}) {
  const writeConfig = Boolean(args.write);
  const baseUrl = args["base-url"] || process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL;
  const wsUrl = args["ws-url"] || process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl);
  const agentId = args["agent-id"] || process.env.AGENTRELAY_AGENT_ID || "";
  const username = args.username || process.env.AGENTRELAY_USERNAME || "";
  const token = args.token || process.env.AGENTRELAY_TOKEN || "";
  const envPath = resolveHome(args.env || resolve(root, ".env"));
  const configPath = resolveHome(args.config || "~/.codex/config.toml");
  const inboxDir = resolve(root, ".agentrelay", "inbox");
  const stateDir = resolve(root, "state");
  const host = args.host || process.env.AGENTRELAY_INBOX_UI_HOST || "127.0.0.1";
  const port = Number.parseInt(args.port || process.env.AGENTRELAY_INBOX_UI_PORT || "8787", 10);
  const localBlock = buildLocalInboxEnvBlock({
    repoRoot: root,
    inboxDir,
    stateDir,
    hookCommand: `${shellQuote(nodePath)} ${shellQuote(resolve(root, "scripts/agentrelay-inbox-intake.mjs"))}`,
    host,
    port
  });

  if (!writeConfig) {
    console.log(localBlock.trimEnd());
    console.error("\nDry run only. Re-run with --write to install Codex MCP config, local inbox state, and services.");
    return;
  }

  await mkdir(inboxDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(resolve(stateDir, "logs"), { recursive: true, mode: 0o700 });
  await writeJsonIfMissing(resolve(stateDir, "issues.json"), { version: 1, issues: {}, events: {} });
  await writeJsonIfMissing(resolve(stateDir, "task-drafts.json"), { version: 1, drafts: {} });

  await installCodexMcpConfig({
    root,
    configPath,
    envPath,
    baseUrl,
    wsUrl,
    agentId,
    username,
    token
  });

  await upsertEnv({
    envPath,
    baseUrl,
    wsUrl,
    agentId,
    username,
    token,
    localBlock
  });

  if (!args["skip-ui-service"]) {
    const ui = spawnSync(nodePath, [resolve(root, "scripts/install-inbox-ui-service.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, AGENTRELAY_ENV_PATH: envPath, AGENTRELAY_STATE_DIR: stateDir }
    });
    if (ui.status !== 0) throw new Error("install-inbox-ui-service failed");
  }

  if (!args["skip-listener-service"] && token && token !== "replace-with-cloud-token") {
    const listener = spawnSync(nodePath, [resolve(root, "scripts/install-listener-service.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, AGENTRELAY_ENV_PATH: envPath }
    });
    if (listener.status !== 0) throw new Error("install-listener-service failed");
  }

  console.log(`Installed AgentRelay Local Inbox in ${root}`);
  console.log(`Env file: ${envPath}`);
  console.log(`Inbox UI: http://${host}:${port}/`);
  console.log("Next steps:");
  console.log("1. Fill AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, and AGENTRELAY_TOKEN in .env without sharing the token.");
  console.log("2. Restart Codex App or open a new Codex session.");
  console.log("3. Ask the local agent to run npm run doctor and verify AgentRelay MCP health/list_agents.");
  console.log("4. Send a small test task to project-hermes and confirm the reply appears in the local inbox UI.");
}

async function installCodexMcpConfig({ root, configPath, envPath, baseUrl, wsUrl, agentId, username, token }) {
  const args = [
    resolve(root, "scripts/install-codex-mcp.mjs"),
    "--write",
    "--skip-env",
    "--config",
    configPath,
    "--env",
    envPath,
    "--base-url",
    baseUrl,
    "--ws-url",
    wsUrl
  ];
  if (agentId) args.push("--agent-id", agentId);
  if (username) args.push("--username", username);
  if (token) args.push("--token", token);
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (child.status !== 0) throw new Error("install-codex-mcp failed");
}

async function upsertEnv({ envPath, baseUrl, wsUrl, agentId, username, token, localBlock }) {
  await mkdir(dirname(envPath), { recursive: true });
  if (!existsSync(envPath)) {
    await writeFile(envPath, buildInitialEnv({ baseUrl, wsUrl, agentId, username, token, localBlock }), { mode: 0o600 });
    await chmod(envPath, 0o600);
    return;
  }
  const current = await readFile(envPath, "utf8");
  const backupPath = `${envPath}.bak-${timestamp()}`;
  await copyFile(envPath, backupPath);
  await writeFile(envPath, upsertLocalInboxEnvBlock(current, localBlock), { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.error(`Preserved existing .env credentials; backup written: ${backupPath}`);
}

async function writeJsonIfMissing(path, value) {
  if (existsSync(path)) return;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) throw new Error(`Unexpected positional argument: ${entry}`);
    const [rawKey, inlineValue] = entry.slice(2).split("=", 2);
    if (["write", "skip-ui-service", "skip-listener-service", "help"].includes(rawKey)) {
      parsed[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    parsed[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/install-local-inbox.mjs --write [--agent-id zac-agent] [--username zac] [--base-url URL]

Options:
  --base-url URL              Relay HTTP URL. Default: ${DEFAULT_BASE_URL}
  --ws-url URL                Relay WebSocket URL. Default: derived from --base-url
  --agent-id ID               Local AgentRelay agent id
  --username NAME             Local AgentRelay username
  --token TOKEN               Optional token. Prefer letting the user fill .env manually.
  --env PATH                  Local .env path. Default: <repo>/.env
  --config PATH               Codex config path. Default: ~/.codex/config.toml
  --host HOST                 Inbox UI host. Default: 127.0.0.1
  --port PORT                 Inbox UI port. Default: 8787
  --skip-ui-service           Do not install/start the inbox UI service
  --skip-listener-service     Do not install/start the listener service
`);
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function envValue(value) {
  return JSON.stringify(String(value || ""));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function deriveWsUrl(value) {
  const normalized = String(value || "").replace(/\/+$/, "");
  if (normalized.startsWith("https://")) return `wss://${normalized.slice("https://".length)}`;
  if (normalized.startsWith("http://")) return `ws://${normalized.slice("http://".length)}`;
  return normalized;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installLocalInbox().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

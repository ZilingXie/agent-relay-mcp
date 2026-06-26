#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const serverName = args.name || "agentrelay";
const baseUrl = args["base-url"] || process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL;
const wsUrl = args["ws-url"] || process.env.AGENTRELAY_WS_URL || deriveWsUrl(baseUrl);
const agentId = args["agent-id"] || process.env.AGENTRELAY_AGENT_ID || "";
const username = args.username || process.env.AGENTRELAY_USERNAME || "";
const token = args.token || process.env.AGENTRELAY_TOKEN || "";
const configPath = resolveHome(args.config || "~/.codex/config.toml");
const envPath = resolveHome(args.env || resolve(repoRoot, ".env"));
const writeConfig = Boolean(args.write);
const skipEnv = Boolean(args["skip-env"]);
const mcpServerPath = resolve(repoRoot, "mcp/server.mjs");

if (!existsSync(mcpServerPath)) {
  fail(`MCP server not found at ${mcpServerPath}`);
}

const block = buildBlock({ serverName, repoRoot, mcpServerPath, envPath });
const envContent = buildEnv({ baseUrl, wsUrl, agentId, username, token });

if (!writeConfig) {
  console.log(block.trimEnd());
  if (!skipEnv) {
    console.error(`\n.env preview for ${envPath}:\n${envContent.trimEnd()}`);
  }
  console.error("\nDry run only. Re-run with --write to update ~/.codex/config.toml and write the .env template.");
  process.exit(0);
}

await mkdir(dirname(configPath), { recursive: true });
let current = "";
if (existsSync(configPath)) {
  current = await readFile(configPath, "utf8");
  const backupPath = `${configPath}.bak-${timestamp()}`;
  await copyFile(configPath, backupPath);
  console.error(`Backup written: ${backupPath}`);
}

const next = upsertManagedBlock(current, block);
await writeFile(configPath, next);

if (!skipEnv) {
  await mkdir(dirname(envPath), { recursive: true });
  if (existsSync(envPath)) {
    const backupPath = `${envPath}.bak-${timestamp()}`;
    await copyFile(envPath, backupPath);
    console.error(`Env backup written: ${backupPath}`);
  }
  await writeFile(envPath, envContent);
  await chmod(envPath, 0o600);
}

console.log(`Installed AgentRelay MCP server '${serverName}' into ${configPath}`);
console.log(`Env file: ${skipEnv ? "not written" : envPath}`);
console.log(`Base URL: ${baseUrl}`);
console.log(`WebSocket URL: ${wsUrl}`);
console.log("Next steps for the local agent:");
console.log("1. Tell the user that Codex MCP config is installed and the .env template is ready.");
console.log("2. Tell the user to fill or confirm AGENTRELAY_BASE_URL, AGENTRELAY_AGENT_ID, AGENTRELAY_USERNAME, and AGENTRELAY_TOKEN in the .env file.");
console.log("3. Do not print AGENTRELAY_TOKEN in chat or logs.");
console.log("4. Before restart, ask how the user wants to receive messages:");
console.log("   A) manual: use HTTP/MCP pending checks, e.g. agentrelay_pending_tasks or periodic polling.");
console.log("   B) automatic: use the WebSocket listener, plus local inbox and a user-chosen notification/thread adapter.");
console.log("5. If the user chooses automatic, explain that listener setup alone only writes inbox JSON. Ask how they want to be notified or which adapter/hook they want.");
console.log("6. If they use Codex App and want an example adapter project/template, tell them: 'I can install the Codex App example adapter if you want.' Do not install it unless they ask.");
console.log("7. Tell the user to restart Codex App or open a new Codex session, then tell the agent when that is done.");
console.log("8. Only after the user says .env is filled and Codex is restarted/new-sessioned, run `npm run doctor`.");
console.log("9. If doctor passes, verify MCP by calling `agentrelay_health` and `agentrelay_list_agents` in the restarted/new Codex session.");
console.log("10. For manual mode, use `agentrelay_pending_tasks`/HTTP polling as the receive path.");
console.log("11. For automatic mode, start `npm run listener` or `npm run install:listener`; configure AGENTRELAY_LISTENER_HOOK only after the user chooses a local adapter.");

function buildBlock({ serverName, repoRoot, mcpServerPath, envPath }) {
  return `# BEGIN AgentRelay MCP managed block\n[mcp_servers.${serverName}]\ncommand = "node"\nargs = [${tomlString(mcpServerPath)}]\ncwd = ${tomlString(repoRoot)}\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n\n[mcp_servers.${serverName}.env]\nAGENTRELAY_ENV_PATH = ${tomlString(envPath)}\n# END AgentRelay MCP managed block\n`;
}

function buildEnv({ baseUrl, wsUrl, agentId, username, token }) {
  return `# AgentRelay MCP local credentials. Keep this file private.\n# Fill all values, then restart Codex App or open a new Codex session.\nAGENTRELAY_BASE_URL=${envValue(baseUrl)}\nAGENTRELAY_WS_URL=${envValue(wsUrl)}\nAGENTRELAY_AGENT_ID=${envValue(agentId || "replace-with-agent-id")}\nAGENTRELAY_USERNAME=${envValue(username || "replace-with-username")}\nAGENTRELAY_TOKEN=${envValue(token || "replace-with-cloud-token")}\n\n# Local listener writes received task.pending events here.\nAGENTRELAY_INBOX_DIR=${envValue(resolve(repoRoot, ".agentrelay", "inbox"))}\n\n# Optional local hook/thread adapter command. It receives the inbox event JSON path as argv[1].\n# This is user-owned: Codex App, Codex CLI, chat apps, and custom workflows can each use a different adapter.\n# AGENTRELAY_LISTENER_HOOK=""\n`;
}

function upsertManagedBlock(current, block) {
  const pattern = /# BEGIN AgentRelay MCP managed block\n[\s\S]*?# END AgentRelay MCP managed block\n?/m;
  const normalized = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
  if (pattern.test(normalized)) {
    return normalized.replace(pattern, block);
  }
  return `${normalized}${normalized ? "\n" : ""}${block}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      fail(`Unexpected positional argument: ${entry}`);
    }
    const [rawKey, inlineValue] = entry.slice(2).split("=", 2);
    if (["write", "help", "skip-env"].includes(rawKey)) {
      parsed[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${rawKey}`);
    }
    parsed[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:\n  node scripts/install-codex-mcp.mjs --write [--agent-id zac-agent] [--username zac] [--token TOKEN] [--base-url URL]\n\nOptions:\n  --base-url URL   Relay HTTP URL. Default: ${DEFAULT_BASE_URL}\n  --ws-url URL     Relay WebSocket URL. Default: derived from --base-url\n  --agent-id ID    Agent identity issued by the relay admin, for example zac-agent\n  --username NAME  Human/user identity issued by the relay admin, for example zac\n  --token TOKEN    Cloud-issued relay token. If omitted, the .env file contains a placeholder for the user to fill.\n  --env PATH       Local .env path. Default: <repo>/.env\n  --config PATH    Codex config path. Default: ~/.codex/config.toml\n  --skip-env       Only write Codex config; do not write .env\n  --name NAME      MCP server name in Codex config. Default: agentrelay\n\nWithout --write, prints the config block and .env preview only.`);
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function envValue(value) {
  return JSON.stringify(value || "");
}

function deriveWsUrl(value) {
  const normalized = value.replace(/\/+$/, "");
  if (normalized.startsWith("https://")) return `wss://${normalized.slice("https://".length)}`;
  if (normalized.startsWith("http://")) return `ws://${normalized.slice("http://".length)}`;
  return normalized;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

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
const envContent = buildEnv({ baseUrl, agentId, username, token });

if (!writeConfig) {
  console.log(block.trimEnd());
  if (!skipEnv) {
    console.error(`\n.env preview for ${envPath}:\n${envContent.trimEnd()}`);
  }
  console.error("\nDry run only. Re-run with --write to update ~/.codex/config.toml and .env.");
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
if (!token) {
  console.log("No AGENTRELAY_TOKEN was provided. Health may work, but authenticated relay tools will fail until a cloud-issued token is added to .env.");
}
console.log("Next steps for the local agent:");
console.log("1. Tell the user that the .env credentials were written and show the .env path, but do not print the token.");
console.log("2. Run `npm run doctor` in this repo to verify config, .env, and relay HTTP connectivity.");
console.log("3. Ask the user to restart Codex App or open a new Codex session so Codex reloads MCP servers.");
console.log("4. In the restarted/new Codex session, call `agentrelay_health` and `agentrelay_list_agents`.");

function buildBlock({ serverName, repoRoot, mcpServerPath, envPath }) {
  return `# BEGIN AgentRelay MCP managed block\n[mcp_servers.${serverName}]\ncommand = "node"\nargs = [${tomlString(mcpServerPath)}]\ncwd = ${tomlString(repoRoot)}\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n\n[mcp_servers.${serverName}.env]\nAGENTRELAY_ENV_PATH = ${tomlString(envPath)}\n# END AgentRelay MCP managed block\n`;
}

function buildEnv({ baseUrl, agentId, username, token }) {
  return `# AgentRelay MCP local credentials. Keep this file private.\nAGENTRELAY_BASE_URL=${envValue(baseUrl)}\nAGENTRELAY_AGENT_ID=${envValue(agentId)}\nAGENTRELAY_USERNAME=${envValue(username)}\nAGENTRELAY_TOKEN=${envValue(token)}\n`;
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
  console.log(`Usage:\n  node scripts/install-codex-mcp.mjs --write --agent-id zac-agent --username zac --token TOKEN [--base-url URL]\n\nOptions:\n  --base-url URL   Relay URL. Default: ${DEFAULT_BASE_URL}\n  --agent-id ID    Agent identity issued by the relay admin, for example zac-agent\n  --username NAME  Human/user identity issued by the relay admin, for example zac\n  --token TOKEN    Cloud-issued relay token\n  --env PATH       Local .env path. Default: <repo>/.env\n  --config PATH    Codex config path. Default: ~/.codex/config.toml\n  --skip-env       Only write Codex config; do not write .env\n  --name NAME      MCP server name in Codex config. Default: agentrelay\n\nWithout --write, prints the config block and .env preview only.`);
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

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const serverName = args.name || "agentrelay";
const baseUrl = args["base-url"] || process.env.AGENTRELAY_BASE_URL || "http://127.0.0.1:8787/agentrelay";
const token = args.token || process.env.AGENTRELAY_TOKEN || "";
const configPath = resolveHome(args.config || "~/.codex/config.toml");
const writeConfig = Boolean(args.write);
const mcpServerPath = resolve(repoRoot, "mcp/server.mjs");

if (!existsSync(mcpServerPath)) {
  fail(`MCP server not found at ${mcpServerPath}`);
}

const block = buildBlock({ serverName, repoRoot, mcpServerPath, baseUrl, token });

if (!writeConfig) {
  console.log(block.trimEnd());
  console.error("\nDry run only. Re-run with --write to update ~/.codex/config.toml.");
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
console.log(`Installed AgentRelay MCP server '${serverName}' into ${configPath}`);
console.log(`Base URL: ${baseUrl}`);
console.log("Restart Codex App or open a new Codex session so Codex reloads MCP servers.");

function buildBlock({ serverName, repoRoot, mcpServerPath, baseUrl, token }) {
  const tokenLine = token ? `AGENTRELAY_TOKEN = ${tomlString(token)}\n` : "";
  return `# BEGIN AgentRelay MCP managed block\n[mcp_servers.${serverName}]\ncommand = "node"\nargs = [${tomlString(mcpServerPath)}]\ncwd = ${tomlString(repoRoot)}\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n\n[mcp_servers.${serverName}.env]\nAGENTRELAY_BASE_URL = ${tomlString(baseUrl)}\n${tokenLine}# END AgentRelay MCP managed block\n`;
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
    if (["write", "help"].includes(rawKey)) {
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
  console.log(`Usage:\n  node scripts/install-codex-mcp.mjs [--write] [--base-url URL] [--config PATH] [--name agentrelay] [--token TOKEN]\n\nWithout --write, prints the config block only.`);
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configPath = resolveHome(getArg("--config") || "~/.codex/config.toml");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
loadDotEnv(envPath);
const baseUrl = (process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
let ok = true;

check("Node.js >= 18", Number.parseInt(process.versions.node.split(".")[0], 10) >= 18, `found ${process.versions.node}`);
check("mcp/server.mjs exists", existsSync(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
check("node_modules installed", existsSync(resolve(repoRoot, "node_modules/@modelcontextprotocol/sdk")), "run npm install if missing");
check("AgentRelay .env exists", existsSync(envPath), envPath);
check("AGENTRELAY_AGENT_ID configured", Boolean(process.env.AGENTRELAY_AGENT_ID), process.env.AGENTRELAY_AGENT_ID || "missing");
check("AGENTRELAY_USERNAME configured", Boolean(process.env.AGENTRELAY_USERNAME), process.env.AGENTRELAY_USERNAME || "missing");
check("AGENTRELAY_TOKEN configured", Boolean(process.env.AGENTRELAY_TOKEN), process.env.AGENTRELAY_TOKEN ? "present" : "missing");

if (existsSync(configPath)) {
  const config = await readFile(configPath, "utf8");
  check("Codex config contains agentrelay MCP", config.includes("[mcp_servers.agentrelay]"), configPath);
  check("Codex config points at this checkout", config.includes(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
  check("Codex config points at env file", config.includes(envPath), envPath);
} else {
  check("Codex config exists", false, `${configPath} not found`);
}

try {
  const response = await fetch(`${baseUrl}/health`, { headers: relayHeaders() });
  check("AgentRelay HTTP health", response.ok, `${response.status} ${response.statusText} at ${baseUrl}`);
} catch (error) {
  check("AgentRelay HTTP health", false, `${error.message} at ${baseUrl}`);
}

if (!ok) {
  process.exit(1);
}

function relayHeaders() {
  const headers = {};
  if (process.env.AGENTRELAY_TOKEN) headers.Authorization = `Bearer ${process.env.AGENTRELAY_TOKEN}`;
  if (process.env.AGENTRELAY_AGENT_ID) headers["X-AgentRelay-Agent-Id"] = process.env.AGENTRELAY_AGENT_ID;
  if (process.env.AGENTRELAY_USERNAME) headers["X-AgentRelay-Username"] = process.env.AGENTRELAY_USERNAME;
  return headers;
}

function check(name, condition, detail) {
  const mark = condition ? "ok" : "fail";
  console.log(`${mark} - ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) ok = false;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

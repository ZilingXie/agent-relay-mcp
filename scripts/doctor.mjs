#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configPath = resolveHome(process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : "~/.codex/config.toml");
const baseUrl = process.env.AGENTRELAY_BASE_URL || "http://127.0.0.1:8787/agentrelay";
let ok = true;

check("Node.js >= 18", Number.parseInt(process.versions.node.split(".")[0], 10) >= 18, `found ${process.versions.node}`);
check("mcp/server.mjs exists", existsSync(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
check("node_modules installed", existsSync(resolve(repoRoot, "node_modules/@modelcontextprotocol/sdk")), "run npm install if missing");

if (existsSync(configPath)) {
  const config = await readFile(configPath, "utf8");
  check("Codex config contains agentrelay MCP", config.includes("[mcp_servers.agentrelay]"), configPath);
  check("Codex config points at this checkout", config.includes(resolve(repoRoot, "mcp/server.mjs")), resolve(repoRoot, "mcp/server.mjs"));
} else {
  check("Codex config exists", false, `${configPath} not found`);
}

try {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`);
  check("AgentRelay HTTP health", response.ok, `${response.status} ${response.statusText} at ${baseUrl}`);
} catch (error) {
  check("AgentRelay HTTP health", false, `${error.message} at ${baseUrl}`);
}

if (!ok) {
  process.exit(1);
}

function check(name, condition, detail) {
  const mark = condition ? "ok" : "fail";
  console.log(`${mark} - ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) ok = false;
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = resolveHome(args.env || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
const projectPath = resolve(args["project-path"] || process.cwd());
const inboxPath = resolve(projectPath, args["inbox-name"] || "agentInbox");
const templateRoot = resolve(repoRoot, "examples/codex-app-inbox");
const writeMode = Boolean(args.write);
const skipSmoke = Boolean(args["skip-smoke"]);
const codexCli = detectCodexCli(args["codex-cli"]);

if (!existsSync(templateRoot)) fail(`Missing template: ${templateRoot}`);
if (!existsSync(envPath)) fail(`Missing AgentRelay .env: ${envPath}. Run install-codex-mcp first.`);
if (samePath(projectPath, repoRoot) && !args["project-path"]) {
  fail("Refusing to install agentInbox into the agent-relay-mcp repo by default. Re-run with --project-path /path/to/your/project.");
}

const planned = {
  projectPath,
  inboxPath,
  envPath,
  codexCli,
  listenerHook: resolve(inboxPath, "scripts/agentrelay-thread-adapter.mjs")
};

if (!writeMode) {
  console.log(JSON.stringify({ status: "dry-run", ...planned }, null, 2));
  console.error("Dry run only. Re-run with --write to install the Codex App inbox example.");
  process.exit(0);
}

await installTemplate();
await writeInboxEnv();
await updateRelayEnv();
await installBackgroundServices();

let smokeResult = null;
if (!skipSmoke) {
  smokeResult = runSmoke();
}

console.log(JSON.stringify({
  status: "installed",
  ...planned,
  smoke: smokeResult
}, null, 2));
console.log(`Open Codex App and add/open project folder: ${inboxPath}`);
console.log("New AgentRelay messages will create or continue threads in that agentInbox project.");

async function installTemplate() {
  const files = [
    "AGENTS.md",
    "README.md",
    "package.json",
    "fixtures/sample-task-pending.json",
    "scripts/agentrelay-thread-adapter.mjs",
    "scripts/agentrelay-thread-daemon.mjs",
    "scripts/install-thread-daemon-service.mjs",
    "scripts/smoke-codex-app-inbox.mjs",
    "test/agentrelay-thread-adapter.test.mjs",
    "test/agentrelay-thread-daemon.test.mjs"
  ];
  for (const file of files) {
    const source = resolve(templateRoot, file);
    const target = resolve(inboxPath, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await chmod(resolve(inboxPath, "scripts/agentrelay-thread-adapter.mjs"), 0o755);
  await chmod(resolve(inboxPath, "scripts/agentrelay-thread-daemon.mjs"), 0o755);
  await chmod(resolve(inboxPath, "scripts/install-thread-daemon-service.mjs"), 0o755);
  await chmod(resolve(inboxPath, "scripts/smoke-codex-app-inbox.mjs"), 0o755);
  await mkdir(resolve(inboxPath, "events"), { recursive: true });
  await mkdir(resolve(inboxPath, "state"), { recursive: true });
}

async function writeInboxEnv() {
  const sourceEnv = parseDotEnv(await readFile(envPath, "utf8"));
  const inboxEnvPath = resolve(inboxPath, ".env");
  const content = [
    "# AgentRelay Codex App inbox example runtime config.",
    `AGENTRELAY_BASE_URL=${envValue(sourceEnv.AGENTRELAY_BASE_URL || "")}`,
    `AGENTRELAY_WS_URL=${envValue(sourceEnv.AGENTRELAY_WS_URL || "")}`,
    `AGENTRELAY_AGENT_ID=${envValue(sourceEnv.AGENTRELAY_AGENT_ID || "")}`,
    `AGENTRELAY_USERNAME=${envValue(sourceEnv.AGENTRELAY_USERNAME || "")}`,
    `AGENTRELAY_TOKEN=${envValue(sourceEnv.AGENTRELAY_TOKEN || "")}`,
    `AGENTRELAY_INBOX_DIR=${envValue(resolve(inboxPath, "events"))}`,
    `AGENTRELAY_PROJECT_PATH=${envValue(inboxPath)}`,
    `CODEX_CLI=${envValue(codexCli)}`,
    ""
  ].join("\n");
  await writeFile(inboxEnvPath, content, { mode: 0o600 });
  await chmod(inboxEnvPath, 0o600);
}

async function updateRelayEnv() {
  const current = await readFile(envPath, "utf8");
  const updates = {
    AGENTRELAY_INBOX_DIR: resolve(inboxPath, "events"),
    AGENTRELAY_LISTENER_HOOK: planned.listenerHook,
    AGENTRELAY_PROJECT_PATH: inboxPath,
    CODEX_CLI: codexCli
  };
  const next = upsertEnvValues(current, updates);
  await writeFile(envPath, next, { mode: 0o600 });
  await chmod(envPath, 0o600);
}

async function installBackgroundServices() {
  if (platform() !== "darwin") {
    console.log("Skipping launchd install on non-macOS. Run npm run listener and npm run daemon manually.");
    return;
  }
  run("node", [resolve(repoRoot, "scripts/install-listener-service.mjs"), "--env", envPath], repoRoot);
  run("node", [resolve(inboxPath, "scripts/install-thread-daemon-service.mjs"), "--env", resolve(inboxPath, ".env")], inboxPath);
}

function runSmoke() {
  const result = spawnSync("node", [resolve(inboxPath, "scripts/smoke-codex-app-inbox.mjs")], {
    cwd: inboxPath,
    encoding: "utf8",
    env: { ...process.env, AGENTRELAY_ENV_PATH: resolve(inboxPath, ".env") }
  });
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  try {
    return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  } catch {
    return { ok: true, stdout: result.stdout.trim() };
  }
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed`);
}

function detectCodexCli(value) {
  if (value) return resolveHome(value);
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    resolveHome("~/.codex/packages/standalone/current/codex"),
    "codex"
  ];
  return candidates.find((candidate) => candidate === "codex" || existsSync(candidate)) || "codex";
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) fail(`Unexpected positional argument: ${entry}`);
    const [rawKey, inlineValue] = entry.slice(2).split("=", 2);
    if (["write", "skip-smoke", "help"].includes(rawKey)) {
      parsed[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${rawKey}`);
    parsed[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  if (parsed.help) {
    console.log("Usage: node scripts/install-codex-app-inbox-example.mjs --write [--project-path /path/to/project] [--env .env] [--skip-smoke]");
    process.exit(0);
  }
  return parsed;
}

function parseDotEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    result[line.slice(0, equalsIndex).trim()] = parseEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return result;
}

function upsertEnvValues(content, updates) {
  const seen = new Set();
  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${envValue(updates[match[1]])}`;
  });
  const missing = Object.entries(updates)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${envValue(value)}`);
  const body = lines.join("\n").replace(/\n*$/, "\n");
  return `${body}${missing.length ? `\n# Codex App inbox receiver example\n${missing.join("\n")}\n` : ""}`;
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function envValue(value) {
  return JSON.stringify(value || "");
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function samePath(left, right) {
  return relative(left, right) === "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

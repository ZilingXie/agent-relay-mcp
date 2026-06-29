#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectPath = resolve(__dirname, "..");
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(projectPath, ".env");
loadDotEnv(envPath);

const codexCli = process.env.CODEX_CLI || "/Applications/Codex.app/Contents/Resources/codex";
const stateRoot = process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state-smoke");
const prompt = [
  "AgentRelay Codex App inbox smoke.",
  "",
  "This thread verifies that Codex App can create visible threads in this agentInbox project.",
  "No AgentRelay server state was changed by this smoke test."
].join("\n");

await mkdir(stateRoot, { recursive: true });
const threadId = await createThreadAndTurn({ codexCli, projectPath, prompt });
await verifyThreadVisible({ threadId, projectPath });

console.log(JSON.stringify({ ok: true, threadId, projectPath }));

async function createThreadAndTurn({ codexCli, projectPath, prompt }) {
  const startId = 1;
  const turnId = 2;
  const messages = [
    initializeMessage(),
    { method: "initialized", params: {} },
    {
      id: startId,
      method: "thread/start",
      params: {
        cwd: projectPath,
        runtimeWorkspaceRoots: [projectPath],
        threadSource: "agentrelay-inbox-smoke"
      }
    }
  ];
  const responses = await runAppServer(codexCli, messages, async ({ message, send }) => {
    if (message.id !== startId || message.error) return;
    const threadId = message.result?.thread?.id || message.result?.threadId;
    if (!threadId) return;
    send({
      id: turnId,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: projectPath,
        runtimeWorkspaceRoots: [projectPath]
      }
    });
  }, new Set([startId, turnId]));
  const start = findResponse(responses, startId, "thread/start");
  findResponse(responses, turnId, "turn/start");
  const threadId = start?.thread?.id || start?.threadId;
  if (!threadId) throw new Error("thread/start did not return a thread id");
  return threadId;
}

function runAppServer(codexCli, messages, onMessage, expectedIds) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(codexCli, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const parsed = [];
    const seenIds = new Set();
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(new Error(`Timed out waiting for smoke responses; stderr=${stderr.trim()}`));
    }, Number(process.env.AGENTRELAY_SMOKE_TIMEOUT_MS || 120000));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const settleIfReady = () => {
      if (settled) return;
      for (const id of expectedIds) {
        if (!seenIds.has(id)) return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      resolveRun(parsed);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          parsed.push(message);
          if (message.id !== undefined) seenIds.add(message.id);
          if (onMessage) onMessage({ message, send });
          settleIfReady();
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            child.kill();
            rejectRun(error);
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      if (code !== 0) rejectRun(new Error(`codex app-server exited ${code}: ${stderr.trim()}`));
      else resolveRun(parsed);
    });
    for (const message of messages) send(message);
  });
}

async function verifyThreadVisible({ threadId, projectPath }) {
  const stateDbPath = process.env.CODEX_STATE_DB || join(process.env.HOME || "", ".codex/state_5.sqlite");
  const row = await runSqliteScalar(stateDbPath, [
    "select coalesce(rollout_path, '') || char(9) || coalesce(cwd, '')",
    "from threads",
    `where id = ${sqlQuote(threadId)}`,
    "limit 1;"
  ].join(" "));
  if (!row) throw new Error(`Smoke thread was not indexed in Codex state DB: ${threadId}`);
  const [rolloutPath, cwd] = row.split("\t");
  if (cwd !== projectPath) throw new Error(`Smoke thread cwd mismatch: ${cwd}`);
  if (!existsSync(rolloutPath)) throw new Error(`Smoke thread rollout missing: ${rolloutPath}`);
}

function runSqliteScalar(dbPath, query) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("sqlite3", [dbPath, query], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code !== 0) rejectRun(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`));
      else resolveRun(stdout.trim());
    });
  });
}

function findResponse(messages, id, method) {
  const response = messages.find((message) => message.id === id);
  if (!response) throw new Error(`No JSON-RPC response for ${method}`);
  if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

function initializeMessage() {
  return {
    id: 0,
    method: "initialize",
    params: {
      clientInfo: {
        name: "agentrelay_inbox_smoke",
        title: "AgentRelay Inbox Smoke",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    }
  };
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverEvent } from "./agentrelay-thread-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectPathDefault = resolve(__dirname, "..");
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(projectPathDefault, ".env");
loadDotEnv(envPath);

const DEFAULT_CODEX_CLI = "/Applications/Codex.app/Contents/Resources/codex";
const projectPath = process.env.AGENTRELAY_PROJECT_PATH || projectPathDefault;
const stateRoot = process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state");
const queueDir = join(stateRoot, "queue");
const doneDir = join(stateRoot, "queue-done");
const failedDir = join(stateRoot, "queue-failed");
const pollMs = Number(process.env.AGENTRELAY_DAEMON_POLL_MS || 2000);
const maxAttempts = Number(process.env.AGENTRELAY_DAEMON_MAX_ATTEMPTS || 20);

let shuttingDown = false;
let appClient = null;
process.on("SIGINT", () => { shuttingDown = true; });
process.on("SIGTERM", () => { shuttingDown = true; });

export async function processNextJob({
  queueRoot = queueDir,
  doneRoot = doneDir,
  failedRoot = failedDir,
  appClientOverride = appClient,
  relayClientOverride,
  projectPathOverride = projectPath,
  stateRootOverride = stateRoot,
  maxAttemptsOverride = maxAttempts,
  sleepFn = sleep
} = {}) {
  await mkdir(queueRoot, { recursive: true });
  await mkdir(doneRoot, { recursive: true });
  await mkdir(failedRoot, { recursive: true });
  const names = (await readdir(queueRoot)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) return false;
  const queuePath = join(queueRoot, names[0]);
  const workingPath = `${queuePath}.working-${process.pid}`;
  try {
    await rename(queuePath, workingPath);
  } catch {
    return true;
  }

  let job;
  try {
    job = JSON.parse(await readFile(workingPath, "utf8"));
    const result = await deliverEvent({
      eventPath: job.eventPath,
      stateRoot: stateRootOverride,
      projectPath: projectPathOverride,
      appClient: appClientOverride,
      relayClient: relayClientOverride,
      now: () => new Date().toISOString()
    });
    const completedJob = { ...job, result, completedAt: new Date().toISOString() };
    if (result.status === "delivered" || result.status === "duplicate") {
      await writeJsonAtomic(join(doneRoot, `${safeFilePart(job.eventId)}-${Date.now()}.json`), completedJob);
      await removeFile(workingPath);
      console.log(JSON.stringify({ status: "processed", eventId: job.eventId, result }));
      return true;
    }
    throw new Error(result.error || `delivery returned ${result.status}`);
  } catch (error) {
    const failedJob = {
      ...(job || {}),
      eventId: job?.eventId || names[0],
      eventPath: job?.eventPath,
      attempts: Number(job?.attempts || 0) + 1,
      lastError: error.message,
      lastFailedAt: new Date().toISOString()
    };
    if (failedJob.attempts >= maxAttemptsOverride) {
      await writeJsonAtomic(join(failedRoot, `${safeFilePart(failedJob.eventId)}-${Date.now()}.json`), failedJob);
      await removeFile(workingPath);
      console.error(JSON.stringify({ status: "dead-lettered", eventId: failedJob.eventId, error: error.message }));
      return true;
    }
    await sleepFn(backoffMs(failedJob.attempts));
    await writeJsonAtomic(queuePath, failedJob);
    await removeFile(workingPath);
    console.error(JSON.stringify({ status: "retry", eventId: failedJob.eventId, attempts: failedJob.attempts, error: error.message }));
    return true;
  }
}

class LongLivedCodexAppServerClient {
  constructor({ codexCli }) {
    this.codexCli = codexCli;
    this.nextId = 1;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.activeTurnWaiters = new Map();
    this.initialized = false;
  }

  async startThread(params) {
    return this.request("thread/start", params);
  }

  async startTurn(params) {
    const response = await this.request("turn/start", params);
    const turnId = response?.turn?.id;
    if (turnId) await this.waitForTurnCompleted(turnId);
    return response;
  }

  async startThreadAndTurn(threadParams, turnParamsWithoutThreadId) {
    const startResponse = await this.startThread(threadParams);
    const threadId = startResponse?.thread?.id || startResponse?.threadId;
    if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(startResponse)}`);
    const turnResponse = await this.startTurn({ ...turnParamsWithoutThreadId, threadId });
    return { startResponse, turnResponse };
  }

  async verifyThreadVisible({ threadId, projectPath }) {
    return verifyThreadVisibleInStateDb({ threadId, projectPath });
  }

  async request(method, params) {
    await this.ensureStarted();
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for ${method} response`));
      }, Number(process.env.AGENTRELAY_DAEMON_RPC_TIMEOUT_MS || 120000));
      this.pending.set(id, { method, resolveRequest, rejectRequest, timeout });
    });
    this.send(request);
    return promise;
  }

  async waitForTurnCompleted(turnId) {
    return new Promise((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        this.activeTurnWaiters.delete(turnId);
        rejectWait(new Error(`Timed out waiting for turn/completed: ${turnId}`));
      }, Number(process.env.AGENTRELAY_DAEMON_TURN_TIMEOUT_MS || 900000));
      this.activeTurnWaiters.set(turnId, { resolveWait, rejectWait, timeout });
    });
  }

  async ensureStarted() {
    if (this.child && !this.child.killed && this.initialized) return;
    await this.startProcess();
  }

  async startProcess() {
    await this.close();
    this.stdoutBuffer = "";
    this.pending.clear();
    this.activeTurnWaiters.clear();
    this.initialized = false;
    this.child = spawn(this.codexCli, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(text);
    });
    this.child.on("close", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.rejectRequest(new Error(`codex app-server exited ${code}`));
      }
      this.pending.clear();
      for (const waiter of this.activeTurnWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.rejectWait(new Error(`codex app-server exited ${code}`));
      }
      this.activeTurnWaiters.clear();
      this.initialized = false;
    });
    const initId = this.nextId++;
    const initPromise = new Promise((resolveInit, rejectInit) => {
      const timeout = setTimeout(() => {
        this.pending.delete(initId);
        rejectInit(new Error("Timed out waiting for initialize response"));
      }, 60000);
      this.pending.set(initId, {
        method: "initialize",
        resolveRequest: resolveInit,
        rejectRequest: rejectInit,
        timeout
      });
    });
    this.send({
      id: initId,
      method: "initialize",
      params: {
        clientInfo: {
          name: "agentrelay_thread_daemon",
          title: "AgentRelay Thread Daemon",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      }
    });
    this.send({ method: "initialized", params: {} });
    await initPromise;
    this.initialized = true;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        console.error(JSON.stringify({ status: "bad-appserver-json", error: error.message, line: trimmed }));
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.rejectRequest(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolveRequest(message.result);
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = message.params?.turn?.id;
      const waiter = turnId ? this.activeTurnWaiters.get(turnId) : null;
      if (waiter) {
        this.activeTurnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.resolveWait(message.params);
      }
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    if (!child.killed) {
      child.stdin.end();
      await sleep(250);
      if (!child.killed) child.kill();
    }
  }
}

async function verifyThreadVisibleInStateDb({ threadId, projectPath }) {
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
  const stateDbPath = process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite");
  if (!existsSync(stateDbPath)) {
    throw new Error(`Codex state DB not found: ${stateDbPath}`);
  }
  const row = await runSqliteScalar(stateDbPath, [
    "select coalesce(rollout_path, '') || char(9) || coalesce(cwd, '')",
    "from threads",
    `where id = ${sqlQuote(threadId)}`,
    "limit 1;"
  ].join(" "));
  if (!row) {
    throw new Error(`Codex thread was not indexed in state DB: ${threadId}`);
  }
  const [rolloutPath, cwd] = row.split("\t");
  if (projectPath && cwd !== projectPath) {
    throw new Error(`Codex thread indexed with unexpected cwd: ${threadId} cwd=${cwd}`);
  }
  if (!rolloutPath || !existsSync(rolloutPath)) {
    throw new Error(`Codex thread rollout is missing: ${threadId} rollout=${rolloutPath || "(empty)"}`);
  }
  return { threadId, rolloutPath, cwd };
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
      if (code !== 0) {
        rejectRun(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

function writeJsonAtomic(path, value) {
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  });
}

async function removeFile(path) {
  try {
    await import("node:fs/promises").then((fs) => fs.unlink(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function backoffMs(attempts) {
  return Math.min(60000, 1000 * Math.max(1, attempts));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

async function main() {
  await mkdir(queueDir, { recursive: true });
  await mkdir(doneDir, { recursive: true });
  await mkdir(failedDir, { recursive: true });

  appClient = new LongLivedCodexAppServerClient({
    codexCli: process.env.CODEX_CLI || DEFAULT_CODEX_CLI
  });

  console.log(JSON.stringify({
    status: "started",
    service: "agentrelay-thread-daemon",
    projectPath,
    queueDir
  }));

  try {
    while (!shuttingDown) {
      const processed = await processNextJob();
      if (!processed) await sleep(pollMs);
    }
  } finally {
    await appClient.close();
    console.log(JSON.stringify({ status: "stopped", service: "agentrelay-thread-daemon" }));
  }
}

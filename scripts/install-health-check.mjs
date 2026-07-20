#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { persistTaskWorkspace } from "./agentrelay-task-workspace.mjs";

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const DEFAULT_INBOX_UI_URL = "http://127.0.0.1:8787/";
const HEALTHCHECK_AGENT_ID = "agentrelay-healthcheck";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export async function runInstallHealthCheck({
  env = process.env,
  envPath = resolveHome(getArg("--env") || env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env")),
  stateDir,
  timeoutMs = Number(getArg("--timeout-ms") || env.AGENTRELAY_INSTALL_HEALTH_TIMEOUT_MS || 90000),
  pollMs = Number(getArg("--poll-ms") || 500),
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = () => new Date().toISOString(),
  log = console.log
} = {}) {
  const loadedEnv = { ...env };
  loadDotEnv(envPath, loadedEnv);
  const config = loadConfig(loadedEnv, stateDir);
  const startedAt = now();
  log(`AgentRelay install loopback health check started for ${config.agentId}.`);

  const createResponse = await relayRequest(fetchImpl, config, "POST", "/healthchecks/install", {
    idempotency_key: `install-health-${config.agentId}-${randomUUID()}`
  });
  const createData = unwrapData(createResponse);
  const task = createData.task;
  if (!task?.task_id) {
    throw new Error(`Install health check response is missing task.task_id: ${JSON.stringify(createResponse)}`);
  }
  const taskId = task.task_id;
  const ackText = assertInstallAck({ messages: createData.messages, agentId: config.agentId, taskId });
  log(`Synthetic ACK received from ${HEALTHCHECK_AGENT_ID}: ${taskId}.`);

  const issue = await waitForInboxIssue({
    stateDir: config.stateDir,
    taskId,
    timeoutMs,
    pollMs,
    sleepImpl
  });
  log(`Local inbox recorded health check task ${taskId}.`);

  const delivered = await waitForDeliveredTask({
    fetchImpl,
    config,
    taskId,
    timeoutMs,
    pollMs,
    sleepImpl
  });
  const currentTask = delivered.task;
  const closeResponse = await relayRequest(fetchImpl, config, "POST", `/tasks/${encodeURIComponent(taskId)}/complete`, {
    actor_agent_id: config.agentId,
    message_id: currentTask.current_message_id,
    turn_sequence: currentTask.turn_sequence,
    expected_task_version: currentTask.task_version,
    idempotency_key: `install-health-close-${taskId}`,
    completed_against_message_id: currentTask.current_message_id
  });
  const closedData = unwrapData(closeResponse);
  const closedTask = closedData.task;
  if (closedTask?.status !== "completed") {
    throw new Error(`Install health check completion did not complete task ${taskId}: ${JSON.stringify(closeResponse)}`);
  }
  await persistTaskWorkspace({
    stateRoot: config.stateDir,
    task: {
      ...task,
      ...closedTask,
      messages: Array.isArray(closedData.messages) ? closedData.messages : delivered.messages,
      artifacts: Array.isArray(closedTask.artifacts) ? closedTask.artifacts : (Array.isArray(task.artifacts) ? task.artifacts : [])
    },
    localAgentId: config.agentId,
    source: "install_health_close",
    syncedAt: now()
  });
  log(`Health check task closed: ${taskId}.`);
  log(`Open local inbox: ${config.inboxUiUrl}`);

  return {
    ok: true,
    taskId,
    status: closedTask.status,
    ack: ackText,
    issue,
    inboxUiUrl: config.inboxUiUrl,
    startedAt,
    completedAt: now()
  };
}

function loadConfig(env, stateDirOverride) {
  const missing = [];
  for (const key of ["AGENTRELAY_BASE_URL", "AGENTRELAY_AGENT_ID", "AGENTRELAY_USERNAME", "AGENTRELAY_TOKEN"]) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Fill .env, restart Codex/new session, then run npm run doctor before this health check.`);
  }
  const stateDir = resolveHome(stateDirOverride || env.AGENTRELAY_STATE_DIR || resolve(repoRoot, "state"));
  const inboxUiHost = env.AGENTRELAY_INBOX_UI_HOST || "127.0.0.1";
  const inboxUiPort = env.AGENTRELAY_INBOX_UI_PORT || "8787";
  return {
    baseUrl: normalizeBaseUrl(env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
    agentId: env.AGENTRELAY_AGENT_ID,
    username: env.AGENTRELAY_USERNAME,
    token: env.AGENTRELAY_TOKEN,
    stateDir,
    inboxUiUrl: env.AGENTRELAY_INBOX_UI_URL || `http://${inboxUiHost}:${inboxUiPort}/` || DEFAULT_INBOX_UI_URL
  };
}

async function relayRequest(fetchImpl, config, method, path, payload) {
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.token}`,
      "X-AgentRelay-Agent-Id": config.agentId,
      "X-AgentRelay-Username": config.username
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`AgentRelay ${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function assertInstallAck({ messages, agentId, taskId }) {
  const ackMessage = (Array.isArray(messages) ? messages : []).find((message) => {
    return message.from_agent_id === HEALTHCHECK_AGENT_ID
      && partsText(message.parts).includes(`ACK from ${HEALTHCHECK_AGENT_ID}`);
  });
  if (!ackMessage) {
    throw new Error(`Install health check task ${taskId} is missing an ACK Message from ${HEALTHCHECK_AGENT_ID}.`);
  }
  const text = partsText(ackMessage.parts);
  const required = [`ACK from ${HEALTHCHECK_AGENT_ID}`, `requester=${agentId}`, `task=${taskId}`];
  for (const value of required) {
    if (!text.includes(value)) {
      throw new Error(`Install health check ACK is missing ${value}: ${text}`);
    }
  }
  return text;
}

async function waitForDeliveredTask({ fetchImpl, config, taskId, timeoutMs, pollMs, sleepImpl }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const detail = unwrapData(await relayRequest(
      fetchImpl,
      config,
      "GET",
      `/tasks/${encodeURIComponent(taskId)}`
    ));
    const current = (Array.isArray(detail.messages) ? detail.messages : [])
      .find((message) => message.message_id === detail.task?.current_message_id);
    if (current?.delivery_status === "delivered") return detail;
    await sleepImpl(pollMs);
  }
  throw new Error(`Timed out waiting for delivered synthetic ACK Message on ${taskId}.`);
}

function partsText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

async function waitForInboxIssue({ stateDir, taskId, timeoutMs, pollMs, sleepImpl }) {
  const issuesPath = resolve(stateDir, "issues.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const issue = await readIssue(issuesPath, taskId);
    if (issue?.localWorkflowBinding?.type === "local_inbox") return issue;
    await sleepImpl(pollMs);
  }
  throw new Error(
    `Timed out waiting for ${taskId} with localWorkflowBinding in ${issuesPath}. ` +
    "Make sure the AgentRelay listener is running and AGENTRELAY_LISTENER_HOOK points to scripts/agentrelay-inbox-intake.mjs."
  );
}

async function readIssue(issuesPath, taskId) {
  if (!existsSync(issuesPath)) return null;
  const parsed = JSON.parse(await readFile(issuesPath, "utf8"));
  return parsed.issues?.[taskId] || null;
}

function unwrapData(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function loadDotEnv(path, targetEnv) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (key && targetEnv[key] === undefined) targetEnv[key] = value;
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runInstallHealthCheck()
    .then((result) => {
      console.log(JSON.stringify({
        ok: true,
        taskId: result.taskId,
        status: result.status,
        inboxUiUrl: result.inboxUiUrl
      }, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

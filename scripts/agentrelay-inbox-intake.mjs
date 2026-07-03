#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(PROJECT_ROOT, ".env");
loadDotEnv(envPath);

export async function processInboxEvent({
  eventPath,
  projectPath = process.env.AGENTRELAY_PROJECT_PATH || PROJECT_ROOT,
  stateRoot,
  agentId = process.env.AGENTRELAY_AGENT_ID || "",
  relayClient,
  ackReceived = process.env.AGENTRELAY_ACK_ON_INBOX_RECEIVED === "1",
  processInboxAfterReceive = process.env.AGENTRELAY_PROCESS_INBOX_ON_RECEIVE === "1",
  executeInboxAfterReceive = process.env.AGENTRELAY_EXECUTE_INBOX_ON_RECEIVE === "1",
  processor,
  executor,
  now = () => new Date().toISOString()
} = {}) {
  if (!eventPath) throw new Error("Missing eventPath");
  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const event = payload.event || {};
  const task = payload.task || {};
  const taskId = task.task_id || event.taskId || event.task_id;
  if (!taskId) throw new Error(`Inbox event is missing task id: ${eventPath}`);
  const eventId = event.eventId || event.event_id || `${taskId}:${task.updated_at || payload.receivedAt || event.type || "event"}`;
  const stateDir = stateRoot || process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state");

  const inboxBefore = await readIssueInbox(join(stateDir, "issues.json"));
  const previousEvent = inboxBefore.events?.[eventId];
  if (previousEvent?.status === "received") {
    if (ackReceived) {
      if (!agentId) throw new Error("Missing AGENTRELAY_AGENT_ID");
      relayClient ||= new AgentRelayHttpClient({
        baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
        token: process.env.AGENTRELAY_TOKEN || "",
        agentId,
        username: process.env.AGENTRELAY_USERNAME || ""
      });
      await relayClient.ackEvent({
        agentId,
        eventId,
        taskId,
        status: "received",
        projectPath
      });
      await markIssueEventAcked({
        stateDir,
        eventId,
        status: "received",
        now
      });
    }
    return { status: "duplicate", eventId, taskId, acked: Boolean(ackReceived) };
  }

  await recordIssueInboxEvent({
    stateDir,
    payload,
    eventPath,
    taskId,
    eventId,
    projectPath,
    now
  });

  if (ackReceived) {
    if (!agentId) throw new Error("Missing AGENTRELAY_AGENT_ID");
    relayClient ||= new AgentRelayHttpClient({
      baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
      token: process.env.AGENTRELAY_TOKEN || "",
      agentId,
      username: process.env.AGENTRELAY_USERNAME || ""
    });
    await relayClient.ackEvent({
      agentId,
      eventId,
      taskId,
      status: "received",
      projectPath
    });
    await markIssueEventAcked({
      stateDir,
      eventId,
      status: "received",
      now
    });
  }

  const processorResult = processInboxAfterReceive
    ? await runInboxProcessor({
      processor,
      stateRoot: stateDir,
      localAgentId: agentId,
      now
    })
    : undefined;
  const executorResult = executeInboxAfterReceive
    ? await runInboxExecutor({
      executor,
      stateRoot: stateDir,
      localAgentId: agentId,
      now
    })
    : undefined;

  return { status: "received", eventId, taskId, processor: processorResult, executor: executorResult };
}

async function runInboxProcessor({ processor, stateRoot, localAgentId, now }) {
  if (!processor) {
    const module = await import("./agentrelay-inbox-processor.mjs");
    processor = module.processInbox;
  }
  return processor({ stateRoot, localAgentId, now });
}

async function runInboxExecutor({ executor, stateRoot, localAgentId, now }) {
  if (!executor) {
    const module = await import("./agentrelay-inbox-agent-executor.mjs");
    executor = module.executeInboxAgent;
  }
  return executor({ stateRoot, localAgentId, now });
}

async function recordIssueInboxEvent({ stateDir, payload, eventPath, taskId, eventId, projectPath, now }) {
  const inboxPath = join(stateDir, "issues.json");
  const inbox = await readIssueInbox(inboxPath);
  const task = payload.task || {};
  const event = payload.event || {};
  const previousIssue = inbox.issues[taskId] || {};
  const eventIds = Array.from(new Set([...(previousIssue.eventIds || []), eventId]));
  inbox.version = 1;
  inbox.issues[taskId] = {
    ...previousIssue,
    taskId,
    subject: task.subject || previousIssue.subject || "",
    requesterAgentId: task.requester_agent_id || previousIssue.requesterAgentId || "",
    targetAgentId: task.target_agent_id || previousIssue.targetAgentId || "",
    completionOwnerAgentId: task.completion_owner_agent_id || previousIssue.completionOwnerAgentId || "",
    pendingOnAgentId: task.pending_on_agent_id || previousIssue.pendingOnAgentId || "",
    pendingOnHumanId: task.pending_on_human_id || previousIssue.pendingOnHumanId || null,
    relayStatus: task.status || previousIssue.relayStatus || "",
    localStatus: "received",
    direction: inferIssueDirection(task, event),
    counterpartAgentId: inferCounterpartAgentId(task, event),
    lastEventId: eventId,
    eventIds,
    projectPath,
    createdAt: previousIssue.createdAt || now(),
    updatedAt: now()
  };
  inbox.events[eventId] = {
    ...(inbox.events[eventId] || {}),
    eventId,
    taskId,
    type: event.type || event.eventType || event.event_type || "",
    status: "received",
    sourcePath: eventPath,
    receivedAt: payload.receivedAt || now(),
    recordedAt: inbox.events[eventId]?.recordedAt || now()
  };
  await writeJsonAtomic(inboxPath, inbox);
  return inbox;
}

async function markIssueEventAcked({ stateDir, eventId, status, now }) {
  const inboxPath = join(stateDir, "issues.json");
  const inbox = await readIssueInbox(inboxPath);
  if (!inbox.events[eventId]) return;
  inbox.events[eventId] = {
    ...inbox.events[eventId],
    ackStatus: status,
    ackedAt: now()
  };
  await writeJsonAtomic(inboxPath, inbox);
}

function inferCounterpartAgentId(task, event) {
  const localAgentId = event.agentId || event.agent_id || "";
  if (task.requester_agent_id && task.requester_agent_id !== localAgentId) return task.requester_agent_id;
  if (task.target_agent_id && task.target_agent_id !== localAgentId) return task.target_agent_id;
  return task.requester_agent_id || task.target_agent_id || "";
}

function inferIssueDirection(task, event) {
  const localAgentId = event.agentId || event.agent_id || "";
  if (task.requester_agent_id === localAgentId) return "outgoing";
  if (task.target_agent_id === localAgentId || task.pending_on_agent_id === localAgentId) return "incoming";
  return "unknown";
}

class AgentRelayHttpClient {
  constructor({ baseUrl, token, agentId, username }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.agentId = agentId;
    this.username = username;
  }

  async ackEvent({ agentId, eventId, taskId, status, projectPath }) {
    return this.request("POST", `/workers/${encodeURIComponent(agentId)}/events/${encodeURIComponent(eventId)}/ack`, {
      taskId,
      status,
      projectPath
    });
  }

  async request(method, path, payload) {
    if (!this.baseUrl) throw new Error("Missing AGENTRELAY_BASE_URL");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.agentId ? { "X-AgentRelay-Agent-Id": this.agentId } : {}),
        ...(this.username ? { "X-AgentRelay-Username": this.username } : {})
      },
      body: payload ? JSON.stringify(compact(payload)) : undefined
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`AgentRelay ${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    return data;
  }
}

async function readIssueInbox(path) {
  if (!existsSync(path)) return { version: 1, issues: {}, events: {} };
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    version: parsed.version || 1,
    issues: parsed.issues || {},
    events: parsed.events || {}
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
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
  const eventPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  processInboxEvent({ eventPath })
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

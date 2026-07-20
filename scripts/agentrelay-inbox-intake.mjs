#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resyncLocalTask, unwrapTask } from "./agentrelay-task-context-sync.mjs";
import { markTaskSyncPending, sanitizeSyncError } from "./agentrelay-task-workspace.mjs";
import { messageAckMetadataV04 } from "./agentrelay-v04.mjs";
import {
  informationalAckPayloadV05,
  messageAckPayloadV05,
  PROTOCOL_V05
} from "./agentrelay-v05.mjs";

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
  listenerInstanceId = process.env.AGENTRELAY_LISTENER_INSTANCE_ID || "",
  readinessEpoch = Number(process.env.AGENTRELAY_READINESS_EPOCH || 0),
  relayClient,
  ackReceived = process.env.AGENTRELAY_ACK_ON_INBOX_RECEIVED === "1",
  processInboxAfterReceive = process.env.AGENTRELAY_PROCESS_INBOX_ON_RECEIVE === "1",
  executeInboxAfterReceive = process.env.AGENTRELAY_EXECUTE_INBOX_ON_RECEIVE === "1",
  processor,
  executor,
  syncTaskContext = resyncLocalTask,
  syncMaxAttempts = 2,
  syncRetryDelayMs = Number(process.env.AGENTRELAY_CONTEXT_SYNC_RETRY_MS || 250),
  sleep,
  agentsMdPath = process.env.AGENTRELAY_AGENTS_MD_PATH,
  now = () => new Date().toISOString()
} = {}) {
  if (!eventPath) throw new Error("Missing eventPath");
  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const event = payload.event || {};
  const task = payload.task || {};
  const taskId = task.task_id || event.taskId || event.task_id;
  if (!taskId) throw new Error(`Inbox event is missing task id: ${eventPath}`);
  const eventId = event.eventId || event.event_id || `${taskId}:${task.updated_at || payload.receivedAt || event.type || "event"}`;
  const isV05 = (event.protocolVersion || event.protocol_version || task.protocol_version) === PROTOCOL_V05;
  const transitionableV05 = isV05 && Boolean(event.canTransitionMessage ?? event.can_transition_message);
  const workspaceVersion = isV05 ? 2 : 1;
  const relaySnapshotKey = buildRelaySnapshotKey(taskId, task);
  const stateDir = stateRoot || process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state");

  const inboxBefore = await readIssueInbox(join(stateDir, "issues.json"));
  const previousEvent = inboxBefore.events?.[eventId];
  const shouldAck = ackReceived && !event.recovery;
  let intakeStatus = "received";
  if (previousEvent?.status === "received" || previousEvent?.status === "duplicate") {
    intakeStatus = "duplicate";
  } else if (relaySnapshotKey && inboxBefore.issues?.[taskId]?.relaySnapshotKey === relaySnapshotKey) {
    await recordDuplicateSnapshotEvent({ stateDir, payload, eventPath, taskId, eventId, now });
    intakeStatus = "duplicate_snapshot";
  } else {
    await recordIssueInboxEvent({
      stateDir,
      payload,
      eventPath,
      taskId,
      eventId,
      relaySnapshotKey,
      projectPath,
      now
    });
  }

  relayClient ||= new AgentRelayHttpClient({
    baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
    token: process.env.AGENTRELAY_TOKEN || "",
    agentId,
    username: process.env.AGENTRELAY_USERNAME || ""
  });
  await markTaskSyncPending({
    stateRoot: stateDir,
    taskId,
    eventId,
    source: event.recovery ? "reconciliation" : "event",
    at: now(),
    workspaceVersion
  });
  const messageAck = messageAckMetadataV04(event, agentId);
  let ackResult;
  let contextSync;
  if (transitionableV05) {
    contextSync = await syncInboxTaskContext();
    let v05MessageAck = null;
    if (contextSync.task) {
      try {
        const ackPayload = messageAckPayloadV05({
          event,
          task: contextSync.task,
          listenerInstanceId,
          readinessEpoch
        });
        v05MessageAck = {
          agentId,
          taskId,
          messageId: ackPayload.message_id,
          payload: ackPayload
        };
      } catch (error) {
        ackResult = { acked: false, nacked: false, error: sanitizeSyncError(error), response: null };
      }
    }
    if (contextSync.status === "context_ready" && v05MessageAck) {
      ackResult = await ackDurableEvent({
        shouldAck,
        relayClient,
        agentId,
        eventId,
        event,
        messageAck: v05MessageAck,
        taskId,
        projectPath,
        stateDir,
        now
      });
      const acknowledgedTask = unwrapTask(ackResult.response);
      if (acknowledgedTask) contextSync = await syncInboxTaskContext(acknowledgedTask);
    } else if (contextSync.error?.category === "local_persistence" && v05MessageAck) {
      ackResult = await nackNonRetryableMessage({
        relayClient,
        metadata: v05MessageAck,
        eventId,
        stateDir,
        now
      });
    } else if (!ackResult) {
      ackResult = { acked: false, nacked: false, error: contextSync.error || null, response: null };
    }
  } else if (messageAck) {
    contextSync = await syncInboxTaskContext();
    const durableCurrentMessage = contextSync.status === "context_ready"
      && contextSync.task?.current_message_id === messageAck.messageId
      && Number(contextSync.task?.turn_sequence) === messageAck.payload.turn_sequence
      && Number(contextSync.task?.status_version) === messageAck.payload.expected_status_version;
    ackResult = await ackDurableEvent({
      shouldAck: shouldAck && durableCurrentMessage,
      relayClient, agentId, eventId, event, messageAck, taskId, projectPath, stateDir, now
    });
    const acknowledgedTask = unwrapTask(ackResult.response);
    if (acknowledgedTask) contextSync = await syncInboxTaskContext(acknowledgedTask);
  } else {
    const informationalAck = isV05
      ? informationalAckPayloadV05({ event, listenerInstanceId, readinessEpoch })
      : null;
    ackResult = await ackDurableEvent({
      shouldAck, relayClient, agentId, eventId, event, informationalAck,
      taskId, projectPath, stateDir, now
    });
    contextSync = await syncInboxTaskContext();
  }

  async function syncInboxTaskContext(initialTaskOverride = null) {
    return syncTaskContext({
      stateRoot: stateDir,
      taskId,
      fetchTask: (id) => relayClient.getTask(id),
      initialTask: initialTaskOverride || (Object.keys(task).length ? task : null),
      localAgentId: agentId,
      source: event.recovery ? "reconciliation" : "event",
      eventId,
      maxAttempts: Object.keys(task).length ? 1 : syncMaxAttempts,
      retryDelayMs: syncRetryDelayMs,
      sleep,
      now,
      agentsMdPath,
      workspaceVersion
    });
  }

  const processorResult = processInboxAfterReceive && intakeStatus === "received" && contextSync.status === "context_ready"
    ? await runInboxProcessor({
      processor,
      stateRoot: stateDir,
      localAgentId: agentId,
      now
    })
    : undefined;
  const executorResult = executeInboxAfterReceive && intakeStatus === "received" && contextSync.status === "context_ready"
    ? await runInboxExecutor({
      executor,
      stateRoot: stateDir,
      localAgentId: agentId,
      now
    })
    : undefined;

  return {
    status: intakeStatus,
    eventId,
    taskId,
    acked: ackResult.acked,
    nacked: Boolean(ackResult.nacked),
    ackError: ackResult.error,
    contextSync,
    processor: processorResult,
    executor: executorResult
  };
}

async function ackDurableEvent({ shouldAck, relayClient, agentId, eventId, event, messageAck, informationalAck, taskId, projectPath, stateDir, now }) {
  if (!shouldAck) return { acked: false, error: null, response: null };
  if (!agentId) throw new Error("Missing AGENTRELAY_AGENT_ID");
  try {
    messageAck ||= messageAckMetadataV04(event, agentId);
    if (messageAck) {
      const response = await relayClient.ackMessage(messageAck);
      await markIssueEventAcked({ stateDir, eventId, status: "received", now });
      return { acked: true, error: null, response };
    } else if (informationalAck) {
      const response = await relayClient.ackInformationalEvent({ agentId, eventId, payload: informationalAck });
      await markIssueEventAcked({ stateDir, eventId, status: "received", now });
      return { acked: true, error: null, response };
    } else {
      const response = await relayClient.ackEvent({ agentId, eventId, taskId, status: "received", projectPath });
      await markIssueEventAcked({ stateDir, eventId, status: "received", now });
      return { acked: true, error: null, response };
    }
  } catch (error) {
    const safeError = sanitizeSyncError(error);
    await markIssueEventAckFailed({ stateDir, eventId, error: safeError, now });
    return { acked: false, error: safeError, response: null };
  }
}

async function nackNonRetryableMessage({ relayClient, metadata, eventId, stateDir, now }) {
  try {
    const response = await relayClient.failMessageDelivery({
      ...metadata,
      payload: { ...metadata.payload, reason: "listener_persistence_failed" }
    });
    await markIssueEventAcked({ stateDir, eventId, status: "delivery_failed", now });
    return { acked: false, nacked: true, error: null, response };
  } catch (error) {
    const safeError = sanitizeSyncError(error);
    await markIssueEventAckFailed({ stateDir, eventId, error: safeError, now });
    return { acked: false, nacked: false, error: safeError, response: null };
  }
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

async function recordIssueInboxEvent({ stateDir, payload, eventPath, taskId, eventId, relaySnapshotKey, projectPath, now }) {
  const inboxPath = join(stateDir, "issues.json");
  const inbox = await readIssueInbox(inboxPath);
  const task = payload.task || {};
  const event = payload.event || {};
  const previousIssue = inbox.issues[taskId] || {};
  const eventIds = Array.from(new Set([...(previousIssue.eventIds || []), eventId]));
  const recordedAt = now();
  const pendingOnAgentId = task.pending_on_agent_id
    || task.to_agent_id
    || event.toAgentId
    || event.to_agent_id
    || event.pendingOnAgentId
    || event.pending_on_agent_id
    || previousIssue.pendingOnAgentId
    || "";
  inbox.version = 1;
  inbox.issues[taskId] = {
    ...previousIssue,
    taskId,
    subject: task.subject || initialMessageSubject(payload) || previousIssue.subject || doneCriteriaTitle(task.done_criteria),
    requesterAgentId: task.requester_agent_id || previousIssue.requesterAgentId || "",
    targetAgentId: task.target_agent_id || previousIssue.targetAgentId || "",
    doneCriteria: task.done_criteria || previousIssue.doneCriteria || "",
    completionOwnerAgentId: task.completion_owner_agent_id || previousIssue.completionOwnerAgentId || "",
    protocolVersion: task.protocol_version || previousIssue.protocolVersion || "",
    rootTaskId: task.root_task_id || previousIssue.rootTaskId || taskId,
    currentMessageId: task.current_message_id || event.messageId || event.message_id || previousIssue.currentMessageId || "",
    turnSequence: task.turn_sequence ?? event.turnSequence ?? event.turn_sequence ?? previousIssue.turnSequence ?? null,
    statusVersion: task.status_version ?? event.statusVersion ?? event.status_version ?? previousIssue.statusVersion ?? null,
    fromAgentId: task.from_agent_id || event.fromAgentId || event.from_agent_id || previousIssue.fromAgentId || "",
    toAgentId: task.to_agent_id || event.toAgentId || event.to_agent_id || previousIssue.toAgentId || "",
    pendingOnAgentId,
    pendingOnHumanId: task.pending_on_human_id || previousIssue.pendingOnHumanId || null,
    relayStatus: task.status || previousIssue.relayStatus || "",
    relaySnapshotKey: relaySnapshotKey || previousIssue.relaySnapshotKey || "",
    localStatus: mergeRelayLocalStatus(previousIssue.localStatus),
    direction: inferIssueDirection(task, event),
    counterpartAgentId: inferCounterpartAgentId(task, event),
    lastEventId: eventId,
    eventIds,
    localWorkflowBinding: buildLocalWorkflowBinding({
      previousBinding: previousIssue.localWorkflowBinding,
      stateDir,
      taskId,
      eventId,
      projectPath,
      recordedAt
    }),
    projectPath,
    createdAt: previousIssue.createdAt || recordedAt,
    updatedAt: recordedAt
  };
  inbox.events[eventId] = {
    ...(inbox.events[eventId] || {}),
    eventId,
    taskId,
    type: event.type || event.eventType || event.event_type || "",
    status: "received",
    sourcePath: eventPath,
    receivedAt: payload.receivedAt || recordedAt,
    recordedAt: inbox.events[eventId]?.recordedAt || recordedAt
  };
  await writeJsonAtomic(inboxPath, inbox);
  return inbox;
}

function initialMessageSubject(payload) {
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : (Array.isArray(payload?.task?.messages) ? payload.task.messages : []);
  const first = [...messages].sort((left, right) => Number(left?.turn_sequence || 0) - Number(right?.turn_sequence || 0))[0];
  const structured = typeof first?.subject === "string" ? first.subject.trim() : "";
  return structured || legacySubjectFromParts(first?.parts);
}

function legacySubjectFromParts(parts) {
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.text !== "string") continue;
    const match = part.text.match(/^Subject\s*[:：]\s*(.+?)\s*$/imu);
    if (match?.[1]) return doneCriteriaTitle(match[1]);
  }
  return "";
}

function doneCriteriaTitle(value, maxLength = 120) {
  const text = typeof value === "string"
    ? value.trim()
    : (value && typeof value === "object" ? stableJson(value) : "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

async function recordDuplicateSnapshotEvent({ stateDir, payload, eventPath, taskId, eventId, now }) {
  const inboxPath = join(stateDir, "issues.json");
  const inbox = await readIssueInbox(inboxPath);
  const issue = inbox.issues[taskId];
  if (!issue) throw new Error(`Cannot record duplicate snapshot for missing issue: ${taskId}`);
  const recordedAt = now();
  inbox.issues[taskId] = {
    ...issue,
    eventIds: Array.from(new Set([...(issue.eventIds || []), eventId]))
  };
  inbox.events[eventId] = {
    eventId,
    taskId,
    type: payload.event?.type || payload.event?.eventType || payload.event?.event_type || "",
    status: "duplicate",
    sourcePath: eventPath,
    receivedAt: payload.receivedAt || recordedAt,
    recordedAt
  };
  await writeJsonAtomic(inboxPath, inbox);
}

function buildRelaySnapshotKey(taskId, task) {
  const goalVersion = task.goal_version ?? task.goalVersion;
  const updatedAt = task.updated_at ?? task.updatedAt;
  if (goalVersion === undefined && updatedAt === undefined) return "";
  const digest = crypto.createHash("sha256").update(stableJson(task)).digest("hex");
  return `${taskId}:${digest}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildLocalWorkflowBinding({ previousBinding, stateDir, taskId, eventId, projectPath, recordedAt }) {
  return {
    ...(previousBinding || {}),
    type: "local_inbox",
    workflow: "agentrelay_local_inbox",
    bindingId: previousBinding?.bindingId || `local-inbox:${taskId}`,
    issueId: taskId,
    taskId,
    statePath: resolve(stateDir, "issues.json"),
    projectPath: resolve(projectPath),
    lastEventId: eventId,
    userOwnedAdapter: true,
    createdAt: previousBinding?.createdAt || recordedAt,
    updatedAt: recordedAt
  };
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

async function markIssueEventAckFailed({ stateDir, eventId, error, now }) {
  const inboxPath = join(stateDir, "issues.json");
  const inbox = await readIssueInbox(inboxPath);
  if (!inbox.events[eventId]) return;
  inbox.events[eventId] = {
    ...inbox.events[eventId],
    ackStatus: "failed",
    ackError: error,
    ackFailedAt: now()
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
  const pendingOnAgentId = task.pending_on_agent_id || task.to_agent_id || event.toAgentId || event.to_agent_id || event.pendingOnAgentId || event.pending_on_agent_id || "";
  if (task.target_agent_id === localAgentId || pendingOnAgentId === localAgentId) return "incoming";
  return "unknown";
}

function mergeRelayLocalStatus(localStatus) {
  if (localStatus === "archived" || localStatus === "closed" || localStatus === "created_from_ui" || localStatus === "create_failed") {
    return localStatus;
  }
  return "received";
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

  async ackMessage({ agentId, messageId, payload }) {
    return this.request(
      "POST",
      `/workers/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/ack`,
      payload
    );
  }

  async failMessageDelivery({ agentId, messageId, payload }) {
    return this.request(
      "POST",
      `/workers/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/delivery-fail`,
      payload
    );
  }

  async ackInformationalEvent({ agentId, eventId, payload }) {
    return this.request(
      "POST",
      `/workers/${encodeURIComponent(agentId)}/events/${encodeURIComponent(eventId)}/ack`,
      payload
    );
  }

  async getTask(taskId) {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
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

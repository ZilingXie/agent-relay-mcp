#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_HOST = process.env.AGENTRELAY_INBOX_UI_HOST || "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.AGENTRELAY_INBOX_UI_PORT || "8787", 10);
const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const DEFAULT_CODEX_CLI = "/Applications/Codex.app/Contents/Resources/codex";
const PROTOCOL_VERSION = "agent-collab-v0.3";
const TASK_DRAFT_SCHEMA_PATH = resolve(PROJECT_ROOT, "schemas/task-draft.schema.json");
const TASK_DRAFT_SUBJECT_MAX_LENGTH = 32;
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(PROJECT_ROOT, ".env");
loadDotEnv(envPath);

export async function loadInboxSnapshot({
  stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state"),
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  now = () => new Date().toISOString()
} = {}) {
  const generatedAt = now();
  const inboxPath = join(stateRoot, "issues.json");
  if (!existsSync(inboxPath)) return emptySnapshot(generatedAt);

  const parsed = JSON.parse(await readFile(inboxPath, "utf8"));
  const eventsById = parsed.events || {};
  const issues = Object.values(parsed.issues || {})
    .map((issue) => normalizeIssue(issue, eventsById, { localAgentId }))
    .sort((a, b) => compareIsoDesc(a.updatedAt || a.createdAt, b.updatedAt || b.createdAt));

  return {
    version: parsed.version || 1,
    generatedAt,
    counts: countIssues(issues),
    issues
  };
}

export function createInboxUiServer({
  stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state"),
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  now = () => new Date().toISOString(),
  replyIdFactory = () => `hr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  draftIdFactory = () => `draft_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  processInbox = runDefaultProcessInbox,
  executeInboxAgent = runDefaultExecuteInboxAgent,
  taskDraftGenerator = runDefaultTaskDraftGenerator,
  relayClient = createDefaultRelayClient({ localAgentId })
} = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const replyMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/replies$/);
      if (req.method === "POST" && replyMatch) {
        const taskId = decodeURIComponent(replyMatch[1]);
        const result = await recordHumanReply({
          stateRoot,
          taskId,
          body: await readJsonRequest(req),
          now,
          replyIdFactory,
          localAgentId
        });
        sendJson(res, 201, {
          ...result,
          processorResult: { status: processInbox ? "scheduled" : "disabled" },
          executorResult: { status: executeInboxAgent ? "scheduled_after_processor" : "disabled" }
        });
        scheduleInboxProcessing({ stateRoot, processInbox, executeInboxAgent, now });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/task-drafts") {
        const result = await createTaskDraft({
          stateRoot,
          body: await readJsonRequest(req),
          localAgentId,
          draftIdFactory,
          taskDraftGenerator,
          now
        });
        sendJson(res, 201, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/task-requests") {
        const body = await readJsonRequest(req);
        const draftResult = await createTaskDraft({
          stateRoot,
          body,
          localAgentId,
          draftIdFactory,
          taskDraftGenerator,
          now
        });
        let result;
        try {
          result = await sendTaskDraft({
            stateRoot,
            draftId: draftResult.draft.draftId,
            localAgentId,
            relayClient,
            now
          });
        } catch (error) {
          const failure = await recordFailedTaskIssue({
            stateRoot,
            draft: draftResult.draft,
            localAgentId,
            error,
            now
          });
          sendJson(res, 502, {
            error: "task_create_failed",
            message: error.message,
            taskId: failure.issue.taskId,
            issue: failure.issue,
            draft: draftResult.draft,
            localRequest: {
              text: String(body?.text || "").trim(),
              status: "failed"
            }
          });
          return;
        }
        sendJson(res, result.alreadySent ? 200 : 201, {
          ...result,
          draft: result.draft,
          localRequest: {
            text: String(body?.text || "").trim(),
            status: "sent_to_relay"
          }
        });
        return;
      }

      const sendDraftMatch = url.pathname.match(/^\/api\/task-drafts\/([^/]+)\/send$/);
      if (req.method === "POST" && sendDraftMatch) {
        const draftId = decodeURIComponent(sendDraftMatch[1]);
        const result = await sendTaskDraft({
          stateRoot,
          draftId,
          localAgentId,
          relayClient,
          now
        });
        sendJson(res, result.alreadySent ? 200 : 201, result);
        return;
      }

      const deleteIssueMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
      if (req.method === "DELETE" && deleteIssueMatch) {
        const taskId = decodeURIComponent(deleteIssueMatch[1]);
        sendJson(res, 200, await deleteIssue({ stateRoot, taskId, now }));
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (url.pathname === "/api/agents") {
        sendJson(res, 200, await loadKnownAgents({ stateRoot, relayClient }));
        return;
      }

      if (url.pathname === "/api/issues") {
        sendJson(res, 200, await loadInboxSnapshot({ stateRoot, localAgentId, now }));
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
      if (detailMatch) {
        const snapshot = await loadInboxSnapshot({ stateRoot, localAgentId, now });
        const taskId = decodeURIComponent(detailMatch[1]);
        const issue = snapshot.issues.find((candidate) => candidate.taskId === taskId);
        if (!issue) {
          sendJson(res, 404, { error: "issue_not_found", taskId });
          return;
        }
        const detail = await loadIssueDetail({ stateRoot, taskId, issue, relayClient, localAgentId, now });
        if (detail.liveSynced && detail.issue?.pendingOnAgentId === localAgentId) {
          scheduleInboxProcessing({ stateRoot, processInbox, executeInboxAgent, now });
        }
        sendJson(res, 200, detail);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(res, INDEX_HTML);
        return;
      }

      if (url.pathname === "/dashboard") {
        sendHtml(res, DASHBOARD_HTML);
        return;
      }

      if (url.pathname === "/app.js") {
        sendText(res, 200, APP_JS, "application/javascript; charset=utf-8");
        return;
      }

      if (url.pathname === "/styles.css") {
        sendText(res, 200, STYLES_CSS, "text/css; charset=utf-8");
        return;
      }

      sendText(res, 404, "Not found\n", "text/plain; charset=utf-8");
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        error: statusCode >= 500 ? "server_error" : "request_error",
        message: error.message
      });
    }
  });
}

async function runDefaultProcessInbox(options) {
  const { processInbox } = await import("./agentrelay-inbox-processor.mjs");
  return processInbox(options);
}

async function runDefaultExecuteInboxAgent(options) {
  const { executeInboxAgent } = await import("./agentrelay-inbox-agent-executor.mjs");
  return executeInboxAgent(options);
}

async function runDefaultTaskDraftGenerator(options) {
  return generateTaskDraftWithCodex(options);
}

async function loadIssueDetail({
  stateRoot,
  taskId,
  issue,
  relayClient,
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  now = () => new Date().toISOString()
}) {
  const inboxPath = join(stateRoot, "issues.json");
  let parsed = JSON.parse(await readFile(inboxPath, "utf8"));
  let currentIssue = issue;
  let liveSynced = false;
  const liveRelayEvent = await fetchLiveRelayEvent({ taskId, relayClient, now });
  if (liveRelayEvent) {
    const syncResult = await persistLiveRelayEvent({ stateRoot, inbox: parsed, issue, liveRelayEvent, now });
    parsed = syncResult.inbox;
    currentIssue = syncResult.issue;
    liveSynced = syncResult.synced;
  }
  const eventsById = parsed.events || {};
  const eventIds = currentIssue.eventIds?.length ? currentIssue.eventIds : Object.values(eventsById)
    .filter((event) => event.taskId === taskId)
    .map((event) => event.eventId);
  const events = [];
  for (const eventId of eventIds) {
    const event = eventsById[eventId];
    if (!event) continue;
    events.push({
      ...event,
      raw: await readEventRaw(event.sourcePath)
    });
  }
  events.sort((a, b) => compareIsoDesc(a.receivedAt || a.recordedAt, b.receivedAt || b.recordedAt));
  const normalizedIssue = normalizeIssue(currentIssue, eventsById, { localAgentId });
  return { issue: normalizedIssue, events, timeline: buildChatTimeline({ issue: normalizedIssue, events }), liveSynced };
}

async function fetchLiveRelayEvent({ taskId, relayClient, now }) {
  if (!relayClient?.getTask) return null;
  try {
    const response = await relayClient.getTask(taskId);
    const task = response.task || response;
    if (!task || !(Array.isArray(task.messages) || Array.isArray(task.artifacts))) return null;
    const eventId = `relay-live-${taskId}-${hashRelayTask(task)}`;
    return {
      eventId,
      taskId,
      type: "relay.snapshot",
      status: "fetched",
      receivedAt: now(),
      raw: { task }
    };
  } catch {
    return null;
  }
}

async function persistLiveRelayEvent({ stateRoot, inbox, issue, liveRelayEvent, now }) {
  const eventId = liveRelayEvent.eventId;
  if (inbox.events?.[eventId]) {
    return { inbox, issue: inbox.issues?.[issue.taskId] || issue, synced: false };
  }
  const task = liveRelayEvent.raw?.task || {};
  const eventPath = join(stateRoot, "live-events", `${eventId}.json`);
  await writeJsonAtomic(eventPath, {
    receivedAt: liveRelayEvent.receivedAt,
    event: {
      eventId,
      type: liveRelayEvent.type,
      taskId: issue.taskId,
      agentId: issue.requesterAgentId || process.env.AGENTRELAY_AGENT_ID || "zac-agent"
    },
    task
  });

  const eventIds = Array.from(new Set([...(issue.eventIds || []), eventId]));
  const updatedIssue = {
    ...issue,
    taskId: issue.taskId,
    subject: task.subject || issue.subject || "",
    requesterAgentId: task.requester_agent_id || issue.requesterAgentId || "",
    targetAgentId: task.target_agent_id || issue.targetAgentId || "",
    completionOwnerAgentId: task.completion_owner_agent_id || issue.completionOwnerAgentId || "",
    pendingOnAgentId: task.pending_on_agent_id || issue.pendingOnAgentId || "",
    pendingOnHumanId: task.pending_on_human_id || issue.pendingOnHumanId || null,
    relayStatus: task.status || issue.relayStatus || "",
    localStatus: issue.localStatus === "closed" ? "closed" : "received",
    direction: issue.direction || inferIssueDirectionFromIssue(task, issue),
    counterpartAgentId: issue.counterpartAgentId || inferCounterpartFromIssue(task, issue),
    lastEventId: eventId,
    eventIds,
    updatedAt: liveRelayEvent.receivedAt || now()
  };
  inbox.version = 1;
  inbox.issues = { ...(inbox.issues || {}), [issue.taskId]: updatedIssue };
  inbox.events = {
    ...(inbox.events || {}),
    [eventId]: {
      eventId,
      taskId: issue.taskId,
      type: liveRelayEvent.type,
      status: "received",
      ackStatus: "not_applicable",
      sourcePath: eventPath,
      receivedAt: liveRelayEvent.receivedAt || now(),
      recordedAt: now()
    }
  };
  await writeJsonAtomic(join(stateRoot, "issues.json"), inbox);
  return { inbox, issue: updatedIssue, synced: true };
}

function hashRelayTask(task) {
  return createHash("sha256")
    .update(JSON.stringify(task))
    .digest("hex")
    .slice(0, 12);
}

function inferCounterpartFromIssue(task, issue) {
  const localAgentId = issue.requesterAgentId || process.env.AGENTRELAY_AGENT_ID || "zac-agent";
  if (task.requester_agent_id && task.requester_agent_id !== localAgentId) return task.requester_agent_id;
  if (task.target_agent_id && task.target_agent_id !== localAgentId) return task.target_agent_id;
  return task.requester_agent_id || task.target_agent_id || "";
}

function inferIssueDirectionFromIssue(task, issue) {
  const localAgentId = issue.requesterAgentId || process.env.AGENTRELAY_AGENT_ID || "zac-agent";
  if (task.requester_agent_id === localAgentId) return "outgoing";
  if (task.target_agent_id === localAgentId || task.pending_on_agent_id === localAgentId) return "incoming";
  return "unknown";
}

async function recordHumanReply({ stateRoot, taskId, body, now, replyIdFactory, localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" }) {
  const text = String(body?.text || "").trim();
  if (!text) {
    const error = new Error("reply text is required");
    error.statusCode = 400;
    throw error;
  }
  if (text.length > 10000) {
    const error = new Error("reply text is too long");
    error.statusCode = 413;
    throw error;
  }

  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInboxFile(inboxPath);
  const issue = inbox.issues?.[taskId];
  if (!issue) {
    const error = new Error(`issue not found: ${taskId}`);
    error.statusCode = 404;
    throw error;
  }

  const createdAt = now();
  const humanReply = {
    replyId: replyIdFactory(),
    taskId,
    text,
    createdAt,
    processedAt: null
  };
  const humanReplies = [...normalizeHumanReplies(issue.humanReplies), humanReply];
  inbox.issues[taskId] = {
    ...issue,
    humanReplies,
    latestHumanReplyId: humanReply.replyId,
    humanReplyStatus: "pending_processor",
    updatedAt: createdAt
  };
  await writeJsonAtomic(inboxPath, inbox);

  const detailSnapshot = await loadInboxSnapshot({ stateRoot, localAgentId, now });
  const updatedIssue = detailSnapshot.issues.find((candidate) => candidate.taskId === taskId);
  return { humanReply, issue: updatedIssue || inbox.issues[taskId] };
}

async function deleteIssue({ stateRoot, taskId, now }) {
  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInboxFile(inboxPath);
  const issue = inbox.issues?.[taskId];
  if (!issue) throw statusError(`issue not found: ${taskId}`, 404);
  delete inbox.issues[taskId];
  inbox.deletedIssues = {
    ...(inbox.deletedIssues || {}),
    [taskId]: {
      taskId,
      subject: issue.subject || "",
      deletedAt: now()
    }
  };
  await writeJsonAtomic(inboxPath, inbox);
  return { status: "deleted", taskId };
}

function scheduleInboxProcessing({ stateRoot, processInbox, executeInboxAgent, now }) {
  if (!processInbox && !executeInboxAgent) return;
  setImmediate(async () => {
    const startedAt = now();
    try {
      if (processInbox) await processInbox({ stateRoot });
      if (executeInboxAgent) await executeInboxAgent({ stateRoot });
      await appendJsonl(join(stateRoot, "ui-background-runs.jsonl"), {
        at: startedAt,
        status: "completed"
      });
    } catch (error) {
      await appendJsonl(join(stateRoot, "ui-background-errors.jsonl"), {
        at: startedAt,
        status: "failed",
        error: error.message
      });
    }
  });
}

async function readEventRaw(sourcePath) {
  if (!sourcePath) return null;
  try {
    return JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (error) {
    return { unavailable: true, error: error.message };
  }
}

function normalizeIssue(issue, eventsById, { localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" } = {}) {
  const eventIds = Array.from(new Set(issue.eventIds || []));
  const eventList = eventIds.map((eventId) => eventsById[eventId]).filter(Boolean);
  const latestEvent = chooseLatestEvent(issue, eventList);
  return {
    taskId: issue.taskId || "",
    subject: issue.subject || "(untitled)",
    direction: issue.direction || "unknown",
    counterpartAgentId: issue.counterpartAgentId || "",
    requesterAgentId: issue.requesterAgentId || "",
    targetAgentId: issue.targetAgentId || "",
    completionOwnerAgentId: issue.completionOwnerAgentId || "",
    pendingOnAgentId: issue.pendingOnAgentId || "",
    pendingOnHumanId: issue.pendingOnHumanId || null,
    relayStatus: issue.relayStatus || "",
    localStatus: issue.localStatus || "",
    processorStatus: issue.processorStatus || "",
    processorSummary: issue.processorSummary || "",
    processorSuggestedReply: issue.processorSuggestedReply || "",
    processorNeedsHumanReason: issue.processorNeedsHumanReason || "",
    processorSource: issue.processorSource || "",
    processorError: issue.processorError || null,
    processorLastRunAt: issue.processorLastRunAt || "",
    processorLastEventId: issue.processorLastEventId || "",
    processorLastHumanReplyId: issue.processorLastHumanReplyId || "",
    processorActionIntent: issue.processorActionIntent || "none",
    processorActionReason: issue.processorActionReason || "",
    processorTerminalReason: issue.processorTerminalReason || "",
    processorArtifactKind: issue.processorArtifactKind || "",
    processorArtifactText: issue.processorArtifactText || "",
    executorStatus: issue.executorStatus || "",
    executorActionIntent: issue.executorActionIntent || "",
    executorArtifactId: issue.executorArtifactId || "",
    executorLastHumanReplyId: issue.executorLastHumanReplyId || "",
    executorLastRunAt: issue.executorLastRunAt || "",
    executorError: issue.executorError || null,
    terminalReason: issue.terminalReason || "",
    requiresHumanConfirmation: Boolean(issue.requiresHumanConfirmation),
    humanReplies: normalizeHumanReplies(issue.humanReplies),
    localActions: normalizeLocalActions(issue.localActions),
    latestHumanReplyId: issue.latestHumanReplyId || "",
    humanReplyStatus: issue.humanReplyStatus || "",
    projectPath: issue.projectPath || "",
    lastEventId: issue.lastEventId || latestEvent?.eventId || "",
    eventIds,
    eventCount: eventIds.length,
    latestEvent,
    needsHuman: needsHumanAttention(issue, { localAgentId }),
    createdAt: issue.createdAt || "",
    updatedAt: issue.updatedAt || issue.createdAt || ""
  };
}

function normalizeHumanReplies(humanReplies) {
  return Array.isArray(humanReplies)
    ? humanReplies
      .filter((reply) => reply && typeof reply === "object")
      .map((reply) => ({
        replyId: String(reply.replyId || ""),
        taskId: String(reply.taskId || ""),
        text: String(reply.text || ""),
        createdAt: String(reply.createdAt || ""),
        processedAt: reply.processedAt || null
      }))
    : [];
}

function normalizeLocalActions(localActions) {
  return Array.isArray(localActions)
    ? localActions
      .filter((action) => action && typeof action === "object")
      .map((action) => ({
        actionId: String(action.actionId || ""),
        type: String(action.type || "local_action"),
        status: String(action.status || ""),
        draftId: String(action.draftId || ""),
        taskId: String(action.taskId || ""),
        text: String(action.text || ""),
        error: String(action.error || ""),
        createdAt: String(action.createdAt || "")
      }))
    : [];
}

function needsHumanAttention(issue, { localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" } = {}) {
  if (issue.relayStatus === "completed" || issue.localStatus === "closed") return false;
  if (issue.pendingOnHumanId) return true;
  if (issue.humanReplyStatus === "pending_processor") return true;
  if (issue.executorStatus === "failed") return true;
  if (issue.pendingOnAgentId && issue.pendingOnAgentId !== localAgentId) return false;
  if (issue.requiresHumanConfirmation) return true;
  return issue.processorStatus === "needs_human" || issue.processorStatus === "ready_to_reply";
}

function chooseLatestEvent(issue, eventList) {
  const lastEvent = eventList.find((event) => event.eventId === issue.lastEventId);
  if (lastEvent) return summarizeEvent(lastEvent);
  const sorted = [...eventList].sort((a, b) => compareIsoDesc(a.receivedAt || a.recordedAt, b.receivedAt || b.recordedAt));
  return sorted[0] ? summarizeEvent(sorted[0]) : null;
}

function summarizeEvent(event) {
  return {
    eventId: event.eventId || "",
    type: event.type || "",
    status: event.status || "",
    ackStatus: event.ackStatus || "",
    receivedAt: event.receivedAt || "",
    recordedAt: event.recordedAt || "",
    sourcePath: event.sourcePath || ""
  };
}

function countIssues(issues) {
  return {
    total: issues.length,
    incoming: issues.filter((issue) => issue.direction === "incoming").length,
    outgoing: issues.filter((issue) => issue.direction === "outgoing").length,
    needsHuman: issues.filter((issue) => issue.needsHuman).length,
    closed: issues.filter((issue) => issue.relayStatus === "completed" || issue.localStatus === "closed").length
  };
}

export function classifyIssueFilter(issue, filter, { localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" } = {}) {
  if (filter === "all") return true;
  if (filter === "needs") return issueWorkflowStatus(issue, { localAgentId }) === "need approval";
  if (filter === "pending_human") return issueWorkflowStatus(issue, { localAgentId }) === "need approval";
  if (filter === "completed") return issueWorkflowStatus(issue, { localAgentId }) === "complete";
  if (filter === "complete") return issueWorkflowStatus(issue, { localAgentId }) === "complete";
  if (filter === "pending_remote") return issueWorkflowStatus(issue, { localAgentId }) === "pending";
  return true;
}

export function issueWorkflowStatus(issue, { localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" } = {}) {
  if (issue.relayStatus === "completed" || issue.localStatus === "closed") return "complete";
  if (issue.needsHuman) return "need approval";
  return "pending";
}

function emptySnapshot(generatedAt) {
  return {
    version: 1,
    generatedAt,
    counts: {
      total: 0,
      incoming: 0,
      outgoing: 0,
      needsHuman: 0,
      closed: 0
    },
    issues: []
  };
}

export function buildChatTimeline({ issue, events, localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent" }) {
  const items = [];
  const seenRelayItems = new Set();
  for (const event of [...events].reverse()) {
    const task = event.raw?.task || {};
    for (const message of Array.isArray(task.messages) ? task.messages : []) {
      const from = message.from_agent_id || "unknown";
      const to = message.to_agent_id || "unknown";
      const text = extractPartsText(message.parts) || message.text || "";
      const relayKey = message.message_id
        ? `message:${message.message_id}`
        : ["message", from, to, message.created_at || "", text].join("\u0000");
      if (seenRelayItems.has(relayKey)) continue;
      seenRelayItems.add(relayKey);
      items.push({
        type: "relay_message",
        at: message.created_at ? new Date(Number(message.created_at) * 1000).toISOString() : (event.receivedAt || ""),
        title: `${from} -> ${to}`,
        speaker: speakerForRelayAgent(from, localAgentId),
        from,
        to,
        side: from === localAgentId ? "local" : "remote",
        text,
        role: message.role || ""
      });
    }
    for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
      const from = artifact.from_agent_id || "unknown";
      const to = artifact.to_agent_id || "unknown";
      const text = humanizeArtifactText(extractPartsText(artifact.parts)) || `${from} returned an artifact, but no text content was included.`;
      const relayKey = artifact.artifact_id
        ? `artifact:${artifact.artifact_id}`
        : ["artifact", from, to, artifact.created_at || "", text].join("\u0000");
      if (seenRelayItems.has(relayKey)) continue;
      seenRelayItems.add(relayKey);
      items.push({
        type: "artifact",
        at: artifact.created_at ? new Date(Number(artifact.created_at) * 1000).toISOString() : (event.receivedAt || ""),
        title: `${from} artifact`,
        speaker: speakerForRelayAgent(from, localAgentId),
        from,
        to,
        side: from === localAgentId ? "local" : "remote",
        text,
        artifactId: artifact.artifact_id || "",
        kind: artifact.kind || ""
      });
    }
  }
  for (const reply of issue.humanReplies || []) {
    items.push({
      type: "local_reply",
      at: reply.createdAt || "",
      title: "Zac local reply",
      speaker: "Zac",
      side: "local",
      text: reply.text || "",
      replyId: reply.replyId || ""
    });
  }
  if (issue.processorStatus) {
    items.push({
      type: "processor",
      at: issue.processorLastRunAt || "",
      title: `Processor: ${issue.processorStatus}`,
      speaker: "Agent",
      side: "remote",
      text: processorChatText(issue),
      actionIntent: issue.processorActionIntent || "none"
    });
  }
  if (issue.executorStatus) {
    items.push({
      type: "executor",
      at: issue.executorLastRunAt || "",
      title: `Executor: ${issue.executorStatus}`,
      speaker: "Executor",
      side: "system",
      text: issue.executorError || issue.terminalReason || issue.executorActionIntent || "",
      actionIntent: issue.executorActionIntent || ""
    });
  }
  for (const action of issue.localActions || []) {
    if (action.type === "zac_local_request") {
      items.push({
        type: "local_request",
        at: action.createdAt || "",
        title: "Zac request",
        speaker: "Zac",
        side: "local",
        text: action.text || "",
        actionId: action.actionId || "",
        status: action.status || "",
        failed: action.status === "failed",
        error: action.error || ""
      });
      continue;
    }
    items.push({
      type: "local_action",
      at: action.createdAt || "",
      title: action.type || "Local action",
      speaker: "Local UI",
      side: "system",
      text: action.text || action.status || "",
      actionId: action.actionId || "",
      draftId: action.draftId || "",
      status: action.status || "",
      error: action.error || ""
    });
  }
  return items.sort(compareTimelineItems);
}

function compareTimelineItems(a, b) {
  const aTime = Date.parse(a.at || "");
  const bTime = Date.parse(b.at || "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    if (isLocalRequestBeforeAgentRelayPair(a, b) && Math.abs(aTime - bTime) < 1000) return -1;
    if (isLocalRequestBeforeAgentRelayPair(b, a) && Math.abs(aTime - bTime) < 1000) return 1;
    if (aTime !== bTime) return aTime - bTime;
  }
  return String(a.at || "").localeCompare(String(b.at || ""));
}

function isLocalRequestBeforeAgentRelayPair(first, second) {
  return first?.type === "local_request" &&
    second?.type === "relay_message" &&
    second?.side === "local";
}

function processorChatText(issue) {
  if (issue.processorStatus === "failed") {
    return [
      "我收到了新的 AgentRelay 回复，但本地 LLM processor 这次没有成功完成判断。",
      "请稍后重试本地处理，或直接告诉我下一步要回复、继续等待，还是确认关闭这个 task。"
    ].join("\n\n");
  }
  if (issue.requiresHumanConfirmation || issue.processorStatus === "needs_human" || issue.processorStatus === "ready_to_reply") {
    return [
      issue.processorSummary || "",
      issue.processorSuggestedReply ? `建议回复：${issue.processorSuggestedReply}` : "",
      issue.processorNeedsHumanReason || "请确认下一步怎么处理。"
    ].filter(Boolean).join("\n\n");
  }
  return issue.processorSummary || "";
}

function speakerForRelayAgent(agentId, localAgentId) {
  return agentId === localAgentId ? "Agent" : agentId;
}

function extractPartsText(parts) {
  return Array.isArray(parts)
    ? parts
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    : "";
}

function humanizeArtifactText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  const jsonCandidate = extractEmbeddedJsonCandidate(text);
  const parsed = parseEmbeddedJson(jsonCandidate);
  if (parsed) {
    const embeddedText = extractArtifactPayloadText(parsed);
    if (embeddedText) return embeddedText;
  }
  if (jsonCandidate) {
    const jsonishText = extractJsonishField(jsonCandidate, "text") || extractJsonishField(jsonCandidate, "summary");
    if (jsonishText) return jsonishText;
  }
  const withoutJsonFence = text.replace(/```json\s*[\s\S]*?```/gi, "").trim();
  return withoutJsonFence || text;
}

function extractEmbeddedJsonCandidate(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : (text.startsWith("{") && text.endsWith("}") ? text : "");
}

function parseEmbeddedJson(candidate) {
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function extractArtifactPayloadText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const partsText = extractPartsText(payload.parts);
  if (partsText) return partsText;
  for (const key of ["text", "message", "summary", "result"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
  }
  return "";
}

function extractJsonishField(candidate, fieldName) {
  const fieldPattern = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|\\n\\s*}\\s*(?:\\n\\s*\\]|,))`, "i");
  const match = candidate.match(fieldPattern);
  return match ? decodeJsonishString(match[1]).trim() : "";
}

function decodeJsonishString(value) {
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareIsoDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

export function isMainModulePath(moduleUrl, argvPath = process.argv[1], cwd = process.cwd()) {
  if (!argvPath) return false;
  return resolve(cwd, argvPath) === fileURLToPath(moduleUrl);
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function sendHtml(res, html) {
  sendText(res, 200, html, "text/html; charset=utf-8");
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJsonRequest(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (body.length > 20000) {
      const error = new Error("request body is too large");
      error.statusCode = 413;
      throw error;
    }
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("request body must be JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function readInboxFile(path) {
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

async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "a", mode: 0o600 });
}

async function loadKnownAgents({ stateRoot, relayClient }) {
  try {
    const response = await relayClient.listAgents();
    const agents = normalizeAgentList(response);
    if (agents.length) return { source: "relay", agents };
  } catch (error) {
    const fallback = await loadAgentsFromInbox({ stateRoot });
    return { source: "local_fallback", error: error.message, agents: fallback };
  }
  return { source: "local_fallback", agents: await loadAgentsFromInbox({ stateRoot }) };
}

function normalizeAgentList(response) {
  const values = Array.isArray(response)
    ? response
    : Array.isArray(response?.agents)
      ? response.agents
      : Array.isArray(response?.data)
        ? response.data
        : [];
  return values
    .map((agent) => {
      if (typeof agent === "string") return { agentId: agent, label: agent };
      const agentId = agent.agent_id || agent.agentId || agent.id || "";
      return agentId ? { agentId, label: agent.name || agent.displayName || agentId } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

async function loadAgentsFromInbox({ stateRoot }) {
  const inbox = await readInboxFile(join(stateRoot, "issues.json"));
  const ids = new Set();
  for (const issue of Object.values(inbox.issues || {})) {
    for (const id of [
      issue.requesterAgentId,
      issue.targetAgentId,
      issue.counterpartAgentId,
      issue.pendingOnAgentId,
      issue.completionOwnerAgentId
    ]) {
      if (id) ids.add(id);
    }
  }
  return Array.from(ids).sort().map((agentId) => ({ agentId, label: agentId }));
}

async function createTaskDraft({
  stateRoot,
  body,
  localAgentId,
  draftIdFactory,
  taskDraftGenerator,
  now
}) {
  const to = String(body?.to || "").trim();
  const text = String(body?.text || "").trim();
  const subject = String(body?.subject || "").trim();
  if (!text) throw statusError("task text is required", 400);
  if (text.length > 12000) throw statusError("task text is too long", 413);

  const generated = await taskDraftGenerator({ to, text, subject, localAgentId });
  const draft = validateTaskDraft({
    ...generated,
    to: generated.to || to,
    from: localAgentId,
    completionOwnerAgentId: localAgentId
  });
  const createdAt = now();
  const draftId = draftIdFactory();
  const record = {
    draftId,
    status: "drafted",
    sourceText: text,
    sourceSubject: subject,
    ...draft,
    createdAt,
    updatedAt: createdAt
  };

  const draftPath = join(stateRoot, "task-drafts.json");
  const draftState = await readTaskDrafts(draftPath);
  draftState.drafts[draftId] = record;
  await writeJsonAtomic(draftPath, draftState);
  return { draft: record };
}

async function sendTaskDraft({ stateRoot, draftId, localAgentId, relayClient, now }) {
  const draftPath = join(stateRoot, "task-drafts.json");
  const draftState = await readTaskDrafts(draftPath);
  const draft = draftState.drafts?.[draftId];
  if (!draft) throw statusError(`task draft not found: ${draftId}`, 404);
  if (draft.status === "sent" && draft.taskId) {
    return { alreadySent: true, draft, taskId: draft.taskId };
  }

  const requesterThreadId = draft.requesterThreadId || `agentrelay-local-ui-${draftId}`;
  const requesterAgentId = draft.from || localAgentId;
  const targetAgentId = draft.to;
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: `local-ui-create-${draftId}`,
    task_type: "agent.task",
    requester_agent_id: requesterAgentId,
    target_agent_id: targetAgentId,
    from: requesterAgentId,
    to: targetAgentId,
    requesterThreadId,
    subject: draft.subject,
    message: buildRelayMessage(draft.requestText, requesterAgentId),
    requestText: draft.requestText,
    done_criteria: draft.doneCriteria,
    doneCriteria: draft.doneCriteria,
    completion_owner_agent_id: requesterAgentId,
    completionOwnerAgentId: requesterAgentId,
    pending_on_agent_id: targetAgentId,
    pendingOnAgentId: targetAgentId,
    next_action: `${targetAgentId} should process the request and return an artifact.`,
    humanBoundaryReason: draft.humanBoundaryReason,
    humanBoundary: draft.humanBoundaryReason
      ? { requiresHuman: true, reason: draft.humanBoundaryReason }
      : undefined
  };
  const response = await relayClient.createTask(payload);
  const { task, taskId } = extractCreatedTask(response);
  if (!taskId) {
    throw new Error(`AgentRelay create task response is missing task id (${describeResponseShape(response)})`);
  }

  const updatedAt = now();
  const sentDraft = {
    ...draft,
    status: "sent",
    requesterThreadId,
    taskId,
    sentAt: updatedAt,
    updatedAt
  };
  draftState.drafts[draftId] = sentDraft;
  await writeJsonAtomic(draftPath, draftState);
  await recordOutgoingTaskIssue({
    stateRoot,
    draft: sentDraft,
    task,
    taskId,
    localAgentId,
    now: () => updatedAt
  });
  return { alreadySent: false, draft: sentDraft, taskId, task };
}

function buildRelayMessage(text, actorAgentId) {
  return {
    actor_agent_id: actorAgentId,
    intent: "request",
    parts: [{ kind: "text", text: String(text || "") }]
  };
}

function extractCreatedTask(response) {
  const candidates = [
    response?.task,
    response?.data?.task,
    response?.result?.task,
    response?.createdTask,
    response?.data?.createdTask,
    response?.result?.createdTask,
    response?.data,
    response?.result,
    response
  ].filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  for (const candidate of candidates) {
    const taskId = candidate.task_id || candidate.taskId || candidate.id;
    if (taskId) return { task: candidate, taskId };
  }
  return { task: candidates[0] || {}, taskId: "" };
}

function describeResponseShape(response) {
  if (!response || typeof response !== "object") return `response type: ${typeof response}`;
  const segments = [`response keys: ${Object.keys(response).join(", ") || "(none)"}`];
  for (const key of ["task", "data", "result", "createdTask"]) {
    const value = response[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      segments.push(`${key} keys: ${Object.keys(value).join(", ") || "(none)"}`);
    }
  }
  return segments.join("; ");
}

async function recordOutgoingTaskIssue({ stateRoot, draft, task, taskId, localAgentId, now }) {
  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInboxFile(inboxPath);
  const previousIssue = inbox.issues?.[taskId] || {};
  const createdAt = previousIssue.createdAt || now();
  const localRequestAction = {
    actionId: `la_${draft.draftId}_zac_request`,
    type: "zac_local_request",
    status: "sent",
    draftId: draft.draftId,
    taskId,
    text: draft.sourceText || draft.requestText || "",
    createdAt: draft.createdAt || now()
  };
  const action = {
    actionId: `la_${draft.draftId}_sent`,
    type: "task_created_from_ui",
    status: "completed",
    draftId: draft.draftId,
    taskId,
    text: `Created AgentRelay task for ${draft.to}.`,
    createdAt: now()
  };
  inbox.issues[taskId] = {
    ...previousIssue,
    taskId,
    subject: task.subject || draft.subject || previousIssue.subject || "",
    requesterAgentId: task.requester_agent_id || draft.from || localAgentId,
    targetAgentId: task.target_agent_id || draft.to,
    completionOwnerAgentId: task.completion_owner_agent_id || draft.completionOwnerAgentId || localAgentId,
    pendingOnAgentId: task.pending_on_agent_id || draft.to,
    pendingOnHumanId: task.pending_on_human_id || null,
    relayStatus: task.status || "submitted",
    localStatus: "created_from_ui",
    direction: "outgoing",
    counterpartAgentId: draft.to,
    createdAt,
    updatedAt: now(),
    localActions: mergeLocalActions(previousIssue.localActions, [localRequestAction, action])
  };
  await writeJsonAtomic(inboxPath, inbox);
}

async function recordFailedTaskIssue({ stateRoot, draft, localAgentId, error, now }) {
  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInboxFile(inboxPath);
  const taskId = `local_${draft.draftId}`;
  const previousIssue = inbox.issues?.[taskId] || {};
  const createdAt = previousIssue.createdAt || draft.createdAt || now();
  const localRequestAction = {
    actionId: `la_${draft.draftId}_zac_request`,
    type: "zac_local_request",
    status: "failed",
    draftId: draft.draftId,
    taskId,
    text: draft.sourceText || draft.requestText || "",
    error: error.message,
    createdAt
  };
  const failedAction = {
    actionId: `la_${draft.draftId}_failed`,
    type: "task_create_failed",
    status: "failed",
    draftId: draft.draftId,
    taskId,
    text: "AgentRelay task creation failed.",
    error: error.message,
    createdAt: now()
  };
  const issue = {
    ...previousIssue,
    taskId,
    subject: draft.subject || previousIssue.subject || "Failed AgentRelay task",
    requesterAgentId: draft.from || localAgentId,
    targetAgentId: draft.to || "",
    completionOwnerAgentId: draft.completionOwnerAgentId || localAgentId,
    pendingOnAgentId: "",
    pendingOnHumanId: "zac",
    relayStatus: "failed",
    localStatus: "create_failed",
    direction: "outgoing",
    counterpartAgentId: draft.to || "",
    createdAt,
    updatedAt: now(),
    localActions: mergeLocalActions(previousIssue.localActions, [localRequestAction, failedAction])
  };
  inbox.issues[taskId] = issue;
  await writeJsonAtomic(inboxPath, inbox);
  const snapshot = await loadInboxSnapshot({ stateRoot, localAgentId, now });
  return { issue: snapshot.issues.find((candidate) => candidate.taskId === taskId) || issue };
}

function mergeLocalActions(existingActions, nextActions) {
  const byId = new Map();
  for (const action of [...normalizeLocalActions(existingActions), ...normalizeLocalActions(nextActions)]) {
    if (!action.actionId) continue;
    byId.set(action.actionId, action);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

async function readTaskDrafts(path) {
  if (!existsSync(path)) return { version: 1, drafts: {} };
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    version: parsed.version || 1,
    drafts: parsed.drafts || {}
  };
}

function validateTaskDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task draft must be an object");
  const draft = {
    subject: limitTitle(String(value.subject || "").trim()),
    requestText: String(value.requestText || "").trim(),
    doneCriteria: String(value.doneCriteria || "").trim(),
    humanBoundaryReason: String(value.humanBoundaryReason || "").trim(),
    to: String(value.to || "").trim(),
    from: String(value.from || "").trim(),
    completionOwnerAgentId: String(value.completionOwnerAgentId || "").trim()
  };
  for (const field of ["subject", "requestText", "doneCriteria", "humanBoundaryReason", "to", "from", "completionOwnerAgentId"]) {
    if (!draft[field]) throw new Error(`task draft is missing ${field}`);
  }
  return draft;
}

async function generateTaskDraftWithCodex({
  to,
  text,
  subject = "",
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  agentsMdPath = resolve(PROJECT_ROOT, "AGENTS.md"),
  schemaPath = TASK_DRAFT_SCHEMA_PATH,
  codexCli = process.env.CODEX_CLI || DEFAULT_CODEX_CLI,
  cwd = PROJECT_ROOT,
  timeoutMs = Number(process.env.AGENTRELAY_TASK_DRAFT_CODEX_TIMEOUT_MS || 120000),
  codexRunner = runCodexDraftExec
}) {
  const agentsMd = await readFile(agentsMdPath, "utf8").catch(() => "");
  const prompt = buildTaskDraftPrompt({ agentsMd, to, text, subject, localAgentId });
  const rawOutput = await codexRunner({ prompt, schemaPath, codexCli, cwd, timeoutMs });
  return validateTaskDraft(parseJsonObject(rawOutput));
}

function buildTaskDraftPrompt({ agentsMd, to, text, subject, localAgentId }) {
  return [
    "You are Zac's local AgentRelay task draft generator.",
    "",
    "Follow this workspace AGENTS.md exactly:",
    "```markdown",
    agentsMd || "(AGENTS.md unavailable)",
    "```",
    "",
    "Constraints:",
    "- Do not call tools.",
    "- Do not run terminal commands.",
    "- Do not use AgentRelay MCP.",
    "- Do not send anything externally.",
    "- Convert Zac's local natural-language request into a clear AgentRelay task draft.",
    "- Choose the target remote agent id yourself when Zac did not provide one. Use exact agent ids when present in the request, such as project-hermes, frank-agent, or vivi-agent.",
    `- Always set from to ${localAgentId}.`,
    `- Always set completionOwnerAgentId to ${localAgentId}; the local Zac agent must evaluate remote artifacts and close the task.`,
    `- Keep subject at ${TASK_DRAFT_SUBJECT_MAX_LENGTH} characters or fewer so the local inbox can show timestamps clearly.`,
    "- Preserve concrete file paths, URLs, exact text, agent ids, and verification requirements.",
    "- Do not add commitments, deadlines, private data, or claims that Zac did not provide.",
    "- Return only JSON matching the provided schema.",
    "",
    `Local agent id: ${localAgentId}`,
    `Target agent id: ${to || "(infer from Zac's request)"}`,
    `Optional subject from Zac: ${subject || "(none)"}`,
    "",
    "Zac's local request:",
    "```text",
    text,
    "```",
    "",
    "Return fields: subject, requestText, doneCriteria, humanBoundaryReason, to, from, completionOwnerAgentId."
  ].join("\n");
}

function limitTitle(value, maxLength = TASK_DRAFT_SUBJECT_MAX_LENGTH) {
  const title = String(value || "").trim();
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength).trimEnd();
}

async function runCodexDraftExec({ prompt, schemaPath, codexCli, cwd, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(codexCli, [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "-C",
      cwd,
      "-"
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(`codex exec exited with ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolveRun(stdout);
    });
    child.stdin.end(prompt);
  });
}

function parseJsonObject(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("codex returned empty output");
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error("codex output was not JSON");
    }
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }
}

function createDefaultRelayClient({ localAgentId }) {
  return new AgentRelayUiHttpClient({
    baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
    token: process.env.AGENTRELAY_TOKEN || "",
    agentId: localAgentId,
    username: process.env.AGENTRELAY_USERNAME || ""
  });
}

class AgentRelayUiHttpClient {
  constructor({ baseUrl, token, agentId, username }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.agentId = agentId;
    this.username = username;
  }

  async listAgents() {
    return this.request("GET", "/agents");
  }

  async getTask(taskId) {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async createTask(payload) {
    return this.request("POST", "/tasks", payload);
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

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

const INDEX_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentRelay Workbench</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app-shell">
    <aside class="conversation-pane" aria-label="Task conversations">
      <div class="pane-head">
        <div>
          <h1>AgentRelay</h1>
          <p id="freshness">Loading local inbox...</p>
        </div>
        <div class="pane-actions">
          <button id="new-task" class="icon-button icon-only" type="button" title="New task" aria-label="New task">+</button>
          <button id="refresh" class="icon-button icon-only" type="button" title="Refresh now" aria-label="Refresh now">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8.4"/><path d="M5.5 15a7 7 0 0 0 12.3 2.8L20 15.6"/></svg>
          </button>
        </div>
      </div>
      <div class="list-tools">
        <input id="search" type="search" placeholder="Search tasks or agents" autocomplete="off" />
        <button id="show-completed" class="toggle-button" type="button" aria-pressed="false">Show Completed</button>
      </div>
      <div id="issues" class="issues"></div>
    </aside>

    <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-label="Resize conversation list" aria-orientation="vertical" tabindex="0"></div>

    <main class="workspace">
      <button class="theme-toggle" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">◐</button>
      <section id="inbox-view" class="view active" aria-label="Task chat">
        <div id="detail-empty" class="empty-state">
          <h2>Select a task</h2>
          <p>Incoming requests, outgoing work, Zac replies, and agent messages appear here as one readable conversation.</p>
        </div>
        <div id="detail-body" class="chat-view" hidden></div>
      </section>

      <section id="new-view" class="view" aria-label="New task">
        <div class="chat-view new-chat">
          <header class="chat-head">
            <div class="chat-title-row">
              <div>
                <h2>New AgentRelay Task</h2>
                <div class="chat-meta">local agent · new conversation</div>
              </div>
            </div>
          </header>
          <section class="messages new-task-empty" id="new-task-messages">
            <div class="empty-state">
              <h2>Start with a request</h2>
              <p>Tell the local agent what you need. It will prepare and route the AgentRelay task.</p>
            </div>
          </section>
          <form class="composer" id="draft-form">
            <div class="composer-input">
              <textarea id="draft-text" name="text" placeholder="告诉本地 agent 你想做什么，例如：让 project-hermes 修改 dashboard 标题并回报验证结果..." required></textarea>
              <button class="send-button" type="submit" title="Send" aria-label="Send">↑</button>
            </div>
            <span id="draft-status" class="status-text" aria-live="polite"></span>
          </form>
        </div>
      </section>
    </main>
  </div>

  <script type="module" src="/app.js"></script>
</body>
</html>
`;

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentRelay Dashboard</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body data-page="dashboard">
  <main class="dashboard-shell">
    <button class="theme-toggle" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">◐</button>
    <section id="dashboard-view" class="view active" aria-label="Dashboard">
      <div class="dashboard-page">
        <header class="page-head">
          <div>
            <h2>Dashboard</h2>
            <p>Operational view kept for raw inspection and local state debugging.</p>
          </div>
          <a class="text-link" href="/">Back to inbox</a>
        </header>
        <div class="metrics" id="metrics"></div>
        <div id="dashboard-detail" class="dashboard-detail"></div>
      </div>
    </section>
  </main>

  <script type="module" src="/app.js"></script>
</body>
</html>
`;

const STYLES_CSS = String.raw`:root {
  color-scheme: dark;
  --sidebar-width: 390px;
  --bg: #151515;
  --pane: #242424;
  --surface: #1b1b1b;
  --surface-2: #2d2d2d;
  --surface-3: #373737;
  --line: #3b3b3b;
  --text: #f0f0ee;
  --muted: #a6a6a1;
  --subtle: #74746f;
  --accent: #4f8cff;
  --accent-2: #28a06a;
  --warn: #d79031;
  --bad: #ff6b6b;
  --bubble-zac: #2f5f46;
  --bubble-agent: #264f78;
  --bubble-remote: #2f2f2f;
  --shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}

:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f5f7;
  --pane: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #eef1f4;
  --surface-3: #e4e8ed;
  --line: #d7dce2;
  --text: #20242a;
  --muted: #66707a;
  --subtle: #8b949e;
  --accent: #2663e6;
  --accent-2: #168456;
  --warn: #9a6200;
  --bad: #c03a4a;
  --bubble-zac: #dff3e8;
  --bubble-agent: #dbeafe;
  --bubble-remote: #ffffff;
  --shadow: 0 16px 38px rgba(26, 39, 55, 0.09);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

h1,
h2,
h3,
p {
  margin: 0;
}

.app-shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) 6px minmax(0, 1fr);
  height: 100dvh;
  min-width: 0;
}

.icon-button {
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text);
}

.conversation-pane {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--pane);
}

.sidebar-resizer {
  position: relative;
  z-index: 5;
  width: 6px;
  background: var(--surface);
  border-right: 1px solid var(--line);
  border-left: 1px solid var(--line);
  cursor: col-resize;
  touch-action: none;
}

.sidebar-resizer::before {
  content: "";
  position: absolute;
  inset: 0 -4px;
}

.sidebar-resizer:hover,
.sidebar-resizer:focus-visible,
.sidebar-resizer.dragging {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  outline: none;
}

.pane-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
}

.pane-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pane-head h1 {
  font-size: 18px;
  line-height: 1.2;
}

#freshness {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

.icon-button {
  min-height: 32px;
  border-radius: 8px;
  padding: 6px 10px;
}

.icon-only {
  display: inline-grid;
  place-items: center;
  width: 32px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
}

.icon-only svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.list-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 12px 14px;
}

.list-tools input,
.draft-form input,
.draft-form textarea,
.composer textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.list-tools input,
.draft-form input {
  min-height: 36px;
  padding: 8px 10px;
}

.list-tools input:focus,
.draft-form input:focus,
.draft-form textarea:focus,
.composer textarea:focus {
  border-color: var(--accent);
}

.toggle-button {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 10px;
  color: var(--muted);
  background: var(--surface);
  white-space: nowrap;
}

.toggle-button.active,
.toggle-button[aria-pressed="true"] {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--accent);
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  color: var(--subtle);
  font-size: 12px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

button.list-header {
  width: 100%;
  border-right: 0;
  border-left: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

button.list-header:hover,
button.list-header:focus-visible {
  color: var(--text);
  background: var(--surface-2);
  outline: none;
}

.folder-title {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.folder-chevron {
  width: 7px;
  height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
  transition: transform 120ms ease;
}

.issue-folder.collapsed .folder-chevron {
  transform: rotate(-45deg);
}

.folder-count {
  font-variant-numeric: tabular-nums;
}

.issues {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}

.issue-folder {
  border-top: 1px solid var(--line);
}

.issue-folder:first-child {
  border-top: 0;
}

.issue-row {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 6px;
  padding: 13px 14px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  text-align: left;
  overflow: hidden;
}

.issue-row:hover,
.issue-row.selected {
  background: var(--surface-2);
}

.issue-row.needs-attention {
  background: color-mix(in srgb, var(--bad) 12%, var(--pane));
  box-shadow: inset 3px 0 0 var(--bad);
}

.issue-row.selected {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 62%, var(--line));
}

.issue-row.needs-attention.selected {
  background: color-mix(in srgb, var(--accent) 14%, color-mix(in srgb, var(--bad) 14%, var(--pane)));
  box-shadow:
    inset 3px 0 0 var(--bad),
    inset 0 0 0 1px color-mix(in srgb, var(--accent) 68%, var(--line));
}

.delete-issue {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--subtle);
  opacity: 0.55;
}

.delete-issue:hover,
.delete-issue:focus {
  border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
  background: color-mix(in srgb, var(--bad) 10%, var(--surface-2));
  color: var(--bad);
  opacity: 1;
}

.delete-issue svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.row-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.row-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.subject {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 680;
}

.time {
  flex: 0 0 auto;
  min-width: 68px;
  text-align: right;
  color: var(--subtle);
  font-size: 12px;
}

.row-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}

.workspace {
  position: relative;
  min-width: 0;
  background: var(--surface);
}

.theme-toggle {
  position: fixed;
  top: 14px;
  right: 16px;
  z-index: 20;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  color: var(--text);
  box-shadow: var(--shadow);
}

.view {
  display: none;
  height: 100dvh;
  min-width: 0;
}

.view.active {
  display: block;
}

.chat-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  min-width: 0;
}

.chat-head {
  display: grid;
  gap: 8px;
  padding: 16px 64px 16px 22px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.chat-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.chat-title-row > div:first-child {
  min-width: 0;
}

.chat-head h2 {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 19px;
  line-height: 1.3;
}

.chat-meta,
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 12px;
}

.tag {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  min-height: 22px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
  background: var(--surface-2);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag.pending {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
}

.tag.need-approval,
.tag.needs-human,
.tag.ready_to_reply,
.tag.needs_human,
.tag.pending-human,
.tag.failed {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 40%, var(--line));
}

.tag.delivered,
.tag.completed,
.tag.complete {
  color: var(--accent-2);
  border-color: color-mix(in srgb, var(--accent-2) 42%, var(--line));
}

.attention-strip {
  border-left: 3px solid var(--bad);
  padding: 9px 11px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bad) 11%, var(--surface));
  color: var(--text);
}

.messages {
  min-height: 0;
  overflow-y: auto;
  padding: 22px;
}

.message {
  display: grid;
  gap: 5px;
  margin: 12px 0;
}

.message.remote {
  justify-items: start;
}

.message.local {
  justify-items: end;
}

.message.system {
  justify-items: center;
}

.message.speaker-zac {
  justify-items: center;
}

.message.speaker-agent {
  justify-items: end;
}

.message-line {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(760px, 82%);
}

.message.local .message-line {
  justify-content: flex-end;
}

.message.speaker-zac .message-line {
  justify-content: center;
}

.message.speaker-agent .message-line {
  justify-content: flex-end;
}

.message-meta {
  color: var(--subtle);
  font-size: 12px;
}

.bubble {
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bubble-remote);
  box-shadow: var(--shadow);
}

.message.speaker-zac .bubble {
  background: var(--bubble-zac);
}

.message.speaker-agent .bubble {
  background: var(--bubble-agent);
}

.message.speaker-remote .bubble {
  background: var(--bubble-remote);
}

.message.system .bubble {
  max-width: min(720px, 88%);
  background: var(--surface-2);
  box-shadow: none;
  color: var(--muted);
}

.delivery-indicator {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  color: #fff;
  font-size: 12px;
  font-weight: 760;
  line-height: 1;
}

.delivery-indicator.failed {
  background: var(--bad);
}

.delivery-indicator.delivered {
  background: var(--accent-2);
}

.delivery-indicator::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  z-index: 30;
  width: max-content;
  max-width: 260px;
  transform: translateX(-50%) translateY(2px);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 8px;
  background: var(--surface-3);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 12px;
  font-weight: 520;
  line-height: 1.35;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease, transform 120ms ease;
  white-space: normal;
}

.delivery-indicator:hover::after,
.delivery-indicator:focus-visible::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.pending-marker {
  display: flex;
  justify-content: center;
  padding: 8px 0 4px;
}

.pending-marker span {
  max-width: min(620px, 90%);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 11px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
}

.bubble pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.message-error {
  margin-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--bad) 45%, transparent);
  padding-top: 7px;
  color: var(--bad);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.draft-preview pre,
.dashboard-detail pre {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.composer {
  display: grid;
  gap: 6px;
  padding: 14px 22px 18px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.composer-input {
  position: relative;
}

.composer textarea {
  min-height: 58px;
  max-height: 180px;
  resize: vertical;
  padding: 10px 50px 10px 12px;
}

.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.status-text {
  margin-right: auto;
  color: var(--muted);
  font-size: 12px;
}

.status-text:empty {
  display: none;
}

.send-button {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 18px;
  line-height: 1;
}

.draft-form button,
.draft-preview button {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 13px;
  background: var(--accent);
  color: #fff;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.empty-state,
.dashboard-page {
  max-width: 920px;
  margin: 0 auto;
  padding: 46px 28px;
}

.dashboard-shell {
  position: relative;
  min-height: 100dvh;
  background: var(--surface);
}

.text-link {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
}

.empty-state {
  color: var(--muted);
  text-align: center;
}

.empty-state h2,
.page-head h2 {
  color: var(--text);
  font-size: 24px;
  line-height: 1.2;
}

.empty-state p,
.page-head p {
  margin-top: 8px;
  color: var(--muted);
}

.new-task-empty {
  display: grid;
  place-items: center;
}

.new-task-empty .empty-state {
  padding: 0 28px;
}

.draft-form {
  display: grid;
  gap: 14px;
  margin-top: 22px;
}

.draft-form label {
  display: grid;
  gap: 6px;
  color: var(--muted);
}

.draft-form textarea {
  min-height: 160px;
  resize: vertical;
  padding: 10px 12px;
}

.draft-preview,
.dashboard-detail,
.metric {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
}

.draft-preview {
  display: grid;
  gap: 12px;
  margin-top: 18px;
  padding: 16px;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 22px 0;
}

.metric {
  padding: 14px;
}

.metric strong {
  display: block;
  font-size: 22px;
  line-height: 1.1;
}

.metric span {
  color: var(--muted);
  font-size: 12px;
}

.dashboard-detail {
  padding: 16px;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.field {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  background: var(--surface);
}

.field label {
  display: block;
  color: var(--muted);
  font-size: 12px;
}

.field code {
  word-break: break-all;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (max-width: 980px) {
  body {
    overflow: auto;
  }

  .app-shell {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(340px, 42dvh) minmax(0, 1fr);
    height: auto;
    min-height: 100dvh;
  }

  .sidebar-resizer {
    display: none;
  }

  .conversation-pane {
    min-height: 340px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .workspace {
    grid-column: 1;
  }

  .view,
  .chat-view {
    height: auto;
    min-height: 58dvh;
  }

  .field-grid,
  .metrics {
    grid-template-columns: 1fr;
  }

  .bubble {
    max-width: 94%;
  }
}
`;

const APP_JS = String.raw`let snapshot = null;
let selectedTaskId = null;
let selectedDetail = null;
let activeView = "inbox";
let showCompleted = false;
let latestDraft = null;
const pageMode = document.body.dataset.page || "inbox";
const SIDEBAR_WIDTH_KEY = "agentrelay-sidebar-width";
const FOLDER_COLLAPSE_KEY = "agentrelay-collapsed-folders";
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 720;
let collapsedFolders = loadCollapsedFolders();

const el = {
  freshness: document.querySelector("#freshness"),
  metrics: document.querySelector("#metrics"),
  issues: document.querySelector("#issues"),
  visibleCount: document.querySelector("#visible-count"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailBody: document.querySelector("#detail-body"),
  dashboardDetail: document.querySelector("#dashboard-detail"),
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  showCompleted: document.querySelector("#show-completed"),
  themeToggle: document.querySelector("#theme-toggle"),
  newTask: document.querySelector("#new-task"),
  draftForm: document.querySelector("#draft-form"),
  draftStatus: document.querySelector("#draft-status"),
  draftPreview: document.querySelector("#draft-preview"),
  agentOptions: document.querySelector("#agent-options"),
  sidebarResizer: document.querySelector("#sidebar-resizer")
};

applyTheme(localStorage.getItem("agentrelay-theme") || "dark");
initSidebarResize();

if (el.search) el.search.addEventListener("input", renderList);
if (el.refresh) el.refresh.addEventListener("click", refresh);
if (el.showCompleted) {
  el.showCompleted.addEventListener("click", () => {
    showCompleted = !showCompleted;
    el.showCompleted.classList.toggle("active", showCompleted);
    el.showCompleted.setAttribute("aria-pressed", String(showCompleted));
    renderList();
  });
}
if (el.newTask) el.newTask.addEventListener("click", () => setView("new"));
if (el.themeToggle) el.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
});
if (el.draftForm) {
  const draftTextarea = el.draftForm.querySelector("#draft-text");
  if (draftTextarea) {
    draftTextarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      el.draftForm.requestSubmit();
    });
  }
  el.draftForm.addEventListener("submit", createDraft);
}

await refresh();
setInterval(refresh, 10000);

function initSidebarResize() {
  const storedWidth = Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || "", 10);
  if (Number.isFinite(storedWidth)) setSidebarWidth(storedWidth, { persist: false });
  if (!el.sidebarResizer) return;

  el.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 980px)").matches) return;
    event.preventDefault();
    el.sidebarResizer.classList.add("dragging");
    el.sidebarResizer.setPointerCapture?.(event.pointerId);

    const onPointerMove = (moveEvent) => {
      setSidebarWidth(moveEvent.clientX);
    };
    const stopDragging = () => {
      el.sidebarResizer.classList.remove("dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
  });

  el.sidebarResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = currentSidebarWidth();
    setSidebarWidth(current + (event.key === "ArrowRight" ? 24 : -24));
  });
}

function currentSidebarWidth() {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width");
  return Number.parseInt(value, 10) || 390;
}

function setSidebarWidth(width, { persist = true } = {}) {
  const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
  document.documentElement.style.setProperty("--sidebar-width", next + "px");
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
}

async function refresh() {
  const response = await fetch("/api/issues", { cache: "no-store" });
  snapshot = await response.json();
  await loadAgents();
  renderMetrics();
  renderList();
  if (el.freshness) el.freshness.textContent = "Updated " + formatTime(snapshot.generatedAt);
  if (selectedTaskId) await selectIssue(selectedTaskId, { keepView: true });
  renderDashboard();
}

async function loadAgents() {
  try {
    const response = await fetch("/api/agents", { cache: "no-store" });
    const body = await response.json();
    if (!el.agentOptions) return;
    el.agentOptions.innerHTML = (body.agents || []).map((agent) =>
      '<option value="' + escapeAttr(agent.agentId) + '">' + escapeHtml(agent.label || agent.agentId) + '</option>'
    ).join("");
  } catch {
    if (el.agentOptions) el.agentOptions.innerHTML = "";
  }
}

function setView(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((node) => node.classList.remove("active"));
  const target = document.querySelector("#" + view + "-view");
  if (target) target.classList.add("active");
  if (view === "dashboard") renderDashboard();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("agentrelay-theme", theme);
  if (el.themeToggle) {
    el.themeToggle.textContent = theme === "dark" ? "☀" : "◐";
    el.themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

function renderMetrics() {
  if (!el.metrics || !snapshot) return;
  const pendingHuman = snapshot.issues.filter((issue) => classifyIssue(issue, "pending_human")).length;
  const pendingRemote = snapshot.issues.filter((issue) => classifyIssue(issue, "pending_remote")).length;
  const complete = snapshot.issues.filter((issue) => classifyIssue(issue, "complete")).length;
  el.metrics.innerHTML = [
    metric("Total", snapshot.counts.total),
    metric("Need approval", pendingHuman),
    metric("Pending", pendingRemote),
    metric("Complete", complete)
  ].join("");
}

function renderList() {
  if (!snapshot || !el.issues) return;
  const query = el.search ? el.search.value.trim().toLowerCase() : "";
  const issues = snapshot.issues.filter((issue) => {
    if (!query) return true;
    return [
      issue.taskId,
      issue.subject,
      issue.counterpartAgentId,
      issue.pendingOnAgentId,
      issue.relayStatus,
      issue.localStatus,
      issue.processorSummary
    ].join(" ").toLowerCase().includes(query);
  });
  const visibleIssues = issues.filter((issue) => showCompleted || issueStatus(issue) !== "complete");
  const folders = issueFolders(issues).filter((folder) => showCompleted || folder.key !== "complete");

  if (el.visibleCount) el.visibleCount.textContent = visibleIssues.length + " shown";
  if (!visibleIssues.length) {
    el.issues.innerHTML = '<div class="empty-state"><p>No tasks match this view.</p></div>';
    return;
  }
  el.issues.innerHTML = folders.map(issueFolder).join("");
  for (const row of el.issues.querySelectorAll(".issue-row")) {
    row.addEventListener("click", () => selectIssue(row.dataset.taskId));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectIssue(row.dataset.taskId);
    });
  }
  for (const button of el.issues.querySelectorAll(".delete-issue")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteIssueFromList(button.dataset.taskId);
    });
  }
  for (const button of el.issues.querySelectorAll(".folder-toggle")) {
    button.addEventListener("click", () => toggleIssueFolder(button.dataset.folderKey));
  }
}

function issueFolders(issues) {
  const folders = [
    {
      key: "pending_human",
      title: "Need approval",
      issues: issues.filter((issue) => issueStatus(issue) === "need approval")
    },
    {
      key: "pending_remote",
      title: "Pending",
      issues: issues.filter((issue) => issueStatus(issue) === "pending")
    },
    {
      key: "complete",
      title: "Complete",
      issues: issues.filter((issue) => issueStatus(issue) === "complete")
    }
  ];
  if (!showCompleted) return folders;
  return [
    folders.find((folder) => folder.key === "complete"),
    folders.find((folder) => folder.key === "pending_human"),
    folders.find((folder) => folder.key === "pending_remote")
  ].filter(Boolean);
}

function issueFolder(folder) {
  const collapsed = collapsedFolders.has(folder.key);
  return '<section class="issue-folder ' + (collapsed ? "collapsed" : "") + '" data-folder="' + escapeAttr(folder.key) + '">' +
    '<button class="list-header folder-toggle" type="button" data-folder-key="' + escapeAttr(folder.key) + '" aria-expanded="' + String(!collapsed) + '">' +
      '<span class="folder-title"><span class="folder-chevron" aria-hidden="true"></span><span>' + escapeHtml(folder.title) + '</span></span>' +
      '<span class="folder-count">' + folder.issues.length + '</span>' +
    '</button>' +
    (collapsed ? "" : folder.issues.map(issueRow).join("")) +
  '</section>';
}

function toggleIssueFolder(folderKey) {
  if (!folderKey) return;
  if (collapsedFolders.has(folderKey)) {
    collapsedFolders.delete(folderKey);
  } else {
    collapsedFolders.add(folderKey);
  }
  saveCollapsedFolders();
  renderList();
}

function loadCollapsedFolders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders() {
  localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify(Array.from(collapsedFolders)));
}

function classifyIssue(issue, filter) {
  if (filter === "all") return true;
  if (filter === "needs") return issueStatus(issue) === "need approval";
  if (filter === "pending_human") return issueStatus(issue) === "need approval";
  if (filter === "completed") return issueStatus(issue) === "complete";
  if (filter === "complete") return issueStatus(issue) === "complete";
  if (filter === "pending_remote") return issueStatus(issue) === "pending";
  return true;
}

function issueStatus(issue) {
  if (issue.relayStatus === "completed" || issue.localStatus === "closed") return "complete";
  if (issue.needsHuman) return "need approval";
  return "pending";
}

async function selectIssue(taskId, { keepView = false } = {}) {
  if (!el.issues || !el.detailEmpty || !el.detailBody) return;
  const scrollState = keepView ? captureMessageScrollState() : null;
  const composerDraft = keepView ? captureComposerDraft(taskId) : null;
  selectedTaskId = taskId;
  for (const row of el.issues.querySelectorAll(".issue-row")) {
    row.classList.toggle("selected", row.dataset.taskId === taskId);
  }
  const response = await fetch("/api/issues/" + encodeURIComponent(taskId), { cache: "no-store" });
  if (!response.ok) {
    selectedDetail = null;
    el.detailEmpty.hidden = false;
    el.detailBody.hidden = true;
    el.detailEmpty.querySelector("h2").textContent = "Task not found";
    return;
  }
  selectedDetail = await response.json();
  el.detailEmpty.hidden = true;
  el.detailBody.hidden = false;
  el.detailBody.innerHTML = renderChat(selectedDetail);
  bindReplyForm(taskId);
  restoreComposerDraft(composerDraft);
  restoreMessageScrollState(scrollState);
  renderDashboard();
  if (!keepView) setView("inbox");
}

function captureMessageScrollState() {
  const messages = el.detailBody?.querySelector(".messages");
  if (!messages) return null;
  const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  return {
    scrollTop: messages.scrollTop,
    distanceFromBottom,
    wasNearBottom: distanceFromBottom <= 48
  };
}

function restoreMessageScrollState(state) {
  if (!state) return;
  requestAnimationFrame(() => {
    const messages = el.detailBody?.querySelector(".messages");
    if (!messages) return;
    if (state.wasNearBottom) {
      messages.scrollTop = messages.scrollHeight;
      return;
    }
    const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    messages.scrollTop = Math.min(state.scrollTop, maxScrollTop);
  });
}

function captureComposerDraft(taskId) {
  const textarea = el.detailBody?.querySelector("#reply-text");
  if (!textarea) return null;
  return {
    taskId,
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    focused: document.activeElement === textarea
  };
}

function restoreComposerDraft(draft) {
  if (!draft || draft.taskId !== selectedTaskId) return;
  const textarea = el.detailBody?.querySelector("#reply-text");
  if (!textarea) return;
  textarea.value = draft.value || "";
  if (!draft.focused) return;
  textarea.focus();
  const start = Number.isFinite(draft.selectionStart) ? draft.selectionStart : textarea.value.length;
  const end = Number.isFinite(draft.selectionEnd) ? draft.selectionEnd : start;
  textarea.setSelectionRange(start, end);
}

async function deleteIssueFromList(taskId) {
  if (!taskId) return;
  const confirmed = window.confirm("Delete this local thread?");
  if (!confirmed) return;
  const response = await fetch("/api/issues/" + encodeURIComponent(taskId), { method: "DELETE" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    window.alert(body.message || body.error || "Delete failed");
    return;
  }
  if (selectedTaskId === taskId) {
    selectedTaskId = null;
    selectedDetail = null;
    if (el.detailEmpty) {
      el.detailEmpty.hidden = false;
      el.detailEmpty.querySelector("h2").textContent = "Select a task";
    }
    if (el.detailBody) {
      el.detailBody.hidden = true;
      el.detailBody.innerHTML = "";
    }
  }
  await refresh();
}

function issueRow(issue) {
  const classes = [
    "issue-row",
    issue.taskId === selectedTaskId ? "selected" : "",
    issue.needsHuman ? "needs-attention" : ""
  ].filter(Boolean).join(" ");
  const current = issue.taskId === selectedTaskId ? ' aria-current="true"' : "";
  return '<article class="' + classes + '" role="button" tabindex="0" data-task-id="' + escapeAttr(issue.taskId) + '"' + current + '>' +
    '<div class="row-main"><span class="subject">' + escapeHtml(issue.subject || "(untitled)") + '</span><div class="row-actions"><span class="time">' + formatTime(issue.updatedAt) + '</span><button class="delete-issue" type="button" data-task-id="' + escapeAttr(issue.taskId) + '" title="Delete thread" aria-label="Delete thread">' + trashIcon() + '</button></div></div>' +
  '</article>';
}

function renderChat({ issue, timeline }) {
  return '<header class="chat-head">' +
    '<div class="chat-title-row">' +
      '<div><h2>' + escapeHtml(issue.subject || "(untitled)") + '</h2><div class="chat-meta">' + escapeHtml(issue.counterpartAgentId || "no counterpart") + ' · ' + escapeHtml(issue.taskId) + '</div></div>' +
      '<div class="tags">' + tags(issue).join("") + '</div>' +
    '</div>' +
    (issue.needsHuman ? '<div class="attention-strip">' + escapeHtml(humanAttentionText(issue)) + '</div>' : "") +
  '</header>' +
  '<section class="messages">' + renderMessages(timeline || []) + renderPendingMarker(issue) + '</section>' +
  renderComposer(issue);
}

function renderMessages(timeline) {
  const chatItems = visibleChatItems(timeline);
  if (!chatItems.length) return '<div class="empty-state"><p>No conversation messages yet.</p></div>';
  return chatItems.map((item) => {
    const side = item.side || "system";
    const speakerClass = messageSpeakerClass(item);
    const delivery = deliveryIndicator(item);
    return '<article class="message ' + escapeAttr(side) + ' ' + escapeAttr(speakerClass) + '">' +
      '<div class="message-meta">' + escapeHtml(item.speaker || item.title || item.type) + ' · ' + escapeHtml(formatTime(item.at)) + '</div>' +
        '<div class="message-line">' +
          delivery +
          '<div class="bubble">' +
            (item.text ? '<pre>' + escapeHtml(item.text) + '</pre>' : '<pre>' + escapeHtml(item.title || "") + '</pre>') +
            messageError(item) +
          '</div>' +
        '</div>' +
    '</article>';
  }).join("");
}

function messageSpeakerClass(item) {
  if ((item.speaker || "") === "Zac") return "speaker-zac";
  if ((item.speaker || "") === "Agent") return "speaker-agent";
  return "speaker-remote";
}

function deliveryIndicator(item) {
  if (item.failed) return '<span class="delivery-indicator failed" tabindex="0" title="Deliver failed" data-tooltip="' + escapeAttr(deliveryFailureTooltip(item)) + '" aria-label="Deliver failed">!</span>';
  if (item.type === "local_request" && item.status === "sent") return '<span class="delivery-indicator delivered" tabindex="0" title="Delivered" data-tooltip="Delivered" aria-label="Delivered">✓</span>';
  return "";
}

function deliveryFailureTooltip(item) {
  const error = String(item.error || "").trim();
  return error ? "Deliver failed: " + error : "Deliver failed";
}

function messageError(item) {
  if (!item?.failed) return "";
  return '<div class="message-error">' + escapeHtml(deliveryFailureTooltip(item)) + '</div>';
}

function visibleChatItems(timeline) {
  return (timeline || []).filter((item) => {
    if (!item || !String(item.text || "").trim()) return false;
    return item.type === "relay_message" || item.type === "artifact" || item.type === "local_reply" || item.type === "local_request" || item.type === "processor";
  });
}

function humanAttentionText(issue) {
  if (issue.processorStatus === "failed") return "本地 Agent 处理失败，需要 Zac 选择下一步。";
  if (issue.humanReplyStatus === "pending_processor") return "本地 Agent 正在处理 Zac 的回复。";
  return "需要 Zac 确认下一步。";
}

function renderPendingMarker(issue) {
  const label = pendingOwnerLabel(issue);
  const at = issue.updatedAt || issue.processorLastRunAt || issue.executorLastRunAt || issue.createdAt || "";
  const prefix = at ? formatTime(at) + " " : "";
  return label ? '<div class="pending-marker"><span>' + escapeHtml(prefix + label) + '</span></div>' : "";
}

function pendingOwnerLabel(issue) {
  if (issue.relayStatus === "completed" || issue.localStatus === "closed") return "Complete";
  if (issue.pendingOnHumanId) return "Need approval";
  if (issue.humanReplyStatus === "pending_processor") return "Pending zac-agent";
  if (issue.pendingOnAgentId === "zac-agent") return "Pending zac-agent";
  if (issue.pendingOnAgentId) return "Pending " + issue.pendingOnAgentId;
  if (issue.requiresHumanConfirmation) return "Need approval";
  if (issue.localStatus === "create_failed" || issue.relayStatus === "failed") return "Need approval";
  return "";
}

function renderComposer(issue) {
  if (!issue.needsHuman) return "";
  return '<form class="composer" id="reply-form">' +
    '<div class="composer-input">' +
      '<textarea id="reply-text" name="text" placeholder="输入 Zac 的回复、确认或补充信息..." required></textarea>' +
      '<button class="send-button" type="submit" title="Send" aria-label="Send">↑</button>' +
    '</div>' +
    '<span class="status-text" id="reply-status" aria-live="polite"></span>' +
  '</form>';
}

function bindReplyForm(taskId) {
  const form = document.querySelector("#reply-form");
  if (!form) return;
  const textarea = form.querySelector("#reply-text");
  if (textarea) {
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      form.requestSubmit();
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("#reply-status");
    const button = form.querySelector("button");
    const text = textarea.value.trim();
    if (!text) {
      status.textContent = "请输入回复内容。";
      return;
    }
    button.disabled = true;
    status.textContent = "Saving and running processor...";
    try {
      const response = await fetch("/api/issues/" + encodeURIComponent(taskId) + "/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || "reply failed");
      textarea.value = "";
      status.textContent = "Saved. LLM processor scheduled.";
      await refresh();
      await selectIssue(taskId);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

async function createDraft(event) {
  event.preventDefault();
  const textarea = document.querySelector("#draft-text");
  const text = textarea.value.trim();
  if (!text) {
    el.draftStatus.textContent = "请输入请求内容。";
    return;
  }
  const button = el.draftForm.querySelector("button");
  button.disabled = true;
  el.draftStatus.textContent = "";
  renderNewTaskMessage({ text, status: "sending" });
  textarea.value = "";
  try {
    const response = await fetch("/api/task-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.message || body.error || "task request failed");
      error.body = body;
      throw error;
    }
    latestDraft = body.draft;
    await refresh();
    await selectIssue(body.taskId);
  } catch (error) {
    renderNewTaskMessage({ text, status: "failed", error: error.message });
    if (error.body?.taskId) {
      await refresh();
      await selectIssue(error.body.taskId);
    }
  } finally {
    button.disabled = false;
  }
}

function renderNewTaskMessage({ text, status = "sending", error = "" }) {
  const container = document.querySelector("#new-task-messages");
  if (!container) return;
  container.classList.remove("new-task-empty");
  const now = new Date().toISOString();
  const failed = status === "failed"
    ? '<span class="delivery-indicator failed" tabindex="0" title="Deliver failed" data-tooltip="' + escapeAttr(error ? "Deliver failed: " + error : "Deliver failed") + '" aria-label="Deliver failed">!</span>'
    : "";
  const pending = status === "sending"
      ? '<div class="pending-marker"><span>' + escapeHtml(formatTime(now) + " Pending zac-agent") + '</span></div>'
      : "";
  container.innerHTML = '<article class="message local speaker-zac">' +
    '<div class="message-meta">Zac · ' + escapeHtml(formatTime(now)) + '</div>' +
    '<div class="message-line">' +
      failed +
      '<div class="bubble"><pre>' + escapeHtml(text) + '</pre>' +
        (status === "failed" ? '<div class="message-error">' + escapeHtml(error ? "Deliver failed: " + error : "Deliver failed") + '</div>' : "") +
      '</div>' +
    '</div>' +
  '</article>' + pending;
}

function renderDraftPreview(draft) {
  return '<h3>' + escapeHtml(draft.subject) + '</h3>' +
    '<div class="tags">' + chip("to: " + draft.to) + chip("from: " + draft.from) + chip("owner: " + draft.completionOwnerAgentId) + '</div>' +
    '<pre>' + escapeHtml(draft.requestText) + '</pre>' +
    '<div class="field-grid">' +
      field("Done criteria", draft.doneCriteria) +
      field("Human boundary", draft.humanBoundaryReason) +
    '</div>' +
    '<div class="form-actions"><span id="send-draft-status" class="status-text"></span><button id="send-draft" type="button">Confirm and send</button></div>';
}

function bindSendDraft() {
  const button = document.querySelector("#send-draft");
  const status = document.querySelector("#send-draft-status");
  if (!button || !latestDraft) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Creating AgentRelay task...";
    try {
      const response = await fetch("/api/task-drafts/" + encodeURIComponent(latestDraft.draftId) + "/send", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || "send failed");
      status.textContent = "Sent: " + body.taskId;
      await refresh();
      await selectIssue(body.taskId);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderDashboard() {
  if (!snapshot || !el.dashboardDetail) return;
  if (!selectedDetail) {
    el.dashboardDetail.innerHTML = pageMode === "dashboard"
      ? '<p>Open a task from the inbox to inspect raw local state and Relay events here.</p>'
      : '<p>Select a task to inspect raw local state and Relay events.</p>';
    return;
  }
  const { issue, events } = selectedDetail;
  el.dashboardDetail.innerHTML = '<h3>' + escapeHtml(issue.subject || issue.taskId) + '</h3>' +
    '<div class="field-grid">' +
      field("Task ID", issue.taskId, true) +
      field("Counterpart", issue.counterpartAgentId || "none") +
      field("Requester", issue.requesterAgentId || "none") +
      field("Target", issue.targetAgentId || "none") +
      field("Pending agent", issue.pendingOnAgentId || "none") +
      field("Need approval", issue.pendingOnHumanId || "none") +
      field("Relay status", issue.relayStatus || "unknown") +
      field("Local status", issue.localStatus || "unknown") +
      field("Processor", issue.processorStatus || "not processed") +
      field("Executor", issue.executorStatus || "not run") +
    '</div>' +
    '<h3 class="events-title">Raw events</h3>' +
    (events.length ? events.map(renderEvent).join("") : '<p>No raw events recorded for this local issue.</p>');
}

function renderEvent(event) {
  return '<article class="event">' +
    '<div class="tags">' + chip(event.eventId || "event") + chip(event.type || "unknown") + chip("ack: " + (event.ackStatus || "none")) + chip(formatTime(event.receivedAt || event.recordedAt)) + '</div>' +
    '<pre>' + escapeHtml(JSON.stringify(event.raw, null, 2)) + '</pre>' +
  '</article>';
}

function tags(issue) {
  return [statusChip(issue)];
}

function issueListTags(issue) {
  return [statusChip(issue)];
}

function statusChip(issue) {
  const status = issueStatus(issue);
  return chip(status, status.replaceAll(" ", "-"));
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
}

function metric(label, value) {
  return '<div class="metric"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
}

function field(label, value, mono = false) {
  const body = mono ? '<code>' + escapeHtml(value) + '</code>' : escapeHtml(value);
  return '<div class="field"><label>' + escapeHtml(label) + '</label>' + body + '</div>';
}

function chip(text, cls = "") {
  return '<span class="tag ' + escapeAttr(cls) + '">' + escapeHtml(text) + '</span>';
}

function formatTime(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number) => String(number).padStart(2, "0");
  return pad(date.getMonth() + 1) + "/" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\`/g, "&#96;");
}
`;

if (isMainModulePath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = process.env.HOST || DEFAULT_HOST;
  const stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state");
  const server = createInboxUiServer({ stateRoot });
  server.listen(port, host, () => {
    console.log(`AgentRelay Inbox UI listening on http://${host}:${port}`);
    console.log(`Reading local state from ${stateRoot}`);
  });
}

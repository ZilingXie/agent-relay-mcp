#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const PROTOCOL_VERSION = "agent-collab-v0.3";
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(PROJECT_ROOT, ".env");
loadDotEnv(envPath);

export async function executeInboxAgent({
  stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state"),
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  relayClient,
  now = () => new Date().toISOString()
} = {}) {
  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInbox(inboxPath);
  const issues = Object.values(inbox.issues || {});
  let executed = 0;
  let failed = 0;
  const actions = [];

  relayClient ||= new AgentRelayExecutorHttpClient({
    baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL),
    token: process.env.AGENTRELAY_TOKEN || "",
    agentId: localAgentId,
    username: process.env.AGENTRELAY_USERNAME || ""
  });

  for (const issue of issues) {
    if (!shouldAttemptAction({ issue, localAgentId })) continue;
    const runAt = now();
    try {
      const taskResponse = await relayClient.getTask({ taskId: issue.taskId });
      const task = taskResponse.task || taskResponse;
      const actionIntent = issue.processorActionIntent;
      if (actionIntent === "close_task") {
        assertCanCloseTask({ task, issue, localAgentId });
        if (task.status === "completed") {
          inbox.issues[issue.taskId] = applyClosedTaskToIssue({
            issue,
            task,
            localAgentId,
            humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
            runAt
          });
          await appendJsonl(join(stateRoot, "executor-runs.jsonl"), {
            at: runAt,
            taskId: issue.taskId,
            actionIntent,
            status: "completed",
            humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
            terminalReason: task.terminal_reason || issue.processorTerminalReason || "",
            alreadyCompleted: true
          });
          actions.push({ taskId: issue.taskId, actionIntent, status: "completed", alreadyCompleted: true });
          executed += 1;
          continue;
        }
        const terminalReason = issue.processorTerminalReason || `Zac approved closing task ${issue.taskId} in the local AgentRelay inbox.`;
        const closeResponse = await relayClient.closeTask({
          taskId: issue.taskId,
          closedByAgentId: localAgentId,
          terminalReason
        });
        const closedTask = closeResponse.task || closeResponse;
        inbox.issues[issue.taskId] = applyClosedTaskToIssue({
          issue,
          task: closedTask,
          localAgentId,
          humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
          runAt
        });
        await appendJsonl(join(stateRoot, "executor-runs.jsonl"), {
          at: runAt,
          taskId: issue.taskId,
          actionIntent,
          status: "completed",
          humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
          terminalReason
        });
        actions.push({ taskId: issue.taskId, actionIntent, status: "completed" });
        executed += 1;
        continue;
      }

      assertCanSubmitArtifact({ task, issue, localAgentId });
      const submitParams = buildSubmitArtifactParams({ task, issue, localAgentId });
      const submitResponse = await relayClient.submitArtifact(submitParams);
      const updatedTask = submitResponse.task || submitResponse;
      inbox.issues[issue.taskId] = applySubmittedArtifactToIssue({
        issue,
        task: updatedTask,
        artifact: submitResponse.artifact,
        humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
        processorEventId: issue.processorLastEventId || "",
        runAt
      });
      await appendJsonl(join(stateRoot, "executor-runs.jsonl"), {
        at: runAt,
        taskId: issue.taskId,
        actionIntent,
        status: "completed",
        humanReplyId: issue.latestHumanReplyId || issue.processorLastHumanReplyId || "",
        artifactId: submitResponse.artifact?.artifact_id || ""
      });
      actions.push({ taskId: issue.taskId, actionIntent, status: "completed" });
      executed += 1;
    } catch (error) {
      inbox.issues[issue.taskId] = {
        ...issue,
        executorStatus: "failed",
        executorActionIntent: issue.processorActionIntent,
        executorError: error.message,
        executorLastRunAt: runAt,
        updatedAt: runAt
      };
      await appendJsonl(join(stateRoot, "executor-runs.jsonl"), {
        at: runAt,
        taskId: issue.taskId,
        actionIntent: issue.processorActionIntent,
        status: "failed",
        error: error.message
      });
      actions.push({ taskId: issue.taskId, actionIntent: issue.processorActionIntent, status: "failed", error: error.message });
      failed += 1;
    }
  }

  if (executed > 0 || failed > 0) await writeJsonAtomic(inboxPath, inbox);
  return { scanned: issues.length, executed, failed, actions };
}

function shouldAttemptAction({ issue, localAgentId }) {
  if (!new Set(["close_task", "submit_artifact", "request_revision"]).has(issue.processorActionIntent)) return false;
  if (issue.localStatus === "archived") return false;
  if (issue.relayStatus === "completed" || issue.localStatus === "closed") return false;
  if (issue.pendingOnAgentId && issue.pendingOnAgentId !== localAgentId) return false;
  if (issue.requiresHumanConfirmation === true) return false;
  if (issue.processorActionIntent === "request_revision") {
    const processorEventId = issue.processorLastEventId || "";
    if (!processorEventId) return false;
    if (issue.executorStatus === "completed" && issue.executorLastProcessorEventId === processorEventId) return false;
    return true;
  }
  const humanReplyId = issue.latestHumanReplyId || issue.processorLastHumanReplyId || "";
  if (!humanReplyId) return false;
  if (issue.executorStatus === "completed" && issue.executorLastHumanReplyId === humanReplyId) return false;
  if (issue.processorActionIntent === "close_task" && !issue.processorTerminalReason) return false;
  return true;
}

function assertCanCloseTask({ task, issue, localAgentId }) {
  const taskId = task.task_id || issue.taskId;
  const owner = task.completion_owner_agent_id || issue.completionOwnerAgentId || "";
  if (owner !== localAgentId) {
    throw new Error(`Cannot close ${taskId}: completion owner is ${owner || "(none)"}, local agent is ${localAgentId}`);
  }
  if (task.status === "completed") return;
  const pendingAgent = task.pending_on_agent_id || issue.pendingOnAgentId || "";
  if (pendingAgent && pendingAgent !== localAgentId) {
    throw new Error(`Cannot close ${taskId}: pending_on_agent_id is ${pendingAgent}`);
  }
}

function assertCanSubmitArtifact({ task, issue, localAgentId }) {
  const taskId = task.task_id || issue.taskId;
  if (task.status === "completed") throw new Error(`Cannot submit artifact for ${taskId}: task is already completed`);
  const pendingAgent = task.pending_on_agent_id || issue.pendingOnAgentId || "";
  if (pendingAgent && pendingAgent !== localAgentId) {
    throw new Error(`Cannot submit artifact for ${taskId}: pending_on_agent_id is ${pendingAgent}`);
  }
  if (!String(issue.processorArtifactText || "").trim()) {
    throw new Error(`Cannot submit artifact for ${taskId}: artifact text is required`);
  }
}

function buildSubmitArtifactParams({ task, issue, localAgentId }) {
  const isRevisionRequest = issue.processorActionIntent === "request_revision";
  const to = isRevisionRequest
    ? chooseRevisionRecipient({ task, issue, localAgentId })
    : chooseArtifactRecipient({ task, issue, localAgentId });
  const pendingOnAgentId = isRevisionRequest
    ? to
    : (task.completion_owner_agent_id || issue.completionOwnerAgentId || to);
  return {
    taskId: issue.taskId,
    from: localAgentId,
    to,
    kind: issue.processorArtifactKind || (isRevisionRequest ? "revision_request" : "text"),
    text: issue.processorArtifactText,
    pendingOnAgentId,
    nextStatus: task.status || issue.relayStatus || "delivery_pending",
    nextAction: isRevisionRequest
      ? "Remote agent should address the local revision request and return an updated artifact."
      : undefined
  };
}

function chooseRevisionRecipient({ task, issue, localAgentId }) {
  const target = task.target_agent_id || issue.targetAgentId || "";
  if (target && target !== localAgentId) return target;
  const requester = task.requester_agent_id || issue.requesterAgentId || "";
  if (requester && requester !== localAgentId) return requester;
  return issue.counterpartAgentId || target || requester || "";
}

function chooseArtifactRecipient({ task, issue, localAgentId }) {
  const requester = task.requester_agent_id || issue.requesterAgentId || "";
  const target = task.target_agent_id || issue.targetAgentId || "";
  if (requester && requester !== localAgentId) return requester;
  if (target && target !== localAgentId) return target;
  return issue.counterpartAgentId || requester || target || "";
}

function applyClosedTaskToIssue({ issue, task, localAgentId, humanReplyId, runAt }) {
  return {
    ...issue,
    relayStatus: task.status || "completed",
    localStatus: "closed",
    pendingOnAgentId: task.pending_on_agent_id || "",
    pendingOnHumanId: task.pending_on_human_id || null,
    terminalReason: task.terminal_reason || issue.processorTerminalReason || "",
    executorStatus: "completed",
    executorActionIntent: "close_task",
    executorClosedByAgentId: localAgentId,
    executorLastHumanReplyId: humanReplyId,
    executorLastRunAt: runAt,
    executorError: null,
    updatedAt: runAt
  };
}

function applySubmittedArtifactToIssue({ issue, task, artifact, humanReplyId, processorEventId, runAt }) {
  return {
    ...issue,
    relayStatus: task.status || issue.relayStatus || "delivery_pending",
    pendingOnAgentId: task.pending_on_agent_id || "",
    pendingOnHumanId: task.pending_on_human_id || null,
    executorStatus: "completed",
    executorActionIntent: issue.processorActionIntent || "submit_artifact",
    executorArtifactId: artifact?.artifact_id || "",
    executorLastHumanReplyId: humanReplyId,
    executorLastProcessorEventId: processorEventId,
    executorLastRunAt: runAt,
    executorError: null,
    updatedAt: runAt
  };
}

class AgentRelayExecutorHttpClient {
  constructor({ baseUrl, token, agentId, username }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.agentId = agentId;
    this.username = username;
  }

  async getTask({ taskId }) {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async closeTask({ taskId, closedByAgentId, terminalReason }) {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/close`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: `local-executor-close-${taskId}-${hashText(terminalReason)}`,
      closed_by_agent_id: closedByAgentId,
      closedByAgentId,
      completion_authority: {
        type: "agent",
        agent_id: closedByAgentId,
        summary: "Completion recorded by the local inbox executor."
      },
      terminal_reason: terminalReason,
      terminalReason
    });
  }

  async submitArtifact({ taskId, from, to, kind, text, pendingOnAgentId, pendingOnHumanId, nextStatus, nextAction }) {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/artifacts`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: `local-executor-artifact-${taskId}-${hashText(`${from}:${to}:${kind}:${text}`)}`,
      actor_agent_id: from,
      target_agent_id: to,
      intent: kind || "work_result",
      pending_on_agent_id: pendingOnAgentId || to,
      next_status: nextStatus || "delivery_pending",
      next_action: nextAction || `${pendingOnAgentId || to} should evaluate the artifact against the task done criteria.`,
      from,
      to,
      pendingOnAgentId,
      pendingOnHumanId,
      nextStatus,
      nextAction,
      artifact: {
        intent: kind || "work_result",
        kind: kind || "text",
        summary: summarizeText(text),
        parts: [{ kind: "text", text }]
      }
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

async function readInbox(path) {
  if (!existsSync(path)) return { version: 1, issues: {}, events: {} };
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    version: parsed.version || 1,
    issues: parsed.issues || {},
    events: parsed.events || {}
  };
}

async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "a", mode: 0o600 });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function summarizeText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function hashText(text) {
  let hash = 0;
  for (const char of String(text || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
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

function isMainModulePath(moduleUrl, argvPath = process.argv[1], cwd = process.cwd()) {
  if (!argvPath) return false;
  return resolve(cwd, argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModulePath(import.meta.url)) {
  executeInboxAgent()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

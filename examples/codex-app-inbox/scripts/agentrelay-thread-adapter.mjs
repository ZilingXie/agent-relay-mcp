#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectPathDefault = resolve(__dirname, "..");
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(projectPathDefault, ".env");
loadDotEnv(envPath);

const DEFAULT_CODEX_CLI = "/Applications/Codex.app/Contents/Resources/codex";

export async function enqueueEvent({
  eventPath,
  projectPath = process.env.AGENTRELAY_PROJECT_PATH || projectPathDefault,
  stateRoot,
  now = () => new Date().toISOString()
}) {
  if (!eventPath) throw new Error("Missing eventPath");
  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const event = payload.event || {};
  const task = payload.task || {};
  const taskId = task.task_id || event.taskId || event.task_id || "unknown-task";
  const eventId = event.eventId || event.event_id || `${taskId}:${task.updated_at || payload.receivedAt || event.type || "event"}`;
  const stateDir = stateRoot || process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state");
  const queueDir = join(stateDir, "queue");
  await mkdir(queueDir, { recursive: true });
  const queuePath = join(queueDir, `${safeFilePart(eventId)}.json`);
  const job = {
    version: 1,
    eventId,
    taskId,
    eventPath,
    queuedAt: now(),
    attempts: 0
  };
  await writeJsonAtomic(queuePath, job);
  return { status: "queued", eventId, taskId, queuePath };
}

export async function deliverEvent({
  eventPath,
  inboxRoot = process.env.AGENTRELAY_INBOX_DIR || join(projectPathDefault, "events"),
  stateRoot,
  projectPath = process.env.AGENTRELAY_PROJECT_PATH || projectPathDefault,
  agentId = process.env.AGENTRELAY_AGENT_ID || "",
  appClient,
  relayClient,
  now = () => new Date().toISOString()
}) {
  if (!eventPath) throw new Error("Missing eventPath");
  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const event = payload.event || {};
  const task = payload.task || {};
  const taskId = task.task_id || event.taskId || event.task_id;
  const eventId = event.eventId || event.event_id || `${taskId || "unknown"}:${task.updated_at || payload.receivedAt || event.type || "event"}`;
  if (!taskId) throw new Error(`Inbox event is missing task id: ${eventPath}`);
  if (!agentId) throw new Error("Missing AGENTRELAY_AGENT_ID");

  const stateDir = stateRoot || process.env.AGENTRELAY_STATE_DIR || join(projectPath, "state");
  await mkdir(stateDir, { recursive: true });
  const bindingsPath = join(stateDir, "bindings.json");
  const bindings = await readBindings(bindingsPath);

  if (bindings.events[eventId]?.status === "delivered") {
    return { status: "duplicate", eventId, taskId, threadId: bindings.events[eventId].threadId };
  }

  appClient ||= new CodexAppServerClient({ codexCli: process.env.CODEX_CLI || DEFAULT_CODEX_CLI });
  relayClient ||= new AgentRelayHttpClient({
    baseUrl: normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || ""),
    token: process.env.AGENTRELAY_TOKEN || "",
    agentId,
    username: process.env.AGENTRELAY_USERNAME || ""
  });

  try {
    const route = chooseRoute({ task, taskId, agentId, bindings, projectPath });
    const prompt = buildPrompt({ payload, eventPath, task, taskId, eventId, agentId, route });

    let threadId = route.threadId;
    let created = false;
    if (!threadId) {
      if (typeof appClient.startThreadAndTurn === "function") {
        const response = await appClient.startThreadAndTurn(
          {
            cwd: projectPath,
            runtimeWorkspaceRoots: [projectPath],
            threadSource: "agentrelay-inbox"
          },
          {
            input: [{ type: "text", text: prompt, text_elements: [] }],
            cwd: projectPath,
            runtimeWorkspaceRoots: [projectPath],
            responsesapiClientMetadata: {
              agentrelay_event_id: eventId,
              agentrelay_task_id: taskId,
              agentrelay_route: route.threadRole
            }
          }
        );
        threadId = extractThreadId(response.startResponse);
      } else {
        const startResponse = await appClient.startThread({
          cwd: projectPath,
          runtimeWorkspaceRoots: [projectPath],
          threadSource: "agentrelay-inbox"
        });
        threadId = extractThreadId(startResponse);
        if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(startResponse)}`);
        await appClient.startTurn({
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          cwd: projectPath,
          runtimeWorkspaceRoots: [projectPath],
          responsesapiClientMetadata: {
            agentrelay_event_id: eventId,
            agentrelay_task_id: taskId,
            agentrelay_route: route.threadRole
          }
        });
      }
      if (!threadId) throw new Error("thread/start did not return a thread id");
      created = true;
    } else {
      try {
        await appClient.startTurn({
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          cwd: projectPath,
          runtimeWorkspaceRoots: [projectPath],
          responsesapiClientMetadata: {
            agentrelay_event_id: eventId,
            agentrelay_task_id: taskId,
            agentrelay_route: route.threadRole
          }
        });
      } catch (error) {
        if (!canFallbackToNewThread(error)) throw error;
        const fallbackPrompt = [
          "Attached thread delivery failed; creating a new AgentRelay inbox thread instead.",
          "",
          `Original attached thread: ${threadId}`,
          `Delivery error: ${error.message}`,
          "",
          prompt
        ].join("\n");
        const response = await appClient.startThreadAndTurn(
          {
            cwd: projectPath,
            runtimeWorkspaceRoots: [projectPath],
            threadSource: "agentrelay-inbox"
          },
          {
            input: [{ type: "text", text: fallbackPrompt, text_elements: [] }],
            cwd: projectPath,
            runtimeWorkspaceRoots: [projectPath],
            responsesapiClientMetadata: {
              agentrelay_event_id: eventId,
              agentrelay_task_id: taskId,
              agentrelay_route: `${route.threadRole}:fallback-new-thread`
            }
          }
        );
        threadId = extractThreadId(response.startResponse);
        if (!threadId) throw new Error("fallback thread/start did not return a thread id");
        created = true;
      }
    }

    if (typeof appClient.verifyThreadVisible === "function") {
      await appClient.verifyThreadVisible({ threadId, projectPath });
    }

    bindings.version = 1;
    bindings.tasks[taskId] = {
      taskId,
      threadId,
      threadRole: route.threadRole,
      projectPath,
      subject: task.subject || "",
      lastEventId: eventId,
      lastStatus: task.status || "",
      updatedAt: now()
    };
    bindings.events[eventId] = {
      eventId,
      taskId,
      status: "delivered",
      threadId,
      threadRole: route.threadRole,
      sourcePath: eventPath,
      deliveredAt: now()
    };
    await writeJsonAtomic(bindingsPath, bindings);

    await relayClient.ackEvent({
      agentId,
      eventId,
      taskId,
      status: "delivered",
      threadId,
      threadRole: route.threadRole,
      projectPath
    });
    if (route.threadRole === "target") {
      await relayClient.setTargetThread({ agentId, taskId, threadId });
    }

    return { status: "delivered", eventId, taskId, threadId, created, threadRole: route.threadRole };
  } catch (error) {
    await appendJsonl(join(stateDir, "adapter-errors.jsonl"), {
      at: now(),
      eventId,
      taskId,
      eventPath,
      error: error.message,
      stack: error.stack
    });
    bindings.events[eventId] = {
      eventId,
      taskId,
      status: "failed",
      sourcePath: eventPath,
      error: error.message,
      failedAt: now()
    };
    await writeJsonAtomic(bindingsPath, bindings);
    return { status: "failed", eventId, taskId, error: error.message };
  }
}

export function chooseRoute({ task, taskId, agentId, bindings, projectPath }) {
  const localBinding = bindings.tasks?.[taskId];
  if (localBinding?.threadId) {
    return { threadId: localBinding.threadId, threadRole: localBinding.threadRole || inferThreadRole(task, agentId), source: "local-binding" };
  }

  const threadRole = inferThreadRole(task, agentId);
  if (threadRole === "requester" && task.requester_thread_id) {
    return { threadId: task.requester_thread_id, threadRole, source: "requester_thread_id" };
  }
  if (threadRole === "target" && task.target_thread_id) {
    return { threadId: task.target_thread_id, threadRole, source: "target_thread_id" };
  }
  for (const binding of task.threadBindings || task.thread_bindings || []) {
    if (binding.thread_id || binding.threadId) {
      return {
        threadId: binding.thread_id || binding.threadId,
        threadRole: binding.thread_role || binding.threadRole || threadRole,
        source: "task-thread-binding"
      };
    }
  }
  return { threadId: null, threadRole, source: "new-thread", projectPath };
}

export function inferThreadRole(task, agentId) {
  if (task.requester_agent_id === agentId || task.completion_owner_agent_id === agentId) return "requester";
  if (task.target_agent_id === agentId || task.pending_on_agent_id === agentId) return "target";
  return "observer";
}

export function buildPrompt({ payload, eventPath, task, taskId, eventId, agentId, route }) {
  const latestMessages = summarizeParts(task.messages || []);
  const artifacts = summarizeArtifacts(task.artifacts || []);
  const confirmationHint = needsHumanConfirmation(task, latestMessages)
    ? "这条消息看起来需要 Zac 确认或做承诺。请先总结选项并向 Zac 提问；不要自动提交 artifact、确认时间或关闭 task。"
    : "低风险自动处理：你可以读取/claim/分析任务并准备建议；遇到承诺、对外回复、敏感信息或关闭 task 时必须问 Zac。";

  return [
    "AgentRelay inbox event delivered into Codex.",
    "",
    `Local agent: ${agentId}`,
    `Task ID: ${taskId}`,
    `Event ID: ${eventId}`,
    `Route: ${route.threadRole} (${route.source})`,
    `Inbox JSON: ${eventPath}`,
    `Received at: ${payload.receivedAt || "unknown"}`,
    "",
    `Subject: ${task.subject || "(none)"}`,
    `Status: ${task.status || "(unknown)"}`,
    `Pending agent: ${task.pending_on_agent_id || "(none)"}`,
    `Pending human: ${task.pending_on_human_id || "(none)"}`,
    `Requester agent: ${task.requester_agent_id || "(unknown)"}`,
    `Target agent: ${task.target_agent_id || "(unknown)"}`,
    `Completion owner: ${task.completion_owner_agent_id || "(unknown)"}`,
    `Next action: ${task.next_action || "(none)"}`,
    `Done criteria: ${task.done_criteria || "(none)"}`,
    "",
    "Latest task messages:",
    latestMessages || "(none)",
    "",
    "Artifacts:",
    artifacts || "(none)",
    "",
    "Handling policy:",
    confirmationHint,
    "",
    "Required next behavior:",
    "- Follow this workspace's AGENTS.md.",
    "- Use AgentRelay MCP tools when you need fresh task state or to act on the task.",
    "- Keep Zac in the loop before commitments, external replies, artifact submission, or task closure.",
    "- If action is blocked by missing App/Relay state, explain the exact recovery step in this thread."
  ].join("\n");
}

function summarizeParts(messages) {
  return messages
    .slice(-5)
    .map((message, index) => {
      const parts = (message.parts || [])
        .map((part) => part.text || part.kind || "")
        .filter(Boolean)
        .join("\n");
      return `${index + 1}. ${message.from_agent_id || message.from || "unknown"} -> ${message.to_agent_id || message.to || "unknown"} (${message.role || "message"}): ${parts}`;
    })
    .join("\n");
}

function summarizeArtifacts(artifacts) {
  return artifacts
    .slice(-5)
    .map((artifact, index) => {
      const parts = (artifact.parts || artifact.artifact?.parts || [])
        .map((part) => part.text || part.kind || "")
        .filter(Boolean)
        .join("\n");
      return `${index + 1}. ${artifact.from_agent_id || artifact.from || "unknown"} -> ${artifact.to_agent_id || artifact.to || "unknown"}: ${parts}`;
    })
    .join("\n");
}

function needsHumanConfirmation(task, text) {
  const haystack = [
    task.subject,
    task.next_action,
    task.done_criteria,
    task.pending_on_human_id,
    text
  ].filter(Boolean).join("\n").toLowerCase();
  return /确认|confirm|approve|approval|时间|meeting|schedule|available|availability|承诺|关闭|close task|submit artifact/.test(haystack);
}

async function readBindings(path) {
  if (!existsSync(path)) return { version: 1, tasks: {}, events: {} };
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    version: parsed.version || 1,
    tasks: parsed.tasks || {},
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
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, `${previous}${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function extractThreadId(response) {
  return response?.thread?.id || response?.thread?.threadId || response?.threadId;
}

function isThreadNotFound(error) {
  return /thread not found/i.test(error?.message || "");
}

function canFallbackToNewThread(error) {
  return isThreadNotFound(error) || /timed out waiting for app-server response/i.test(error?.message || "");
}

class AgentRelayHttpClient {
  constructor({ baseUrl, token, agentId, username }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.agentId = agentId;
    this.username = username;
  }

  async ackEvent({ agentId, eventId, taskId, status, threadId, threadRole, projectPath }) {
    return this.post(`/workers/${encodeURIComponent(agentId)}/events/${encodeURIComponent(eventId)}/ack`, {
      taskId,
      status,
      threadId,
      threadRole,
      projectPath
    });
  }

  async setTargetThread({ agentId, taskId, threadId }) {
    return this.post(`/workers/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/thread`, { threadId });
  }

  async post(path, payload) {
    if (!this.baseUrl) throw new Error("Missing AGENTRELAY_BASE_URL");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.agentId ? { "X-AgentRelay-Agent-Id": this.agentId } : {}),
        ...(this.username ? { "X-AgentRelay-Username": this.username } : {})
      },
      body: JSON.stringify(compact(payload))
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`AgentRelay POST ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    return data;
  }
}

export class CodexAppServerClient {
  constructor({ codexCli, proxyRunner = runJsonRpcProxy }) {
    this.codexCli = codexCli;
    this.proxyRunner = proxyRunner;
    this.nextId = 1;
  }

  async startThread(params) {
    return this.request("thread/start", params);
  }

  async startTurn(params) {
    const id = this.nextId++;
    const messages = [
      ...this.initializeMessages(),
      { jsonrpc: "2.0", id, method: "turn/start", params }
    ];
    const result = await this.proxyRunner(this.codexCli, messages, null, {
      expectedIds: new Set([id]),
      waitForUserMessageCommit: true
    });
    return findResponse(result, id, "turn/start");
  }

  async startThreadAndTurn(threadParams, turnParamsWithoutThreadId) {
    const threadRequestId = this.nextId++;
    const turnRequestId = this.nextId++;
    const messages = [
      ...this.initializeMessages(),
      { id: threadRequestId, method: "thread/start", params: threadParams }
    ];
    const result = await this.proxyRunner(this.codexCli, messages, async ({ message, send }) => {
      if (message.id !== threadRequestId || message.error) return;
      const threadId = extractThreadId(message.result);
      if (!threadId) return;
      send({
        id: turnRequestId,
        method: "turn/start",
        params: { ...turnParamsWithoutThreadId, threadId }
      });
    }, {
      expectedIds: new Set([threadRequestId, turnRequestId]),
      waitForUserMessageCommit: true
    });
    const startResponse = findResponse(result, threadRequestId, "thread/start");
    const turnResponse = findResponse(result, turnRequestId, "turn/start");
    return { startResponse, turnResponse };
  }

  async request(method, params) {
    const id = this.nextId++;
    const messages = [
      ...this.initializeMessages(),
      { jsonrpc: "2.0", id, method, params }
    ];
    const result = await this.proxyRunner(this.codexCli, messages);
    return findResponse(result, id, method);
  }

  async verifyThreadVisible({ threadId, projectPath }) {
    return verifyThreadVisibleInStateDb({ threadId, projectPath });
  }

  initializeMessages() {
    return [
      {
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "agentrelay_inbox_adapter",
            title: "AgentRelay Inbox Adapter",
            version: "0.1.0"
          },
          capabilities: { experimentalApi: true }
        }
      },
      { method: "initialized", params: {} }
    ];
  }
}

function findResponse(messages, id, method) {
  const response = messages.find((message) => message.id === id);
  if (!response) throw new Error(`No JSON-RPC response for ${method}`);
  if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

function runJsonRpcProxy(codexCli, messages, onMessage, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(codexCli, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const parsed = [];
    const expectedIds = options instanceof Set ? options : options.expectedIds || new Set(
      messages
        .filter((message) => message.id !== undefined && message.method !== "initialize")
        .map((message) => message.id)
    );
    const seenIds = new Set();
    const waitForUserMessageCommit = !(options instanceof Set) && Boolean(options.waitForUserMessageCommit);
    let acceptedTurnId = null;
    let userMessageCommitted = !waitForUserMessageCommit;
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(new Error(`Timed out waiting for app-server response; stderr=${stderr.trim()}`));
    }, Number(process.env.AGENTRELAY_ADAPTER_TIMEOUT_MS || 120000));
    const settleSuccessIfReady = () => {
      if (settled) return;
      if (expectedIds.size === 0) return;
      for (const id of expectedIds) {
        if (!seenIds.has(id)) return;
      }
      if (!userMessageCommitted) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      resolveRun(parsed);
    };
    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
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
          if (expectedIds.has(message.id) && message.result?.turn?.id) {
            acceptedTurnId = message.result.turn.id;
          }
          if (
            message.method === "item/completed" &&
            message.params?.turnId === acceptedTurnId &&
            message.params?.item?.type === "userMessage"
          ) {
            userMessageCommitted = true;
          }
          if (onMessage) onMessage({ message, send });
          settleSuccessIfReady();
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            child.kill();
            rejectRun(new Error(`Failed to parse app-server response line: ${error.message}; line=${trimmed}`));
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectRun(new Error(`codex app-server exited ${code}: ${stderr.trim() || stdoutBuffer.trim()}`));
        return;
      }
      resolveRun(parsed);
    });
    for (const message of messages) {
      send(message);
    }
  });
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
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

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
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
  const args = process.argv.slice(2);
  const eventPath = args.find((arg) => !arg.startsWith("--"));
  const deliverNow = args.includes("--deliver-now") || process.env.AGENTRELAY_ADAPTER_MODE === "direct";
  const action = deliverNow ? deliverEvent : enqueueEvent;
  action({ eventPath })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.status === "failed" ? 1 : 0);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

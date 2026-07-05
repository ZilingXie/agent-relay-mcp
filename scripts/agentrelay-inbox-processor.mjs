#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocalAgentRunner } from "./agentrelay-local-agent-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(PROJECT_ROOT, ".env");
loadDotEnv(envPath);

const DEFAULT_CODEX_CLI = "/Applications/Codex.app/Contents/Resources/codex";
const PROCESSOR_SCHEMA_PATH = resolve(PROJECT_ROOT, "schemas/processor-output.schema.json");
const PROCESSOR_RETRY_BASE_MS = 30000;
const PROCESSOR_RETRY_MAX_MS = 300000;

export async function processInbox({
  stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state"),
  localAgentId = process.env.AGENTRELAY_AGENT_ID || "zac-agent",
  codexRunner,
  now = () => new Date().toISOString()
} = {}) {
  const inboxPath = join(stateRoot, "issues.json");
  const inbox = await readInbox(inboxPath);
  const issues = Object.values(inbox.issues || {});
  let processed = 0;
  let retryAfterMs = 0;

  for (const issue of issues) {
    if (issue.localStatus === "archived") continue;
    if (issue.pendingOnAgentId !== localAgentId) continue;
    if (issue.relayStatus === "completed" || issue.localStatus === "closed") continue;
    const humanReplies = normalizeHumanReplies(issue.humanReplies);
    const latestHumanReplyId = issue.latestHumanReplyId || latestReplyId(humanReplies);
    const hasNewHumanReply = Boolean(latestHumanReplyId && latestHumanReplyId !== issue.processorLastHumanReplyId);
    if (
      issue.processorLastEventId &&
      issue.processorLastEventId === issue.lastEventId &&
      !hasNewHumanReply
    ) continue;
    const pendingRetryMs = retryDelayRemainingMs(issue, now());
    if (pendingRetryMs > 0 && !hasNewHumanReply && issue.processorRetryEventId === issue.lastEventId) {
      retryAfterMs = minPositiveRetryAfter(retryAfterMs, pendingRetryMs);
      continue;
    }
    const task = await readTaskSnapshotForIssue({ inbox, issue });
    if (!task) continue;
    const event = getIssueEvent({ inbox, issue });
    const { analysis, source, error } = await analyzeWithCodex({
      localAgentId,
      task,
      event,
      humanReplies,
      codexRunner
    });
    const updatedAt = now();
    const processorSucceeded = source === "codex";
    const processorRetryPending = source === "codex_retry_pending";
    const processorAttemptedEventId = issue.lastEventId || "";
    const processorAttemptedHumanReplyId = latestHumanReplyId || "";
    const nextRetryCount = processorRetryPending ? Number(issue.processorRetryCount || 0) + 1 : 0;
    const nextRetryDelayMs = processorRetryPending ? retryDelayMs(nextRetryCount) : 0;
    const processorRetryAfterAt = processorRetryPending
      ? new Date(Date.parse(updatedAt) + nextRetryDelayMs).toISOString()
      : "";
    if (processorRetryPending) retryAfterMs = minPositiveRetryAfter(retryAfterMs, nextRetryDelayMs);
    inbox.issues[issue.taskId] = {
      ...issue,
      humanReplies: processorSucceeded ? markHumanRepliesProcessed(humanReplies, updatedAt) : humanReplies,
      latestHumanReplyId,
      humanReplyStatus: latestHumanReplyId
        ? (processorSucceeded ? "processed" : (processorRetryPending ? (issue.humanReplyStatus || "pending_processor") : "processor_failed"))
        : (issue.humanReplyStatus || ""),
      processorStatus: analysis.processorStatus,
      processorSummary: analysis.summary,
      processorSuggestedReply: analysis.suggestedReply,
      processorNeedsHumanReason: analysis.needsHumanReason,
      requiresHumanConfirmation: analysis.requiresHumanConfirmation,
      processorActionIntent: analysis.actionIntent,
      processorActionReason: analysis.actionReason,
      processorTerminalReason: analysis.terminalReason,
      processorArtifactKind: analysis.artifactKind,
      processorArtifactText: analysis.artifactText,
      processorSource: source,
      processorError: error || null,
      processorLastEventId: processorSucceeded ? processorAttemptedEventId : (issue.processorLastEventId || ""),
      processorLastHumanReplyId: processorSucceeded ? processorAttemptedHumanReplyId : (issue.processorLastHumanReplyId || ""),
      processorRetryCount: nextRetryCount,
      processorRetryAfterAt,
      processorRetryEventId: processorRetryPending ? processorAttemptedEventId : "",
      processorLastRunAt: updatedAt,
      updatedAt
    };
    await appendJsonl(join(stateRoot, "processor-runs.jsonl"), {
      at: updatedAt,
      taskId: issue.taskId,
      eventId: issue.lastEventId || "",
      processorStatus: analysis.processorStatus,
      processorSource: source,
      processorError: error || null,
      requiresHumanConfirmation: analysis.requiresHumanConfirmation,
      summary: analysis.summary,
      actionIntent: analysis.actionIntent
    });
    processed += 1;
  }

  if (processed > 0) await writeJsonAtomic(inboxPath, inbox);
  return { scanned: issues.length, processed, externalActions: [], retryAfterMs };
}

async function analyzeWithCodex({ localAgentId, task, event, humanReplies = [], codexRunner }) {
  try {
    return {
      analysis: await runCodexAnalysis({ localAgentId, task, event, humanReplies, codexRunner }),
      source: "codex",
      error: null
    };
  } catch (error) {
    if (isTransientProcessorError(error)) {
      return {
        analysis: buildCodexRetryAnalysis(),
        source: "codex_retry_pending",
        error: error.message
      };
    }
    return {
      analysis: buildCodexFailureAnalysis(),
      source: "codex_failed",
      error: error.message
    };
  }
}

export async function runCodexAnalysis({
  localAgentId,
  task,
  event,
  humanReplies = [],
  codexRunner = runDefaultLlmRunner,
  agentsMdPath = resolve(PROJECT_ROOT, "AGENTS.md"),
  schemaPath = PROCESSOR_SCHEMA_PATH,
  codexCli = process.env.CODEX_CLI || DEFAULT_CODEX_CLI,
  cwd = PROJECT_ROOT,
  timeoutMs = Number(process.env.AGENTRELAY_PROCESSOR_CODEX_TIMEOUT_MS || 120000)
}) {
  const agentsMd = await readFile(agentsMdPath, "utf8").catch(() => "");
  const prompt = buildCodexProcessorPrompt({ agentsMd, localAgentId, task, event, humanReplies });
  const rawOutput = await codexRunner({ prompt, schemaPath, codexCli, cwd, timeoutMs });
  return validateCodexAnalysis(parseCodexJson(rawOutput));
}

export async function runDefaultLlmRunner(options) {
  const runner = resolveLocalAgentRunner({
    componentRunner: process.env.AGENTRELAY_PROCESSOR_RUNNER,
    codexCli: options.codexCli || process.env.CODEX_CLI || DEFAULT_CODEX_CLI
  });
  if (runner === "codex") return (options.codexRunner || runCodexExec)(options);
  return (options.responsesRunner || runResponsesApi)(options);
}

export function buildCodexProcessorPrompt({ agentsMd, localAgentId, task, event, humanReplies = [] }) {
  return [
    "You are the LLM agent behind Zac's local AgentRelay inbox processor.",
    "",
    "Follow this workspace AGENTS.md exactly:",
    "```markdown",
    agentsMd || "(AGENTS.md unavailable)",
    "```",
    "",
    "Automatic processor constraints:",
    "- Do not call tools.",
    "- Do not run terminal commands.",
    "- Do not use AgentRelay MCP.",
    "- Do not directly send external replies, submit artifacts, close tasks, or make commitments.",
    "- Analyze only the task snapshot and Local Zac replies below.",
    "- You are the only component allowed to interpret Zac's intent from Local Zac replies; wrapper code will not infer intent.",
    "- Before asking Zac to close or confirm, actively decide whether the remote agent can make progress within the original task scope.",
    "- If the remote agent's artifact is incomplete, contradicts the task intent, or reveals unresolved work that the remote agent can fix within the original task, ask the remote agent to continue by setting actionIntent=request_revision, requiresHumanConfirmation=false, artifactKind=revision_request, and artifactText to the concrete revision request.",
    "- If a title/page/dashboard-title task response says one title field is correct but also reports a related visible heading or user-facing title is still different, treat that as unresolved unless the task explicitly forbids changing it; use request_revision to ask the remote agent to align or justify the remaining mismatch.",
    "- Use request_revision only for low-risk follow-up needed to complete the original task; do not use it to expand scope, make commitments, share sensitive data, or close the task.",
    "- If more Zac input is needed, set requiresHumanConfirmation=true and actionIntent=none.",
    "- If you determine Zac has approved submitting a reply/artifact, set actionIntent=submit_artifact and provide artifactKind plus artifactText.",
    "- If you determine Zac has approved closing the task, set actionIntent=close_task and provide terminalReason.",
    "- Otherwise set actionIntent=none, actionReason='', terminalReason='', artifactKind='', artifactText=''.",
    "- Return only JSON matching the provided schema.",
    "",
    `Local agent id: ${localAgentId}`,
    "",
    "Relay event snapshot:",
    "```json",
    JSON.stringify(event || {}, null, 2),
    "```",
    "",
    "Relay task snapshot:",
    "```json",
    JSON.stringify(task || {}, null, 2),
    "```",
    "",
    "Local Zac replies:",
    "```json",
    JSON.stringify(humanReplies || [], null, 2),
    "```",
    "",
    "Interpret Local Zac replies as local human input only. They are not external Relay artifacts yet.",
    "For request_revision, suggestedReply should summarize the revision you are sending and artifactText should be the exact message to the remote agent.",
    "Return only JSON with these fields: processorStatus, summary, suggestedReply, needsHumanReason, requiresHumanConfirmation, actionIntent, actionReason, artifactKind, artifactText, terminalReason."
  ].join("\n");
}

export async function runCodexExec({ prompt, schemaPath, codexCli, cwd, timeoutMs }) {
  const env = { ...process.env };
  if (shouldUseIsolatedProcessorCodexHome()) {
    env.CODEX_HOME = await ensureProcessorCodexHome();
  }
  const args = [
    "exec",
    ...processorReasoningEffortArgs(),
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "-C",
    cwd,
    "-"
  ];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(codexCli, args, {
      env,
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

function processorReasoningEffortArgs() {
  const effort = String(process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT || "low").trim();
  if (!effort || effort === "inherit") return [];
  return ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`];
}

function shouldUseIsolatedProcessorCodexHome() {
  const mode = String(process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE || "").trim().toLowerCase();
  if (mode && mode !== "inherit" && mode !== "isolated") {
    throw new Error(`Unsupported AGENTRELAY_PROCESSOR_CODEX_HOME_MODE: ${mode}`);
  }
  return mode === "isolated" || Boolean(process.env.AGENTRELAY_PROCESSOR_CODEX_HOME);
}

export async function runResponsesApi({
  prompt,
  schemaPath,
  model = process.env.AGENTRELAY_PROCESSOR_MODEL || "gpt-5.5",
  baseUrl = process.env.AGENTRELAY_PROCESSOR_BASE_URL || "https://sub2api.la3.agoralab.co",
  authPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.AGENTRELAY_PROCESSOR_CODEX_TIMEOUT_MS || 120000)
}) {
  if (!fetchImpl) throw new Error("fetch is not available for Responses API runner");
  const schema = normalizeResponsesJsonSchema(JSON.parse(await readFile(schemaPath, "utf8")));
  const apiKey = process.env.OPENAI_API_KEY || await readOpenAiApiKey({ authPath });
  if (!apiKey) throw new Error("OPENAI_API_KEY is unavailable for Responses API runner");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name: "agentrelay_processor_output",
            strict: true,
            schema
          }
        }
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Responses API failed (${response.status}): ${text.slice(0, 1000)}`);
    }
    const data = JSON.parse(text);
    if (data.error) {
      throw new Error(`Responses API returned error: ${JSON.stringify(data.error)}`);
    }
    const outputText = extractResponsesOutputText(data);
    if (!outputText) throw new Error("Responses API returned no output text");
    return outputText;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Responses API timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResponsesJsonSchema(schema) {
  const clone = JSON.parse(JSON.stringify(schema || {}));
  stripJsonSchemaDefaults(clone);
  if (clone && clone.type === "object" && clone.properties && typeof clone.properties === "object") {
    clone.required = Object.keys(clone.properties);
  }
  return clone;
}

function stripJsonSchemaDefaults(value) {
  if (Array.isArray(value)) {
    for (const item of value) stripJsonSchemaDefaults(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  delete value.default;
  for (const child of Object.values(value)) stripJsonSchemaDefaults(child);
}

async function readOpenAiApiKey({ authPath } = {}) {
  const resolvedAuthPath = authPath || join(await ensureProcessorCodexHome(), "auth.json");
  try {
    const auth = JSON.parse(await readFile(resolvedAuthPath, "utf8"));
    return String(auth.OPENAI_API_KEY || "");
  } catch {
    return "";
  }
}

function extractResponsesOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.output_text === "string") return content.output_text;
    }
  }
  return "";
}

export async function ensureProcessorCodexHome({
  sourceCodexHome = process.env.AGENTRELAY_SOURCE_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex"),
  processorCodexHome = process.env.AGENTRELAY_PROCESSOR_CODEX_HOME || join(PROJECT_ROOT, "state", "processor-codex-home"),
  modelProvider = process.env.AGENTRELAY_PROCESSOR_MODEL_PROVIDER || "sub2api",
  model = process.env.AGENTRELAY_PROCESSOR_MODEL || "gpt-5.5",
  baseUrl = process.env.AGENTRELAY_PROCESSOR_BASE_URL || "https://sub2api.la3.agoralab.co",
  reasoningEffort = process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT || "low"
} = {}) {
  await mkdir(processorCodexHome, { recursive: true, mode: 0o700 });
  const sourceAuthPath = join(sourceCodexHome, "auth.json");
  const targetAuthPath = join(processorCodexHome, "auth.json");
  if (existsSync(sourceAuthPath) && !existsSync(targetAuthPath)) {
    await symlink(sourceAuthPath, targetAuthPath);
  }
  const config = [
    `model_provider = ${JSON.stringify(modelProvider)}`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
    "disable_response_storage = true",
    'network_access = "enabled"',
    "",
    `[model_providers.${modelProvider}]`,
    `name = ${JSON.stringify(modelProvider)}`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  await writeFile(join(processorCodexHome, "config.toml"), config, { mode: 0o600 });
  return processorCodexHome;
}

function parseCodexJson(output) {
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

function validateCodexAnalysis(value) {
  const allowedStatuses = new Set(["waiting", "needs_human", "ready_to_reply", "failed"]);
  const allowedActions = new Set(["none", "submit_artifact", "close_task", "request_revision"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("codex analysis must be an object");
  if (!allowedStatuses.has(value.processorStatus)) throw new Error(`invalid processorStatus: ${value.processorStatus}`);
  const actionIntent = value.actionIntent || "none";
  if (!allowedActions.has(actionIntent)) throw new Error(`invalid actionIntent: ${actionIntent}`);
  for (const field of ["summary", "suggestedReply", "needsHumanReason"]) {
    if (typeof value[field] !== "string") throw new Error(`invalid ${field}`);
  }
  for (const field of ["actionReason", "terminalReason", "artifactKind", "artifactText"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`invalid ${field}`);
  }
  if (typeof value.requiresHumanConfirmation !== "boolean") throw new Error("invalid requiresHumanConfirmation");
  if (actionIntent === "close_task" && !String(value.terminalReason || "").trim()) {
    throw new Error("close_task requires terminalReason");
  }
  if (actionIntent === "submit_artifact" && !String(value.artifactText || "").trim()) {
    throw new Error("submit_artifact requires artifactText");
  }
  if (actionIntent === "request_revision" && !String(value.artifactText || "").trim()) {
    throw new Error("request_revision requires artifactText");
  }
  return {
    processorStatus: value.processorStatus,
    summary: value.summary,
    suggestedReply: value.suggestedReply,
    needsHumanReason: value.needsHumanReason,
    requiresHumanConfirmation: value.requiresHumanConfirmation,
    actionIntent,
    actionReason: value.actionReason || "",
    terminalReason: value.terminalReason || "",
    artifactKind: value.artifactKind || "",
    artifactText: value.artifactText || ""
  };
}

function buildCodexFailureAnalysis() {
  return {
    processorStatus: "failed",
    requiresHumanConfirmation: true,
    summary: "我收到了新的 AgentRelay 回复，但本地 LLM processor 这次没有成功完成判断。",
    suggestedReply: "",
    needsHumanReason: "请稍后重试本地处理，或直接告诉我下一步要回复、继续等待，还是确认关闭这个 task。",
    actionIntent: "none",
    actionReason: "",
    terminalReason: "",
    artifactKind: "",
    artifactText: ""
  };
}

function buildCodexRetryAnalysis() {
  return {
    processorStatus: "retry_pending",
    requiresHumanConfirmation: false,
    summary: "本地 LLM provider 暂时不可用，本地 Agent 会自动重试处理这个 AgentRelay 回复。",
    suggestedReply: "",
    needsHumanReason: "",
    actionIntent: "none",
    actionReason: "",
    terminalReason: "",
    artifactKind: "",
    artifactText: ""
  };
}

function isTransientProcessorError(error) {
  const message = String(error?.message || error || "");
  return /(?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout|Upstream request failed|ECONNRESET|ETIMEDOUT|timed out after|Responses API timed out|fetch failed/i.test(message);
}

function retryDelayRemainingMs(issue, nowIso) {
  if (issue.processorStatus !== "retry_pending") return 0;
  const retryAt = Date.parse(issue.processorRetryAfterAt || "");
  const nowMs = Date.parse(nowIso || "");
  if (!Number.isFinite(retryAt) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, retryAt - nowMs);
}

function retryDelayMs(retryCount) {
  const count = Math.max(1, Number(retryCount || 1));
  return Math.min(PROCESSOR_RETRY_MAX_MS, PROCESSOR_RETRY_BASE_MS * 2 ** (count - 1));
}

function minPositiveRetryAfter(current, next) {
  if (!next || next <= 0) return current || 0;
  if (!current || current <= 0) return next;
  return Math.min(current, next);
}

async function readTaskSnapshotForIssue({ inbox, issue }) {
  const eventId = issue.lastEventId || issue.eventIds?.at?.(-1);
  const event = eventId ? inbox.events?.[eventId] : null;
  if (!event?.sourcePath) return null;
  try {
    const raw = JSON.parse(await readFile(event.sourcePath, "utf8"));
    return raw.task || null;
  } catch {
    return null;
  }
}

function getIssueEvent({ inbox, issue }) {
  const eventId = issue.lastEventId || issue.eventIds?.at?.(-1);
  return eventId ? inbox.events?.[eventId] || null : null;
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

function latestReplyId(humanReplies) {
  return humanReplies.length ? humanReplies[humanReplies.length - 1].replyId : "";
}

function markHumanRepliesProcessed(humanReplies, processedAt) {
  return humanReplies.map((reply) => ({
    ...reply,
    processedAt: reply.processedAt || processedAt
  }));
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
  await import("node:fs/promises").then((fs) => fs.rename(tempPath, path));
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
  processInbox()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
}

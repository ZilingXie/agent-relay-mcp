#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexCliJsonPrompt } from "./agentrelay-codex-json-prompt.mjs";
import { resolveLocalAgentRunner } from "./agentrelay-local-agent-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const envPath = process.env.AGENTRELAY_ENV_PATH || resolve(PROJECT_ROOT, ".env");
loadDotEnv(envPath);

const DEFAULT_CODEX_CLI = "/Applications/Codex.app/Contents/Resources/codex";
const PROCESSOR_SCHEMA_PATH = resolve(PROJECT_ROOT, "schemas/processor-output.schema.json");

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

  for (const issue of issues) {
    if (issue.localStatus === "archived") continue;
    if (!shouldProcessIssue({ issue, localAgentId })) continue;
    if (issue.relayStatus === "completed" || issue.localStatus === "closed") continue;
    const humanReplies = normalizeHumanReplies(issue.humanReplies);
    const latestHumanReplyId = issue.latestHumanReplyId || latestReplyId(humanReplies);
    const hasNewHumanReply = Boolean(latestHumanReplyId && latestHumanReplyId !== issue.processorLastHumanReplyId);
    const hasLocalProcessorWork = issue.humanReplyStatus === "pending_processor" || hasActiveFileAccessGrant(issue);
    if (
      issue.processorLastEventId &&
      issue.processorLastEventId === issue.lastEventId &&
      !hasNewHumanReply &&
      !hasLocalProcessorWork
    ) continue;
    const task = await readTaskSnapshotForIssue({ inbox, issue });
    if (!task) continue;
    const event = getIssueEvent({ inbox, issue });
    const inputFingerprint = buildProcessorInputFingerprint({ issue, task, event, humanReplies, latestHumanReplyId });
    if (issue.processorLastInputFingerprint && issue.processorLastInputFingerprint === inputFingerprint) continue;
    const { analysis, source, error } = await analyzeWithCodex({
      localAgentId,
      stateRoot,
      task,
      event,
      humanReplies,
      fileAccessGrants: issue.fileAccessGrants,
      codexRunner
    });
    const updatedAt = now();
    const processorSucceeded = source === "codex";
    const processorAttemptedEventId = issue.lastEventId || "";
    const processorAttemptedHumanReplyId = latestHumanReplyId || "";
    const localAgentSession = updateLocalAgentSession({
      session: issue.localAgentSession,
      taskId: issue.taskId,
      localAgentId,
      updatedAt
    });
    const processorRun = buildProcessorRun({
      issue,
      localAgentSession,
      inputFingerprint,
      updatedAt,
      analysis,
      source,
      error
    });
    const outbox = mergeOutboxEntries({
      existingOutbox: issue.outbox,
      entries: buildOutboxEntries({
        issue,
        analysis,
        localAgentId,
        inputFingerprint,
        createdAt: updatedAt
      })
    });
    const fileAccessRequests = mergeFileAccessRequests({
      existingRequests: issue.fileAccessRequests,
      requests: analysis.fileAccessRequests,
      inputFingerprint,
      createdAt: updatedAt
    });
    inbox.issues[issue.taskId] = {
      ...issue,
      localAgentSession,
      processorRuns: [...normalizeProcessorRuns(issue.processorRuns), processorRun],
      inputFingerprint,
      fileAccessRequests,
      humanReplies: processorSucceeded ? markHumanRepliesProcessed(humanReplies, updatedAt) : humanReplies,
      latestHumanReplyId,
      humanReplyStatus: latestHumanReplyId
        ? (processorSucceeded ? "processed" : "processor_failed")
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
      processorAmendedDoneCriteria: analysis.amendedDoneCriteria,
      processorPreviousGoalDisposition: analysis.previousGoalDisposition,
      processorAmendmentReason: analysis.amendmentReason,
      processorNewMaxTurns: analysis.newMaxTurns,
      processorSource: source,
      processorError: error || null,
      processorLastEventId: processorSucceeded ? processorAttemptedEventId : (issue.processorLastEventId || ""),
      processorLastHumanReplyId: processorSucceeded ? processorAttemptedHumanReplyId : (issue.processorLastHumanReplyId || ""),
      processorLastInputFingerprint: processorSucceeded ? inputFingerprint : (issue.processorLastInputFingerprint || ""),
      outbox,
      processorRetryCount: 0,
      processorRetryAfterAt: "",
      processorRetryEventId: "",
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
  return { scanned: issues.length, processed, externalActions: [] };
}

function shouldProcessIssue({ issue, localAgentId }) {
  if (issue.pendingOnAgentId === localAgentId) return true;
  if (issue.humanReplyStatus === "pending_processor") return true;
  return hasActiveFileAccessGrant(issue);
}

function hasActiveFileAccessGrant(issue) {
  return Array.isArray(issue.fileAccessGrants) &&
    issue.fileAccessGrants.some((grant) => grant?.status === "active" && grant?.path);
}

async function analyzeWithCodex({ localAgentId, stateRoot, task, event, humanReplies = [], fileAccessGrants = [], codexRunner }) {
  try {
    return {
      analysis: await runCodexAnalysis({ localAgentId, stateRoot, task, event, humanReplies, fileAccessGrants, codexRunner }),
      source: "codex",
      error: null
    };
  } catch (error) {
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
  fileAccessGrants = [],
  codexRunner = runDefaultLlmRunner,
  agentsMdPath = resolve(PROJECT_ROOT, "AGENTS.md"),
  stateRoot = process.env.AGENTRELAY_STATE_DIR || join(PROJECT_ROOT, "state"),
  fileAccessWhitelistPath = join(stateRoot, "file-access-whitelist.json"),
  schemaPath = PROCESSOR_SCHEMA_PATH,
  codexCli = process.env.CODEX_CLI || DEFAULT_CODEX_CLI,
  cwd = PROJECT_ROOT,
  timeoutMs = Number(process.env.AGENTRELAY_PROCESSOR_CODEX_TIMEOUT_MS || 120000)
}) {
  const agentsMd = await readFile(agentsMdPath, "utf8").catch(() => "");
  const fileAccessWhitelist = await readFileAccessWhitelist(fileAccessWhitelistPath, { defaultRoot: resolve(stateRoot, "..") });
  const effectiveFileAccess = buildEffectiveFileAccess({ fileAccessWhitelist, fileAccessGrants });
  const prompt = buildCodexProcessorPrompt({
    agentsMd,
    localAgentId,
    task,
    event,
    humanReplies,
    fileAccessWhitelist: effectiveFileAccess,
    fileAccessGrants
  });
  const rawOutput = await codexRunner({
    prompt,
    schemaPath,
    codexCli,
    cwd,
    timeoutMs,
    sandboxMode: "workspace-write",
    writableRoots: effectiveFileAccess.roots.map((root) => root.path).filter((root) => existsSync(root))
  });
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

export function buildCodexProcessorPrompt({ agentsMd, localAgentId, task, event, humanReplies = [], fileAccessWhitelist = null, fileAccessGrants = [] }) {
  return [
    "You are the LLM agent behind Zac's local AgentRelay inbox processor.",
    "",
    "Follow this workspace AGENTS.md exactly:",
    "```markdown",
    agentsMd || "(AGENTS.md unavailable)",
    "```",
    "",
    "Automatic processor constraints:",
    "- You may use local Codex tools, shell commands, configured MCP tools, and network access when needed to complete the task.",
    "- You may use AgentRelay MCP read-only operations when useful for fresh task context.",
    "- Do not directly mutate AgentRelay state through MCP/server calls: do not create tasks, submit artifacts, close tasks, or send external replies directly.",
    "- Any AgentRelay state-changing reply must be returned as a structured outbox JSON action; the local guardrail will validate and send it.",
    "- You may inspect and modify files inside the allowed filesystem roots when needed to complete the task.",
    "- Respect the file access whitelist. If the task requires reading or writing outside these roots, do not claim access and do not guess file contents; set requiresHumanConfirmation=true, actionIntent=none, and ask Zac to approve adding that folder to the whitelist.",
    "- Analyze the task snapshot, Local Zac replies, allowed files you can access, and AGENTS.md.",
    "- You are the only component allowed to interpret Zac's intent from Local Zac replies; wrapper code will not infer intent.",
    "- Before asking Zac to close or confirm, actively decide whether the remote agent can make progress within the original task scope.",
    "- If the remote agent's artifact is incomplete, contradicts the task intent, or reveals unresolved work that the remote agent can fix within the original task, ask the remote agent to continue by setting actionIntent=request_revision, requiresHumanConfirmation=false, artifactKind=revision_request, and artifactText to the concrete revision request.",
    "- If a title/page/dashboard-title task response says one title field is correct but also reports a related visible heading or user-facing title is still different, treat that as unresolved unless the task explicitly forbids changing it; use request_revision to ask the remote agent to align or justify the remaining mismatch.",
    "- Use request_revision only for low-risk follow-up needed to complete the original task; do not use it to expand scope, make commitments, share sensitive data, or close the task.",
    "- If fresh Zac input changes or clarifies the task goal/done criteria rather than merely asking the remote agent to fix the current goal, set actionIntent=amend_task. Provide amendedDoneCriteria, previousGoalDisposition, amendmentReason, and optionally newMaxTurns. This records a human-authorized goal_version change and starts a new agent-agent exchange.",
    "- If more Zac input is needed, set requiresHumanConfirmation=true and actionIntent=none.",
    "- If you determine Zac has approved submitting a reply/artifact, set actionIntent=submit_artifact and provide artifactKind plus artifactText.",
    "- Only ask Zac to confirm closing, or set actionIntent=close_task, when task.completion_owner_agent_id equals the local agent id.",
    "- If task.completion_owner_agent_id is a different agent and the done criteria appears satisfied or that completion owner reports completion, do not ask Zac to close it. Set processorStatus=waiting, requiresHumanConfirmation=false, actionIntent=none, suggestedReply='', needsHumanReason='', and state that you are waiting for the completion owner to call close_task.",
    "- If task.completion_owner_agent_id is a different agent but fresh Zac input is genuinely needed to answer that agent, set requiresHumanConfirmation=true and actionIntent=none.",
    "- If you need access to a folder outside the allowed roots, include fileAccessRequests with path, reason, and access; otherwise return an empty array.",
    "- If you determine Zac has approved closing a task owned by the local agent, set actionIntent=close_task and provide terminalReason.",
    "- Otherwise set actionIntent=none, actionReason='', terminalReason='', artifactKind='', artifactText=''.",
    "- Return only JSON matching the provided schema.",
    "",
    `Local agent id: ${localAgentId}`,
    "",
    "Allowed filesystem roots:",
    "```json",
    JSON.stringify(normalizeFileAccessWhitelist(fileAccessWhitelist), null, 2),
    "```",
    "",
    "Active file access grants:",
    "```json",
    JSON.stringify(normalizeFileAccessGrants(fileAccessGrants), null, 2),
    "```",
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
    "For amend_task, suggestedReply should summarize the amended goal, amendedDoneCriteria should be the new completion standard, and amendmentReason should explain the human clarification.",
    "Return only JSON with these fields: processorStatus, summary, suggestedReply, needsHumanReason, requiresHumanConfirmation, actionIntent, actionReason, artifactKind, artifactText, terminalReason, amendedDoneCriteria, previousGoalDisposition, amendmentReason, newMaxTurns, fileAccessRequests."
  ].join("\n");
}

export async function runCodexExec({
  prompt,
  schemaPath,
  codexCli,
  cwd,
  timeoutMs,
  sandboxMode = "read-only",
  writableRoots = []
}) {
  const env = { ...process.env };
  if (shouldUseIsolatedProcessorCodexHome()) {
    env.CODEX_HOME = await ensureProcessorCodexHome();
  }
  const codexPrompt = await buildCodexCliJsonPrompt({
    prompt,
    schemaPath,
    schemaName: "agentrelay_processor_output"
  });
  const args = [
    "exec",
    ...processorReasoningEffortArgs(),
    "--config",
    'network_access="enabled"',
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    sandboxMode,
    ...normalizeWritableRoots(writableRoots).flatMap((root) => ["--add-dir", root]),
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
    child.stdin.end(codexPrompt);
  });
}

function normalizeWritableRoots(writableRoots) {
  return Array.isArray(writableRoots)
    ? [...new Set(writableRoots.map((root) => String(root || "").trim()).filter(Boolean))]
    : [];
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
  const allowedActions = new Set(["none", "submit_artifact", "close_task", "request_revision", "amend_task"]);
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
  for (const field of ["amendedDoneCriteria", "previousGoalDisposition", "amendmentReason"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`invalid ${field}`);
  }
  if (value.newMaxTurns !== undefined && value.newMaxTurns !== null && (!Number.isInteger(value.newMaxTurns) || value.newMaxTurns <= 0)) {
    throw new Error("invalid newMaxTurns");
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
  if (actionIntent === "amend_task" && !String(value.amendedDoneCriteria || "").trim()) {
    throw new Error("amend_task requires amendedDoneCriteria");
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
    artifactText: value.artifactText || "",
    amendedDoneCriteria: value.amendedDoneCriteria || "",
    previousGoalDisposition: value.previousGoalDisposition || "clarified",
    amendmentReason: value.amendmentReason || "",
    newMaxTurns: value.newMaxTurns || null,
    fileAccessRequests: normalizeFileAccessRequests(value.fileAccessRequests)
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
    artifactText: "",
    amendedDoneCriteria: "",
    previousGoalDisposition: "clarified",
    amendmentReason: "",
    newMaxTurns: null
  };
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

function buildProcessorInputFingerprint({ issue, task, event, humanReplies, latestHumanReplyId }) {
  return `pif_${hashText(JSON.stringify({
    taskId: issue.taskId || task?.task_id || "",
    lastEventId: issue.lastEventId || event?.eventId || "",
    latestHumanReplyId: latestHumanReplyId || "",
    task,
    humanReplies: humanReplies.map((reply) => ({
      replyId: reply.replyId,
      text: reply.text,
      createdAt: reply.createdAt
    })),
    fileAccessRequests: normalizeIssueFileAccessRequests(issue.fileAccessRequests),
    fileAccessGrants: normalizeFileAccessGrants(issue.fileAccessGrants)
  }))}`;
}

function updateLocalAgentSession({ session, taskId, localAgentId, updatedAt }) {
  const sessionId = session?.sessionId || `las_${hashText(`${localAgentId}:${taskId}`)}`;
  return {
    sessionId,
    taskId: String(session?.taskId || taskId || ""),
    localAgentId: String(session?.localAgentId || localAgentId || ""),
    createdAt: String(session?.createdAt || updatedAt || ""),
    updatedAt: String(updatedAt || session?.updatedAt || "")
  };
}

function normalizeProcessorRuns(runs) {
  return Array.isArray(runs) ? runs.filter((run) => run && typeof run === "object") : [];
}

function buildProcessorRun({ issue, localAgentSession, inputFingerprint, updatedAt, analysis, source, error }) {
  return {
    runId: `prun_${hashText(`${issue.taskId}:${inputFingerprint}:${updatedAt}`)}`,
    sessionId: localAgentSession.sessionId,
    taskId: issue.taskId,
    eventId: issue.lastEventId || "",
    humanReplyId: issue.latestHumanReplyId || "",
    inputFingerprint,
    status: analysis.processorStatus,
    source,
    error: error || null,
    actionIntent: analysis.actionIntent || "none",
    requiresHumanConfirmation: analysis.requiresHumanConfirmation,
    summary: analysis.summary,
    suggestedReply: analysis.suggestedReply || "",
    needsHumanReason: analysis.needsHumanReason || "",
    createdAt: updatedAt
  };
}

function buildOutboxEntries({ issue, analysis, localAgentId, inputFingerprint, createdAt }) {
  const actionIntent = analysis.actionIntent || "none";
  if (analysis.requiresHumanConfirmation || actionIntent === "none") return [];
  if (!new Set(["submit_artifact", "close_task", "request_revision"]).has(actionIntent)) return [];
  return [{
    outboxId: `out_${hashText(`${issue.taskId}:${inputFingerprint}:${actionIntent}:${analysis.artifactText || analysis.terminalReason || ""}`)}`,
    taskId: issue.taskId,
    source: "local_agent",
    sourceInputFingerprint: inputFingerprint,
    status: "pending_guardrail",
    actionIntent,
    actionReason: analysis.actionReason || "",
    fromAgentId: localAgentId,
    artifactKind: analysis.artifactKind || "",
    artifactText: analysis.artifactText || "",
    terminalReason: analysis.terminalReason || "",
    createdAt,
    updatedAt: createdAt
  }];
}

function mergeOutboxEntries({ existingOutbox, entries }) {
  const outbox = Array.isArray(existingOutbox) ? [...existingOutbox] : [];
  const seen = new Set(outbox.map((entry) => entry?.outboxId).filter(Boolean));
  for (const entry of entries) {
    if (seen.has(entry.outboxId)) continue;
    outbox.push(entry);
    seen.add(entry.outboxId);
  }
  return outbox;
}

function normalizeFileAccessRequests(requests) {
  return Array.isArray(requests)
    ? requests
      .filter((request) => request && typeof request === "object")
      .map((request) => ({
        path: String(request.path || "").trim(),
        reason: String(request.reason || "").trim(),
        access: normalizeFileAccessMode(request.access)
      }))
      .filter((request) => request.path && request.reason)
    : [];
}

function normalizeFileAccessMode(access) {
  const value = String(access || "read_write").trim();
  return new Set(["read", "write", "read_write"]).has(value) ? value : "read_write";
}

function mergeFileAccessRequests({ existingRequests, requests, inputFingerprint, createdAt }) {
  const existing = Array.isArray(existingRequests) ? [...existingRequests] : [];
  const seen = new Set(existing.map((request) => `${request.path}\u0000${request.reason}\u0000${request.status || "pending"}`));
  for (const request of requests || []) {
    const key = `${request.path}\u0000${request.reason}\u0000pending`;
    if (seen.has(key)) continue;
    existing.push({
      requestId: `far_${hashText(`${inputFingerprint}:${request.path}:${request.reason}`).slice(0, 16)}`,
      path: request.path,
      reason: request.reason,
      access: request.access,
      status: "pending",
      createdAt
    });
    seen.add(key);
  }
  return existing;
}

function normalizeIssueFileAccessRequests(requests) {
  return Array.isArray(requests)
    ? requests
      .filter((request) => request && typeof request === "object")
      .map((request) => ({
        requestId: String(request.requestId || ""),
        path: String(request.path || ""),
        reason: String(request.reason || ""),
        status: String(request.status || ""),
        decidedAt: String(request.decidedAt || "")
      }))
    : [];
}

function normalizeFileAccessGrants(grants) {
  return Array.isArray(grants)
    ? grants
      .filter((grant) => grant && typeof grant === "object")
      .map((grant) => ({
        grantId: String(grant.grantId || ""),
        requestId: String(grant.requestId || ""),
        path: String(grant.path || "").trim(),
        scope: String(grant.scope || ""),
        status: String(grant.status || ""),
        createdAt: String(grant.createdAt || "")
      }))
      .filter((grant) => grant.path)
    : [];
}

function buildEffectiveFileAccess({ fileAccessWhitelist, fileAccessGrants }) {
  const whitelist = normalizeFileAccessWhitelist(fileAccessWhitelist);
  const roots = [...whitelist.roots];
  const seen = new Set(roots.map((root) => root.path));
  for (const grant of normalizeFileAccessGrants(fileAccessGrants)) {
    if (grant.status !== "active" || seen.has(grant.path)) continue;
    roots.push({
      path: grant.path,
      label: grant.scope === "once" ? "One-time approved folder" : "Approved folder",
      source: grant.scope === "once" ? "grant_once" : "grant",
      createdAt: grant.createdAt || ""
    });
    seen.add(grant.path);
  }
  return { version: 1, roots };
}

function hashText(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 24);
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

async function readFileAccessWhitelist(path, { defaultRoot = PROJECT_ROOT } = {}) {
  if (!path || !existsSync(path)) return initialFileAccessWhitelist(defaultRoot);
  try {
    return normalizeFileAccessWhitelist(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return initialFileAccessWhitelist(defaultRoot);
  }
}

function normalizeFileAccessWhitelist(value) {
  const roots = Array.isArray(value?.roots) ? value.roots : [];
  return {
    version: 1,
    roots: roots
      .map((root) => ({
        path: String(root?.path || "").trim(),
        label: String(root?.label || "").trim(),
        source: String(root?.source || "").trim(),
        createdAt: String(root?.createdAt || "").trim()
      }))
      .filter((root) => root.path)
  };
}

function initialFileAccessWhitelist(defaultRoot) {
  return {
    version: 1,
    roots: [{
      path: resolve(defaultRoot),
      label: "AgentRelay install root",
      source: "default",
      createdAt: ""
    }]
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

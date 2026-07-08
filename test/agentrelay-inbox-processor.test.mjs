import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexProcessorPrompt,
  processInbox,
  ensureProcessorCodexHome,
  runCodexAnalysis,
  runCodexExec,
  runDefaultLlmRunner,
  runResponsesApi
} from "../scripts/agentrelay-inbox-processor.mjs";

test("processor runner inherits the local agent runner and defaults to Codex CLI", async () => {
  const previousRunner = process.env.AGENTRELAY_PROCESSOR_RUNNER;
  const previousLocalRunner = process.env.AGENTRELAY_LOCAL_AGENT_RUNNER;
  delete process.env.AGENTRELAY_PROCESSOR_RUNNER;
  delete process.env.AGENTRELAY_LOCAL_AGENT_RUNNER;
  const calls = [];
  try {
    const defaultOutput = await runDefaultLlmRunner({
      prompt: "processor prompt",
      schemaPath: "/tmp/schema.json",
      codexRunner: async () => {
        calls.push("codex");
        return "codex-output";
      },
      responsesRunner: async () => {
        calls.push("responses");
        throw new Error("responses runner should not be used by default");
      }
    });
    assert.equal(defaultOutput, "codex-output");
    assert.deepEqual(calls, ["codex"]);

    process.env.AGENTRELAY_LOCAL_AGENT_RUNNER = "responses";
    const responsesOutput = await runDefaultLlmRunner({
      prompt: "processor prompt",
      schemaPath: "/tmp/schema.json",
      codexRunner: async () => {
        calls.push("codex-after-responses");
        throw new Error("codex runner should not be used when responses is requested");
      },
      responsesRunner: async () => {
        calls.push("responses");
        return "responses-output";
      }
    });
    assert.equal(responsesOutput, "responses-output");
    assert.deepEqual(calls, ["codex", "responses"]);

    process.env.AGENTRELAY_PROCESSOR_RUNNER = "codex";
    const overrideOutput = await runDefaultLlmRunner({
      prompt: "processor prompt",
      schemaPath: "/tmp/schema.json",
      codexRunner: async () => {
        calls.push("codex-override");
        return "codex-override-output";
      },
      responsesRunner: async () => {
        calls.push("responses-after-override");
        throw new Error("responses runner should not be used when processor override requests codex");
      }
    });
    assert.equal(overrideOutput, "codex-override-output");
    assert.deepEqual(calls, ["codex", "responses", "codex-override"]);
  } finally {
    if (previousRunner === undefined) {
      delete process.env.AGENTRELAY_PROCESSOR_RUNNER;
    } else {
      process.env.AGENTRELAY_PROCESSOR_RUNNER = previousRunner;
    }
    if (previousLocalRunner === undefined) {
      delete process.env.AGENTRELAY_LOCAL_AGENT_RUNNER;
    } else {
      process.env.AGENTRELAY_LOCAL_AGENT_RUNNER = previousLocalRunner;
    }
  }
});

test("processInbox passes task snapshots and Zac replies to the LLM processor", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    receivedAt: "2026-07-03T03:05:00.000Z",
    event: { eventId: "evt_llm_submit", type: "task.pending", agentId: "zac-agent", taskId: "task_llm_submit" },
    task: incomingTask({ taskId: "task_llm_submit" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_llm_submit: {
        taskId: "task_llm_submit",
        subject: "LLM submit task",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_llm_submit",
        latestHumanReplyId: "hr_submit",
        humanReplyStatus: "pending_processor",
        humanReplies: [{
          replyId: "hr_submit",
          taskId: "task_llm_submit",
          text: "确认，可以把这个结果回复给 Frank。",
          createdAt: "2026-07-03T03:05:30.000Z",
          processedAt: null
        }],
        eventIds: ["evt_llm_submit"],
        updatedAt: "2026-07-03T03:05:30.000Z"
      }
    },
    events: {
      evt_llm_submit: { eventId: "evt_llm_submit", taskId: "task_llm_submit", sourcePath: eventPath }
    }
  });
  const calls = [];

  const result = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async ({ prompt, schemaPath }) => {
      calls.push({ prompt, schemaPath });
      return JSON.stringify({
        processorStatus: "ready_to_reply",
        summary: "LLM prepared a result for Frank.",
        suggestedReply: "Send the prepared result.",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "submit_artifact",
        actionReason: "Zac approved sending the prepared result.",
        artifactKind: "text",
        artifactText: "Frank, Zac confirmed the requested result."
      });
    },
    now: () => "2026-07-03T03:06:00.000Z"
  });

  assert.equal(result.processed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /product Local Inbox agent rules/);
  assert.match(calls[0].prompt, /task_llm_submit/);
  assert.match(calls[0].prompt, /Local Zac replies/);
  assert.match(calls[0].prompt, /确认，可以把这个结果回复给 Frank/);
  assert.match(calls[0].schemaPath, /processor-output.schema.json/);

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_llm_submit;
  assert.equal(issue.processorSource, "codex");
  assert.equal(issue.processorActionIntent, "submit_artifact");
  assert.equal(issue.processorArtifactKind, "text");
  assert.equal(issue.processorArtifactText, "Frank, Zac confirmed the requested result.");
  assert.equal(issue.requiresHumanConfirmation, false);
  assert.equal(issue.humanReplyStatus, "processed");
  assert.equal(issue.processorLastHumanReplyId, "hr_submit");
});

test("processInbox records Codex failure without local fallback analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_codex_failed", type: "task.pending", agentId: "zac-agent", taskId: "task_codex_failed" },
    task: incomingTask({ taskId: "task_codex_failed" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_codex_failed: {
        taskId: "task_codex_failed",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_codex_failed",
        latestHumanReplyId: "hr_failed",
        humanReplyStatus: "pending_processor",
        humanReplies: [{
          replyId: "hr_failed",
          taskId: "task_codex_failed",
          text: "确认解决",
          createdAt: "2026-07-03T03:10:00.000Z",
          processedAt: null
        }],
        eventIds: ["evt_codex_failed"]
      }
    },
    events: {
      evt_codex_failed: { eventId: "evt_codex_failed", taskId: "task_codex_failed", sourcePath: eventPath }
    }
  });

  let attempts = 0;
  const result = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("codex unavailable");
    },
    now: () => "2026-07-03T03:10:30.000Z"
  });

  assert.equal(result.processed, 1);
  assert.equal(attempts, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_codex_failed;
  assert.equal(issue.processorSource, "codex_failed");
  assert.equal(issue.processorStatus, "failed");
  assert.equal(issue.processorActionIntent, "none");
  assert.equal(issue.processorArtifactText, "");
  assert.equal(issue.processorSummary, "本地 LLM processor 处理失败，将自动重试一次。");
  assert.match(issue.processorNeedsHumanReason, /原因：本地 LLM processor 执行失败。报错：codex unavailable/);
  assert.equal(issue.humanReplyStatus, "processor_failed");
  assert.equal(issue.humanReplies[0].processedAt, null);
  assert.equal(issue.processorLastEventId, "");
  assert.equal(issue.processorLastHumanReplyId, "");
  assert.equal(issue.processorRetryCount, 1);
  assert.equal(issue.processorRetryAfterAt, "2026-07-03T03:11:30.000Z");
  assert.equal(issue.processorRetryEventId, "evt_codex_failed");
  assert.match(issue.processorError, /codex unavailable/);

  const coolingDown = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("processor should not retry before retryAfterAt");
    },
    now: () => "2026-07-03T03:11:00.000Z"
  });
  assert.equal(coolingDown.processed, 0);
  assert.equal(attempts, 1);

  const second = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      return JSON.stringify({
        processorStatus: "needs_human",
        summary: "LLM processor recovered on retry.",
        suggestedReply: "请确认是否关闭这个任务。",
        needsHumanReason: "需要 Zac 确认关闭任务。",
        requiresHumanConfirmation: true,
        actionIntent: "none",
        actionReason: "",
        terminalReason: "",
        artifactKind: "",
        artifactText: ""
      });
    },
    now: () => "2026-07-03T03:11:30.000Z"
  });
  assert.equal(second.processed, 1);
  assert.equal(attempts, 2);
  const retriedInbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const retriedIssue = retriedInbox.issues.task_codex_failed;
  assert.equal(retriedIssue.processorSource, "codex");
  assert.equal(retriedIssue.processorStatus, "needs_human");
  assert.equal(retriedIssue.processorLastEventId, "evt_codex_failed");
  assert.equal(retriedIssue.processorLastHumanReplyId, "hr_failed");
  assert.equal(retriedIssue.humanReplyStatus, "processed");
  assert.equal(retriedIssue.humanReplies[0].processedAt, "2026-07-03T03:11:30.000Z");
});

test("processInbox stops retrying the same input after a second Codex failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-stop-retry-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_codex_stop", type: "task.pending", agentId: "zac-agent", taskId: "task_codex_stop" },
    task: incomingTask({ taskId: "task_codex_stop" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_codex_stop: {
        taskId: "task_codex_stop",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_codex_stop",
        eventIds: ["evt_codex_stop"]
      }
    },
    events: {
      evt_codex_stop: { eventId: "evt_codex_stop", taskId: "task_codex_stop", sourcePath: eventPath }
    }
  });

  let attempts = 0;
  const codexRunner = async () => {
    attempts += 1;
    throw new Error("codex exec exited with 1: ERROR: 429 Too Many Requests");
  };

  const first = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner,
    now: () => "2026-07-03T03:10:00.000Z"
  });
  assert.equal(first.processed, 1);
  assert.equal(attempts, 1);

  const second = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner,
    now: () => "2026-07-03T03:11:00.000Z"
  });
  assert.equal(second.processed, 1);
  assert.equal(attempts, 2);

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_codex_stop;
  assert.equal(issue.processorSource, "codex_failed");
  assert.equal(issue.processorStatus, "failed");
  assert.equal(issue.requiresHumanConfirmation, true);
  assert.equal(issue.processorRetryCount, 2);
  assert.equal(issue.processorRetryAfterAt, "");
  assert.equal(issue.processorRetryEventId, "");
  assert.equal(issue.processorLastInputFingerprint, issue.inputFingerprint);
  assert.equal(issue.processorSummary, "本地 LLM processor 连续两次失败，已停止自动重试。");
  assert.match(issue.processorNeedsHumanReason, /原因：本地 LLM processor 被限流。报错：codex exec exited with 1: ERROR: 429 Too Many Requests/);

  const third = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner,
    now: () => "2026-07-03T03:30:00.000Z"
  });
  assert.equal(third.processed, 0);
  assert.equal(attempts, 2);
});

test("processInbox records transient Codex provider failures as visible failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-fail-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_codex_502", type: "task.pending", agentId: "zac-agent", taskId: "task_codex_502" },
    task: incomingTask({ taskId: "task_codex_502" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_codex_502: {
        taskId: "task_codex_502",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_codex_502",
        eventIds: ["evt_codex_502"]
      }
    },
    events: {
      evt_codex_502: { eventId: "evt_codex_502", taskId: "task_codex_502", sourcePath: eventPath }
    }
  });

  let attempts = 0;
  const first = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("codex exec exited with 1: ERROR: unexpected status 502 Bad Gateway: Upstream request failed");
    },
    now: () => "2026-07-03T03:10:00.000Z"
  });

  assert.equal(first.processed, 1);
  assert.equal(attempts, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_codex_502;
  assert.equal(issue.processorSource, "codex_failed");
  assert.equal(issue.processorStatus, "failed");
  assert.equal(issue.requiresHumanConfirmation, true);
  assert.equal(issue.processorRetryCount, 1);
  assert.equal(issue.processorRetryAfterAt, "2026-07-03T03:11:00.000Z");
  assert.equal(issue.processorRetryEventId, "evt_codex_502");
  assert.equal(issue.processorLastEventId, "");
  assert.match(issue.processorError, /502 Bad Gateway/);
  assert.equal(issue.processorSummary, "本地 LLM processor 处理失败，将自动重试一次。");
  assert.match(issue.processorNeedsHumanReason, /原因：本地 LLM provider 临时不可用。报错：codex exec exited with 1: ERROR: unexpected status 502 Bad Gateway/);
});

test("runCodexExec inherits the user's Codex home by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-exec-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "const output = {",
    "  processorStatus: 'needs_human',",
    "  summary: process.env.CODEX_HOME || '',",
    "  suggestedReply: '',",
    "  needsHumanReason: 'confirm',",
    "  requiresHumanConfirmation: true,",
    "  actionIntent: 'none',",
    "  actionReason: '',",
    "  terminalReason: '',",
    "  artifactKind: '',",
    "  artifactText: ''",
    "};",
    "process.stdout.write(JSON.stringify(output));",
    ""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  const schemaPath = join(root, "schema.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object", properties: {} }));
  const previousCodexHome = process.env.CODEX_HOME;
  const previousMode = process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE;
  const userCodexHome = join(root, "user-codex-home");
  process.env.CODEX_HOME = userCodexHome;
  delete process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE;
  try {
    const output = await runCodexExec({
      prompt: "hello",
      schemaPath,
      codexCli: fakeCodex,
      cwd: root,
      timeoutMs: 5000
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.summary, userCodexHome);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousMode === undefined) {
      delete process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE;
    } else {
      process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE = previousMode;
    }
  }
});

test("runCodexExec applies processor reasoning effort as a per-run override", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-effort-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  processorStatus: 'needs_human',",
    "  summary: process.argv.slice(2).join(' '),",
    "  suggestedReply: '',",
    "  needsHumanReason: 'confirm',",
    "  requiresHumanConfirmation: true,",
    "  actionIntent: 'none',",
    "  actionReason: '',",
    "  terminalReason: '',",
    "  artifactKind: '',",
    "  artifactText: ''",
    "}));",
    ""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  const schemaPath = join(root, "schema.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object", properties: {} }));
  const previousEffort = process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT;
  process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT = "low";
  try {
    const output = await runCodexExec({
      prompt: "hello",
      schemaPath,
      codexCli: fakeCodex,
      cwd: root,
      timeoutMs: 5000
    });
    const parsed = JSON.parse(output);
    assert.match(parsed.summary, /--config model_reasoning_effort="low"/);
  } finally {
    if (previousEffort === undefined) {
      delete process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT;
    } else {
      process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT = previousEffort;
    }
  }
});

test("runCodexExec embeds schema in stdin instead of using Codex CLI output-schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-json-prompt-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  const schemaPath = join(root, "schema.json");
  await writeFile(schemaPath, JSON.stringify({
    type: "object",
    properties: {
      processorStatus: { type: "string", enum: ["waiting"] },
      summary: { type: "string" }
    }
  }));
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "let stdin = '';",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({",
    "    processorStatus: 'needs_human',",
    "    summary: JSON.stringify({ args: process.argv.slice(2), stdin }),",
    "    suggestedReply: '',",
    "    needsHumanReason: 'confirm',",
    "    requiresHumanConfirmation: true,",
    "    actionIntent: 'none',",
    "    actionReason: '',",
    "    terminalReason: '',",
    "    artifactKind: '',",
    "    artifactText: ''",
    "  }));",
    "});",
    ""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  const output = await runCodexExec({
    prompt: "processor prompt",
    schemaPath,
    codexCli: fakeCodex,
    cwd: root,
    timeoutMs: 5000
  });
  const parsed = JSON.parse(output);
  const captured = JSON.parse(parsed.summary);
  assert.equal(captured.args.includes("--output-schema"), false);
  assert.equal(captured.args.includes(schemaPath), false);
  assert.match(captured.stdin, /processor prompt/);
  assert.match(captured.stdin, /Codex CLI JSON output instructions/);
  assert.match(captured.stdin, /agentrelay_processor_output/);
  assert.match(captured.stdin, /"processorStatus"/);
});

test("runCodexExec uses workspace-write and add-dir roots for local agent file access", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-sandbox-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  const schemaPath = join(root, "schema.json");
  const skillRoot = join(root, "skills");
  const projectRoot = join(root, "project");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(schemaPath, JSON.stringify({ type: "object", properties: {} }));
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  processorStatus: 'waiting',",
    "  summary: JSON.stringify({ args: process.argv.slice(2) }),",
    "  suggestedReply: '',",
    "  needsHumanReason: '',",
    "  requiresHumanConfirmation: false,",
    "  actionIntent: 'none',",
    "  actionReason: '',",
    "  terminalReason: '',",
    "  artifactKind: '',",
    "  artifactText: ''",
    "}));",
    ""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  const output = await runCodexExec({
    prompt: "processor prompt",
    schemaPath,
    codexCli: fakeCodex,
    cwd: projectRoot,
    timeoutMs: 5000,
    sandboxMode: "workspace-write",
    writableRoots: [skillRoot]
  });

  const parsed = JSON.parse(output);
  const captured = JSON.parse(parsed.summary);
  assert.deepEqual(captured.args.slice(captured.args.indexOf("--sandbox"), captured.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  assert.equal(captured.args.includes("--add-dir"), true);
  assert.equal(captured.args[captured.args.indexOf("--add-dir") + 1], skillRoot);
});

test("ensureProcessorCodexHome creates an isolated minimal Codex home", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-home-"));
  const sourceCodexHome = join(root, "source-codex");
  const processorCodexHome = join(root, "processor-codex");
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(join(sourceCodexHome, "auth.json"), "{\"token\":\"fake\"}\n", { mode: 0o600 });

  const result = await ensureProcessorCodexHome({
    sourceCodexHome,
    processorCodexHome,
    model: "gpt-test",
    modelProvider: "sub2api",
    baseUrl: "https://sub2api.la3.agoralab.co",
    reasoningEffort: "low"
  });

  assert.equal(result, processorCodexHome);
  const authLink = await lstat(join(processorCodexHome, "auth.json"));
  assert.equal(authLink.isSymbolicLink(), true);
  const config = await readFile(join(processorCodexHome, "config.toml"), "utf8");
  assert.match(config, /model_provider = "sub2api"/);
  assert.match(config, /model = "gpt-test"/);
  assert.match(config, /model_reasoning_effort = "low"/);
  assert.match(config, /base_url = "https:\/\/sub2api\.la3\.agoralab\.co"/);
  assert.doesNotMatch(config, /skills|hooks|mcp_servers|plugins/);
});

test("runCodexAnalysis validates the action allowlist and payload requirements", async () => {
  await assert.rejects(
    runCodexAnalysis({
      task: incomingTask(),
      event: { eventId: "evt_bad_action" },
      localAgentId: "zac-agent",
      codexRunner: async () => JSON.stringify({
        processorStatus: "ready_to_reply",
        summary: "bad",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "send_email"
      })
    }),
    /invalid actionIntent/
  );

  await assert.rejects(
    runCodexAnalysis({
      task: incomingTask(),
      event: { eventId: "evt_missing_artifact" },
      localAgentId: "zac-agent",
      codexRunner: async () => JSON.stringify({
        processorStatus: "ready_to_reply",
        summary: "missing artifact",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "submit_artifact",
        artifactKind: "text",
        artifactText: ""
      })
    }),
    /submit_artifact requires artifactText/
  );

  const revision = await runCodexAnalysis({
    task: incomingTask(),
    event: { eventId: "evt_revision" },
    localAgentId: "zac-agent",
    codexRunner: async () => JSON.stringify({
      processorStatus: "ready_to_reply",
      summary: "Remote result needs revision.",
      suggestedReply: "Ask the remote agent to update the visible heading too.",
      needsHumanReason: "",
      requiresHumanConfirmation: false,
      actionIntent: "request_revision",
      actionReason: "The remote result did not satisfy the full task intent.",
      artifactKind: "revision_request",
      artifactText: "Please update the visible heading to match the requested dashboard title.",
      terminalReason: ""
    })
  });
  assert.equal(revision.actionIntent, "request_revision");
  assert.equal(revision.artifactKind, "revision_request");
  assert.match(revision.artifactText, /visible heading/);
});

test("runCodexAnalysis reads the product Local Inbox template by default", async () => {
  let promptText = "";
  const analysis = await runCodexAnalysis({
    task: incomingTask({ taskId: "task_template_rules" }),
    event: { eventId: "evt_template_rules" },
    localAgentId: "zac-agent",
    codexRunner: async ({ prompt }) => {
      promptText = prompt;
      return JSON.stringify({
        processorStatus: "waiting",
        summary: "Waiting for the remote completion owner.",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "none",
        actionReason: "",
        artifactKind: "",
        artifactText: "",
        terminalReason: ""
      });
    }
  });

  assert.equal(analysis.processorStatus, "waiting");
  assert.match(promptText, /AgentRelay Local Inbox Template/);
  assert.doesNotMatch(promptText, /AgentRelay Development Rules/);
});

test("runCodexAnalysis accepts local file access requests from the local agent", async () => {
  const analysis = await runCodexAnalysis({
    task: incomingTask({ taskId: "task_file_request" }),
    event: { eventId: "evt_file_request" },
    localAgentId: "zac-agent",
    codexRunner: async () => JSON.stringify({
      processorStatus: "needs_human",
      summary: "I need approval to inspect another folder.",
      suggestedReply: "",
      needsHumanReason: "Please approve access to /tmp/project.",
      requiresHumanConfirmation: true,
      actionIntent: "none",
      actionReason: "",
      artifactKind: "",
      artifactText: "",
      terminalReason: "",
      fileAccessRequests: [{
        path: "/tmp/project",
        reason: "Need to inspect the requested project files.",
        access: "read_write"
      }]
    })
  });

  assert.equal(analysis.fileAccessRequests.length, 1);
  assert.equal(analysis.fileAccessRequests[0].path, "/tmp/project");
  assert.equal(analysis.fileAccessRequests[0].access, "read_write");
});

test("processInbox stores local agent file access requests for UI approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-files-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_file_access", type: "task.pending", agentId: "zac-agent", taskId: "task_file_access" },
    task: incomingTask({ taskId: "task_file_access" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_file_access: {
        taskId: "task_file_access",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_file_access",
        eventIds: ["evt_file_access"]
      }
    },
    events: {
      evt_file_access: { eventId: "evt_file_access", taskId: "task_file_access", sourcePath: eventPath }
    }
  });

  await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => JSON.stringify({
      processorStatus: "needs_human",
      summary: "Need folder approval.",
      suggestedReply: "",
      needsHumanReason: "Approve /tmp/project.",
      requiresHumanConfirmation: true,
      actionIntent: "none",
      actionReason: "",
      artifactKind: "",
      artifactText: "",
      terminalReason: "",
      fileAccessRequests: [{
        path: "/tmp/project",
        reason: "Need to inspect project files.",
        access: "read_write"
      }]
    }),
    now: () => "2026-07-07T04:00:00.000Z"
  });

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const request = inbox.issues.task_file_access.fileAccessRequests[0];
  assert.match(request.requestId, /^far_/);
  assert.equal(request.status, "pending");
  assert.equal(request.path, "/tmp/project");
  assert.equal(request.reason, "Need to inspect project files.");
});

test("processInbox resumes local agent work after file access approval even while Relay is pending remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-grant-"));
  const stateRoot = join(root, "state");
  const allowedRoot = join(root, "approved-checkout");
  const eventPath = join(root, "event.json");
  await mkdir(allowedRoot, { recursive: true });
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_remote_pending_grant", type: "task.pending", agentId: "zac-agent", taskId: "task_remote_pending_grant" },
    task: incomingTask({ taskId: "task_remote_pending_grant" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_remote_pending_grant: {
        taskId: "task_remote_pending_grant",
        pendingOnAgentId: "vivi-agent",
        relayStatus: "delivery_pending",
        humanReplyStatus: "pending_processor",
        latestHumanReplyId: "hr_install",
        processorLastHumanReplyId: "hr_install",
        processorLastEventId: "evt_remote_pending_grant",
        processorLastInputFingerprint: "pif_old_without_grant",
        lastEventId: "evt_remote_pending_grant",
        humanReplies: [{
          replyId: "hr_install",
          taskId: "task_remote_pending_grant",
          text: "你按照步骤安装这个 skill。",
          createdAt: "2026-07-07T02:21:50.745Z",
          processedAt: "2026-07-07T02:22:54.582Z"
        }],
        fileAccessRequests: [{
          requestId: "far_checkout",
          path: allowedRoot,
          reason: "Need to inspect checkout.",
          status: "approved_once",
          createdAt: "2026-07-07T02:22:54.582Z",
          decidedAt: "2026-07-07T02:54:09.657Z"
        }],
        fileAccessGrants: [{
          grantId: "fag_checkout",
          requestId: "far_checkout",
          path: allowedRoot,
          scope: "once",
          status: "active",
          createdAt: "2026-07-07T02:54:09.657Z"
        }],
        eventIds: ["evt_remote_pending_grant"]
      }
    },
    events: {
      evt_remote_pending_grant: { eventId: "evt_remote_pending_grant", taskId: "task_remote_pending_grant", sourcePath: eventPath }
    }
  });
  const calls = [];

  const result = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async (options) => {
      calls.push(options);
      return JSON.stringify({
        processorStatus: "waiting",
        summary: "I resumed after file access approval.",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "none",
        actionReason: "",
        artifactKind: "",
        artifactText: "",
        terminalReason: "",
        fileAccessRequests: []
      });
    },
    now: () => "2026-07-07T03:00:00.000Z"
  });

  assert.equal(result.processed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].writableRoots.includes(allowedRoot), true);
  assert.match(calls[0].prompt, /Active file access grants/);
  assert.match(calls[0].prompt, new RegExp(allowedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_remote_pending_grant;
  assert.equal(issue.humanReplyStatus, "processed");
  assert.notEqual(issue.processorLastInputFingerprint, "pif_old_without_grant");
});

test("runResponsesApi sends the processor prompt with a JSON schema and extracts output text", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-responses-"));
  const authPath = join(root, "auth.json");
  const schemaPath = join(root, "schema.json");
  await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: "test-key" }));
  await writeFile(schemaPath, JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["processorStatus", "summary", "suggestedReply", "needsHumanReason", "requiresHumanConfirmation"],
    properties: {
      processorStatus: { type: "string" },
      summary: { type: "string" },
      suggestedReply: { type: "string" },
      needsHumanReason: { type: "string" },
      requiresHumanConfirmation: { type: "boolean" },
      actionIntent: { type: "string", default: "none" }
    }
  }));
  const requests = [];

  const output = await runResponsesApi({
    prompt: "processor prompt",
    schemaPath,
    authPath,
    model: "gpt-test",
    baseUrl: "https://example.test/api",
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: "{\"processorStatus\":\"needs_human\",\"summary\":\"ok\",\"suggestedReply\":\"\",\"needsHumanReason\":\"confirm\",\"requiresHumanConfirmation\":true}"
          }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(output, "{\"processorStatus\":\"needs_human\",\"summary\":\"ok\",\"suggestedReply\":\"\",\"needsHumanReason\":\"confirm\",\"requiresHumanConfirmation\":true}");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/api/responses");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "gpt-test");
  assert.equal(requests[0].body.input, "processor prompt");
  assert.equal(requests[0].body.text.format.type, "json_schema");
  assert.equal(requests[0].body.text.format.name, "agentrelay_processor_output");
  assert.equal(requests[0].body.text.format.strict, true);
  assert.equal(requests[0].body.text.format.schema.additionalProperties, false);
  assert.deepEqual(requests[0].body.text.format.schema.required, [
    "processorStatus",
    "summary",
    "suggestedReply",
    "needsHumanReason",
    "requiresHumanConfirmation",
    "actionIntent"
  ]);
  assert.equal("default" in requests[0].body.text.format.schema.properties.actionIntent, false);
});

test("buildCodexProcessorPrompt keeps intent interpretation inside the LLM agent", () => {
  const prompt = buildCodexProcessorPrompt({
    agentsMd: "Ask Zac before external replies.",
    localAgentId: "zac-agent",
    task: incomingTask({ taskId: "task_prompt" }),
    event: { eventId: "evt_prompt" },
    humanReplies: [{
      replyId: "hr_prompt",
      text: "Zac says yes.",
      createdAt: "2026-07-03T03:12:00.000Z"
    }]
  });

  assert.match(prompt, /Ask Zac before external replies/);
  assert.match(prompt, /task_prompt/);
  assert.match(prompt, /evt_prompt/);
  assert.match(prompt, /Zac says yes/);
  assert.match(prompt, /only component allowed to interpret Zac's intent/);
  assert.match(prompt, /submit_artifact/);
  assert.match(prompt, /request_revision/);
  assert.match(prompt, /ask the remote agent to continue/);
  assert.match(prompt, /visible heading or user-facing title is still different/);
  assert.match(prompt, /completion_owner_agent_id equals the local agent id/);
  assert.match(prompt, /waiting for the completion owner to call close_task/);
});

test("buildCodexProcessorPrompt tells the LLM to request approval for files outside the whitelist", () => {
  const prompt = buildCodexProcessorPrompt({
    agentsMd: "Ask before accessing private folders.",
    localAgentId: "zac-agent",
    task: incomingTask({ taskId: "task_files" }),
    event: { eventId: "evt_files" },
    humanReplies: [],
    fileAccessWhitelist: {
      version: 1,
      roots: [{
        path: "/Users/zac/project/agentRelay",
        label: "AgentRelay install root",
        source: "install",
        createdAt: "2026-07-06T01:02:03.000Z"
      }]
    }
  });

  assert.match(prompt, /Allowed filesystem roots/);
  assert.match(prompt, /\/Users\/zac\/project\/agentRelay/);
  assert.match(prompt, /outside these roots/);
  assert.match(prompt, /requiresHumanConfirmation=true/);
  assert.match(prompt, /approve adding that folder/);
});

test("buildCodexProcessorPrompt allows local tools and network while routing AgentRelay mutations through guardrail", () => {
  const prompt = buildCodexProcessorPrompt({
    agentsMd: "Use local tools when needed.",
    localAgentId: "zac-agent",
    task: incomingTask({ taskId: "task_agent_runtime" }),
    event: { eventId: "evt_agent_runtime" },
    humanReplies: []
  });

  assert.match(prompt, /may use local Codex tools/);
  assert.match(prompt, /network access/);
  assert.match(prompt, /AgentRelay MCP read-only/);
  assert.match(prompt, /outbox JSON action/);
  assert.doesNotMatch(prompt, /Do not use AgentRelay MCP/);
  assert.doesNotMatch(prompt, /Do not call tools/);
  assert.doesNotMatch(prompt, /Do not run terminal commands/);
});

test("runCodexExec enables network access for the local agent runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-codex-network-"));
  const fakeCodex = join(root, "fake-codex.mjs");
  const schemaPath = join(root, "schema.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object", properties: {} }));
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  processorStatus: 'waiting',",
    "  summary: JSON.stringify({ args: process.argv.slice(2) }),",
    "  suggestedReply: '',",
    "  needsHumanReason: '',",
    "  requiresHumanConfirmation: false,",
    "  actionIntent: 'none',",
    "  actionReason: '',",
    "  terminalReason: '',",
    "  artifactKind: '',",
    "  artifactText: ''",
    "}));",
    ""
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  const output = await runCodexExec({
    prompt: "processor prompt",
    schemaPath,
    codexCli: fakeCodex,
    cwd: root,
    timeoutMs: 5000
  });

  const captured = JSON.parse(JSON.parse(output).summary);
  assert.equal(captured.args.includes("--config"), true);
  assert.equal(captured.args.includes("network_access=\"enabled\""), true);
});

test("runCodexAnalysis defaults the file whitelist to the install root next to state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-whitelist-"));
  const stateRoot = join(root, "state");
  let capturedPrompt = "";

  await runCodexAnalysis({
    localAgentId: "zac-agent",
    stateRoot,
    task: incomingTask({ taskId: "task_default_whitelist" }),
    event: { eventId: "evt_default_whitelist" },
    codexRunner: async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        processorStatus: "waiting",
        summary: "ok",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "none"
      });
    }
  });

  assert.match(capturedPrompt, /Allowed filesystem roots/);
  assert.match(capturedPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runCodexAnalysis runs the local agent with workspace-write access to whitelisted roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-access-"));
  const stateRoot = join(root, "state");
  const allowedRoot = join(root, "allowed-project");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(allowedRoot, { recursive: true });
  await writeFile(join(stateRoot, "file-access-whitelist.json"), JSON.stringify({
    version: 1,
    roots: [{
      path: allowedRoot,
      label: "Allowed project",
      source: "user",
      createdAt: "2026-07-07T01:00:00.000Z"
    }]
  }, null, 2));

  const calls = [];
  await runCodexAnalysis({
    localAgentId: "zac-agent",
    stateRoot,
    task: incomingTask({ taskId: "task_allowed_access" }),
    event: { eventId: "evt_allowed_access" },
    codexRunner: async (options) => {
      calls.push(options);
      return JSON.stringify({
        processorStatus: "waiting",
        summary: "checked",
        suggestedReply: "",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "none"
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sandboxMode, "workspace-write");
  assert.deepEqual(calls[0].writableRoots, [allowedRoot]);
});

test("processInbox records local agent session, processor runs, input fingerprint, and outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-runtime-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    event: { eventId: "evt_runtime", type: "task.pending", agentId: "zac-agent", taskId: "task_runtime" },
    task: incomingTask({ taskId: "task_runtime" })
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_runtime: {
        taskId: "task_runtime",
        subject: "Runtime state task",
        pendingOnAgentId: "zac-agent",
        lastEventId: "evt_runtime",
        latestHumanReplyId: "hr_runtime",
        humanReplyStatus: "pending_processor",
        humanReplies: [{
          replyId: "hr_runtime",
          taskId: "task_runtime",
          text: "请继续让 Hermes 修正标题。",
          createdAt: "2026-07-07T01:00:00.000Z",
          processedAt: null
        }],
        eventIds: ["evt_runtime"]
      }
    },
    events: {
      evt_runtime: { eventId: "evt_runtime", taskId: "task_runtime", sourcePath: eventPath }
    }
  });

  let attempts = 0;
  const first = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      return JSON.stringify({
        processorStatus: "ready_to_reply",
        summary: "I will ask Hermes to revise the title.",
        suggestedReply: "Ask Hermes to revise.",
        needsHumanReason: "",
        requiresHumanConfirmation: false,
        actionIntent: "request_revision",
        actionReason: "Hermes can continue within the original scope.",
        artifactKind: "revision_request",
        artifactText: "Please revise the title and verify again.",
        terminalReason: ""
      });
    },
    now: () => "2026-07-07T01:01:00.000Z"
  });

  assert.equal(first.processed, 1);
  assert.equal(attempts, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_runtime;
  assert.match(issue.localAgentSession.sessionId, /^las_/);
  assert.equal(issue.localAgentSession.taskId, "task_runtime");
  assert.equal(issue.localAgentSession.createdAt, "2026-07-07T01:01:00.000Z");
  assert.equal(issue.localAgentSession.updatedAt, "2026-07-07T01:01:00.000Z");
  assert.equal(issue.inputFingerprint.length > 12, true);
  assert.equal(issue.processorRuns.length, 1);
  assert.equal(issue.processorRuns[0].status, "ready_to_reply");
  assert.equal(issue.processorRuns[0].source, "codex");
  assert.equal(issue.processorRuns[0].inputFingerprint, issue.inputFingerprint);
  assert.equal(issue.processorRuns[0].suggestedReply, "Ask Hermes to revise.");
  assert.equal(issue.processorRuns[0].needsHumanReason, "");
  assert.equal(issue.outbox.length, 1);
  assert.equal(issue.outbox[0].status, "pending_guardrail");
  assert.equal(issue.outbox[0].actionIntent, "request_revision");
  assert.equal(issue.outbox[0].artifactText, "Please revise the title and verify again.");

  const second = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("duplicate input should not run the local agent");
    },
    now: () => "2026-07-07T01:02:00.000Z"
  });

  assert.equal(second.processed, 0);
  assert.equal(attempts, 1);
});

test("processInbox skips issues that are not pending on the local agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_remote_pending: {
        taskId: "task_remote_pending",
        subject: "Remote is still working",
        pendingOnAgentId: "project-hermes",
        eventIds: [],
        updatedAt: "2026-07-03T03:00:00.000Z"
      }
    },
    events: {}
  });

  const result = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    now: () => "2026-07-03T03:01:00.000Z"
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.processed, 0);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_remote_pending.processorStatus, undefined);
});

test("processInbox skips archived issues even when pending on the local agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_archived_pending: {
        taskId: "task_archived_pending",
        subject: "Archived pending task",
        pendingOnAgentId: "zac-agent",
        localStatus: "archived",
        relayStatus: "delivery_pending",
        lastEventId: "evt_archived_pending",
        eventIds: ["evt_archived_pending"],
        updatedAt: "2026-07-03T03:00:00.000Z"
      }
    },
    events: {
      evt_archived_pending: {
        eventId: "evt_archived_pending",
        taskId: "task_archived_pending",
        sourcePath: join(root, "missing-event.json")
      }
    }
  });
  let attempts = 0;

  const result = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("should not run");
    },
    now: () => "2026-07-03T03:01:00.000Z"
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.processed, 0);
  assert.equal(attempts, 0);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_archived_pending.processorStatus, undefined);
  assert.equal(inbox.issues.task_archived_pending.localStatus, "archived");
});

function incomingTask({ taskId = "task_llm_submit" } = {}) {
  return {
    task_id: taskId,
    subject: "Ask Zac for a short answer",
    requester_agent_id: "frank-agent",
    target_agent_id: "zac-agent",
    completion_owner_agent_id: "frank-agent",
    pending_on_agent_id: "zac-agent",
    pending_on_human_id: null,
    status: "delivery_pending",
    done_criteria: "Zac provides a short answer to Frank.",
    messages: [{
      from_agent_id: "frank-agent",
      to_agent_id: "zac-agent",
      role: "user",
      parts: [{ kind: "text", text: "Please ask Zac for a short answer." }]
    }]
  };
}

async function writeIssues(stateRoot, issues) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify(issues, null, 2));
}

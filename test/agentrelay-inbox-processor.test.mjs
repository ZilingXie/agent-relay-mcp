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
  assert.match(calls[0].prompt, /AGENTS.md/);
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
  assert.equal(issue.processorSummary, "我收到了新的 AgentRelay 回复，但本地 LLM processor 这次没有成功完成判断。");
  assert.equal(issue.processorNeedsHumanReason, "请稍后重试本地处理，或直接告诉我下一步要回复、继续等待，还是确认关闭这个 task。");
  assert.equal(issue.humanReplyStatus, "processor_failed");
  assert.equal(issue.humanReplies[0].processedAt, null);
  assert.equal(issue.processorLastEventId, "");
  assert.equal(issue.processorLastHumanReplyId, "");
  assert.match(issue.processorError, /codex unavailable/);

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

test("processInbox keeps transient Codex provider failures pending for automatic retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-processor-retry-"));
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
  assert.equal(first.retryAfterMs, 30000);
  assert.equal(attempts, 1);
  let inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  let issue = inbox.issues.task_codex_502;
  assert.equal(issue.processorSource, "codex_retry_pending");
  assert.equal(issue.processorStatus, "retry_pending");
  assert.equal(issue.requiresHumanConfirmation, false);
  assert.equal(issue.processorRetryCount, 1);
  assert.equal(issue.processorRetryAfterAt, "2026-07-03T03:10:30.000Z");
  assert.equal(issue.processorLastEventId, "");

  const skipped = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      throw new Error("should not retry before processorRetryAfterAt");
    },
    now: () => "2026-07-03T03:10:10.000Z"
  });
  assert.equal(skipped.processed, 0);
  assert.equal(skipped.retryAfterMs, 20000);
  assert.equal(attempts, 1);

  const recovered = await processInbox({
    stateRoot,
    localAgentId: "zac-agent",
    codexRunner: async () => {
      attempts += 1;
      return JSON.stringify({
        processorStatus: "needs_human",
        summary: "Remote agent reports the title was changed and verified.",
        suggestedReply: "",
        needsHumanReason: "请 Zac 验收是否可以关闭任务。",
        requiresHumanConfirmation: true,
        actionIntent: "none",
        actionReason: "",
        terminalReason: "",
        artifactKind: "",
        artifactText: ""
      });
    },
    now: () => "2026-07-03T03:10:31.000Z"
  });
  assert.equal(recovered.processed, 1);
  assert.equal(attempts, 2);
  inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  issue = inbox.issues.task_codex_502;
  assert.equal(issue.processorSource, "codex");
  assert.equal(issue.processorStatus, "needs_human");
  assert.equal(issue.processorRetryCount, 0);
  assert.equal(issue.processorRetryAfterAt, "");
  assert.equal(issue.processorLastEventId, "evt_codex_502");
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
  const previousCodexHome = process.env.CODEX_HOME;
  const previousMode = process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE;
  const userCodexHome = join(root, "user-codex-home");
  process.env.CODEX_HOME = userCodexHome;
  delete process.env.AGENTRELAY_PROCESSOR_CODEX_HOME_MODE;
  try {
    const output = await runCodexExec({
      prompt: "hello",
      schemaPath: join(root, "schema.json"),
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
  const previousEffort = process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT;
  process.env.AGENTRELAY_PROCESSOR_REASONING_EFFORT = "low";
  try {
    const output = await runCodexExec({
      prompt: "hello",
      schemaPath: join(root, "schema.json"),
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

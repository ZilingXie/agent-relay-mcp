import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildChatTimeline,
  classifyIssueFilter,
  createInboxUiServer,
  issueWorkflowStatus,
  isMainModulePath,
  loadInboxSnapshot
} from "../scripts/agentrelay-inbox-ui.mjs";

test("loadInboxSnapshot returns an empty inbox when issues.json is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const snapshot = await loadInboxSnapshot({
    stateRoot: join(root, "state"),
    now: () => "2026-07-02T08:00:00.000Z"
  });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.generatedAt, "2026-07-02T08:00:00.000Z");
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(snapshot.counts, {
    total: 0,
    incoming: 0,
    outgoing: 0,
    needsHuman: 0,
    closed: 0
  });
});

test("loadInboxSnapshot normalizes and sorts issues from issues.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_old: {
        taskId: "task_old",
        subject: "Older outgoing task",
        direction: "outgoing",
        counterpartAgentId: "project-hermes",
        pendingOnAgentId: "project-hermes",
        localStatus: "received",
        relayStatus: "submitted",
        eventIds: ["evt_old"],
        updatedAt: "2026-07-02T07:00:00.000Z"
      },
      task_new: {
        taskId: "task_new",
        subject: "New incoming question",
        direction: "incoming",
        counterpartAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        pendingOnHumanId: "zac",
        localStatus: "received",
        relayStatus: "delivery_pending",
        processorStatus: "ready_to_reply",
        processorSummary: "Artifact looks complete.",
        processorSuggestedReply: "建议回复内容",
        processorNeedsHumanReason: "需要 Zac 确认后发送。",
        requiresHumanConfirmation: true,
        processorLastRunAt: "2026-07-02T08:00:30.000Z",
        eventIds: ["evt_new"],
        updatedAt: "2026-07-02T08:00:00.000Z"
      }
    },
    events: {
      evt_old: {
        eventId: "evt_old",
        taskId: "task_old",
        type: "task.pending",
        status: "received",
        ackStatus: "received",
        receivedAt: "2026-07-02T06:59:00.000Z"
      },
      evt_new: {
        eventId: "evt_new",
        taskId: "task_new",
        type: "task.pending",
        status: "received",
        receivedAt: "2026-07-02T07:59:00.000Z"
      }
    }
  });

  const snapshot = await loadInboxSnapshot({
    stateRoot,
    now: () => "2026-07-02T08:01:00.000Z"
  });

  assert.deepEqual(snapshot.counts, {
    total: 2,
    incoming: 1,
    outgoing: 1,
    needsHuman: 1,
    closed: 0
  });
  assert.equal(snapshot.issues[0].taskId, "task_new");
  assert.equal(snapshot.issues[0].eventCount, 1);
  assert.equal(snapshot.issues[0].latestEvent.eventId, "evt_new");
  assert.equal(snapshot.issues[0].needsHuman, true);
  assert.equal(snapshot.issues[0].processorStatus, "ready_to_reply");
  assert.equal(snapshot.issues[0].processorSummary, "Artifact looks complete.");
  assert.equal(snapshot.issues[0].requiresHumanConfirmation, true);
  assert.equal(Object.hasOwn(snapshot.issues[0], "codexDeliveryStatus"), false);
  assert.equal(Object.hasOwn(snapshot.issues[0], "codexThreadId"), false);
  assert.equal(snapshot.issues[1].taskId, "task_old");
  assert.equal(snapshot.issues[1].latestEvent.ackStatus, "received");
});

test("loadInboxSnapshot marks processor confirmation tasks as needing Zac", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_confirm: {
        taskId: "task_confirm",
        subject: "Confirm Hermes result",
        direction: "outgoing",
        counterpartAgentId: "project-hermes",
        pendingOnAgentId: "zac-agent",
        pendingOnHumanId: null,
        localStatus: "received",
        processorStatus: "ready_to_reply",
        processorSummary: "Hermes finished and awaits Zac approval.",
        requiresHumanConfirmation: true,
        updatedAt: "2026-07-02T08:00:00.000Z"
      },
      task_remote_revision: {
        taskId: "task_remote_revision",
        subject: "Hermes should continue",
        direction: "outgoing",
        counterpartAgentId: "project-hermes",
        pendingOnAgentId: "project-hermes",
        pendingOnHumanId: null,
        localStatus: "received",
        processorStatus: "ready_to_reply",
        processorSummary: "Asked Hermes to continue.",
        processorActionIntent: "request_revision",
        requiresHumanConfirmation: true,
        executorStatus: "completed",
        executorActionIntent: "request_revision",
        updatedAt: "2026-07-02T07:59:00.000Z"
      }
    },
    events: {}
  });

  const snapshot = await loadInboxSnapshot({
    stateRoot,
    now: () => "2026-07-02T08:01:00.000Z"
  });

  assert.equal(snapshot.counts.needsHuman, 1);
  assert.equal(snapshot.issues[0].needsHuman, true);
  assert.equal(snapshot.issues.find((issue) => issue.taskId === "task_remote_revision").needsHuman, false);
});

test("inbox UI server exposes issue list and per-task details", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    receivedAt: "2026-07-02T08:00:00.000Z",
    event: { eventId: "evt_detail", type: "task.pending" },
    task: {
      task_id: "task_detail",
      subject: "Inspect detail",
      messages: [{
        from_agent_id: "frank-agent",
        to_agent_id: "zac-agent",
        role: "user",
        parts: [{ kind: "text", text: "Please review this." }]
      }],
      artifacts: [{
        artifact_id: "art_detail",
        from_agent_id: "frank-agent",
        to_agent_id: "zac-agent",
        kind: "text",
        parts: [{ kind: "text", text: "Artifact body." }]
      }]
    }
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_detail: {
        taskId: "task_detail",
        subject: "Inspect detail",
        direction: "incoming",
        counterpartAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        localStatus: "received",
        processorStatus: "ready_to_reply",
        processorSummary: "LLM summary.",
        processorSuggestedReply: "LLM suggested reply.",
        processorLastRunAt: "2026-07-02T08:00:20.000Z",
        executorStatus: "completed",
        executorActionIntent: "submit_artifact",
        executorLastRunAt: "2026-07-02T08:00:30.000Z",
        latestHumanReplyId: "hr_detail",
        humanReplies: [{
          replyId: "hr_detail",
          taskId: "task_detail",
          text: "确认，可以回复。",
          createdAt: "2026-07-02T08:00:10.000Z",
          processedAt: "2026-07-02T08:00:20.000Z"
        }],
        eventIds: ["evt_detail"],
        updatedAt: "2026-07-02T08:00:00.000Z"
      }
    },
    events: {
      evt_detail: {
        eventId: "evt_detail",
        taskId: "task_detail",
        type: "task.pending",
        status: "received",
        sourcePath: eventPath,
        receivedAt: "2026-07-02T08:00:00.000Z"
      }
    }
  });

  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:01:00.000Z"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/issues`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.issues[0].taskId, "task_detail");

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/issues/task_detail`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.issue.taskId, "task_detail");
    assert.equal(detail.events[0].eventId, "evt_detail");
    assert.equal(detail.events[0].raw.task.subject, "Inspect detail");
    assert.deepEqual(detail.timeline.map((item) => item.type), [
      "relay_message",
      "artifact",
      "local_reply",
      "processor",
      "executor"
    ]);
    assert.equal(detail.timeline[0].text, "Please review this.");
    assert.equal(detail.timeline[1].text, "Artifact body.");
    assert.equal(detail.timeline[2].text, "确认，可以回复。");

    const missingResponse = await fetch(`http://127.0.0.1:${port}/api/issues/missing`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI detail falls back to a live Relay task snapshot for outgoing replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_live: {
        taskId: "task_live",
        subject: "Live outgoing task",
        direction: "outgoing",
        counterpartAgentId: "project-hermes",
        pendingOnAgentId: "project-hermes",
        localStatus: "created_from_ui",
        relayStatus: "submitted",
        localActions: [{
          actionId: "la_live_request",
          type: "zac_local_request",
          status: "sent",
          text: "请让 Hermes 修改标题。",
          createdAt: "2026-07-02T08:00:00.000Z"
        }],
        updatedAt: "2026-07-02T08:00:00.000Z"
      }
    },
    events: {}
  });
  const processorCalls = [];
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:05:00.000Z",
    processInbox: async (params) => {
      processorCalls.push(params);
      return { scanned: 1, processed: 1, externalActions: [] };
    },
    executeInboxAgent: null,
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      getTask: async (taskId) => ({
        task: {
          task_id: taskId,
          subject: "Live outgoing task",
          status: "delivery_pending",
          requester_agent_id: "zac-agent",
          target_agent_id: "project-hermes",
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: "zac-agent",
          messages: [],
          artifacts: [{
            artifact_id: "art_live",
            from_agent_id: "project-hermes",
            to_agent_id: "zac-agent",
            kind: "project_hermes_result",
            created_at: 1782979300,
            parts: [{ kind: "text", text: "Hermes finished the title update." }]
          }]
        }
      }),
      createTask: async () => {
        throw new Error("not used");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/issues/task_live`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.match(detail.events.at(-1).eventId, /^relay-live-task_live-/);
    assert.deepEqual(detail.timeline.map((item) => item.type), ["local_request", "artifact"]);
    assert.equal(detail.timeline[1].speaker, "project-hermes");
    assert.equal(detail.timeline[1].text, "Hermes finished the title update.");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processorCalls.length, 1);
    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    const issue = inbox.issues.task_live;
    assert.equal(issue.pendingOnAgentId, "zac-agent");
    assert.equal(issue.relayStatus, "delivery_pending");
    assert.equal(issue.localStatus, "received");
    assert.equal(issue.lastEventId, detail.events.at(-1).eventId);
    assert.equal(issue.eventIds.length, 1);
    assert.equal(inbox.events[issue.lastEventId].type, "relay.snapshot");
    assert.match(inbox.events[issue.lastEventId].sourcePath, /live-events/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server deletes a local issue without deleting raw events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_delete: {
        taskId: "task_delete",
        subject: "Delete local thread",
        direction: "incoming",
        counterpartAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        localStatus: "received",
        eventIds: ["evt_delete"],
        updatedAt: "2026-07-02T08:00:00.000Z"
      }
    },
    events: {
      evt_delete: {
        eventId: "evt_delete",
        taskId: "task_delete",
        type: "task.pending",
        status: "received"
      }
    }
  });
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:06:00.000Z"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/issues/task_delete`, { method: "DELETE" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "deleted");

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    assert.equal(Object.hasOwn(inbox.issues, "task_delete"), false);
    assert.equal(inbox.events.evt_delete.taskId, "task_delete");
    assert.equal(inbox.deletedIssues.task_delete.deletedAt, "2026-07-02T08:06:00.000Z");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("buildChatTimeline normalizes relay, local, processor, executor, and local action items", () => {
  const issue = {
    taskId: "task_chat",
    localAgentId: "zac-agent",
    localActions: [{
      actionId: "la_request",
      type: "zac_local_request",
      status: "sent",
      text: "请让 Hermes 修改页面标题。",
      createdAt: "2026-07-02T08:00:05.000Z"
    }, {
      actionId: "la_created",
      type: "task_created_from_ui",
      status: "completed",
      text: "Created from local UI.",
      createdAt: "2026-07-02T08:00:40.000Z"
    }],
    humanReplies: [{
      replyId: "hr_chat",
      taskId: "task_chat",
      text: "确认，可以发送。",
      createdAt: "2026-07-02T08:00:20.000Z",
      processedAt: "2026-07-02T08:00:30.000Z"
    }],
    processorStatus: "ready_to_reply",
    processorSummary: "Ready to submit artifact.",
    processorLastRunAt: "2026-07-02T08:00:30.000Z",
    processorActionIntent: "submit_artifact",
    executorStatus: "completed",
    executorActionIntent: "submit_artifact",
    executorLastRunAt: "2026-07-02T08:00:35.000Z"
  };
  const events = [{
    eventId: "evt_chat",
    type: "task.pending",
    receivedAt: "2026-07-02T08:00:10.000Z",
    raw: {
      task: {
        messages: [{
          from_agent_id: "frank-agent",
          to_agent_id: "zac-agent",
          role: "user",
          created_at: 1782979210,
          parts: [{ kind: "text", text: "Can you confirm?" }]
        }, {
          from_agent_id: "zac-agent",
          to_agent_id: "project-hermes",
          role: "user",
          created_at: 1782979210.5,
          parts: [{ kind: "text", text: "Please update the dashboard title." }]
        }],
        artifacts: [{
          artifact_id: "art_chat",
          from_agent_id: "frank-agent",
          to_agent_id: "zac-agent",
          kind: "text",
          created_at: 1782979211,
          parts: [{ kind: "text", text: "Artifact body." }]
        }, {
          artifact_id: "art_empty",
          from_agent_id: "project-hermes",
          to_agent_id: "zac-agent",
          kind: "project_hermes_result",
          created_at: 1782979212,
          parts: [{ kind: "text" }]
        }, {
          artifact_id: "art_hermes_json",
          from_agent_id: "project-hermes",
          to_agent_id: "zac-agent",
          kind: "project_hermes_result",
          created_at: 1782979213,
          parts: [{
            kind: "text",
            text: [
              "```json",
              JSON.stringify({
                kind: "project_hermes_result",
                summary: "Hermes completed the dashboard title update.",
                intent: "submit_artifact",
                next_status: "pending_on_zac",
                parts: [{
                  kind: "text",
                  text: "Project Hermes updated /home/ubuntu/collab_workspace/dashboard.html and verified the public page shows the expected title."
                }]
              }, null, 2),
              "```"
            ].join("\n")
          }]
        }, {
          artifact_id: "art_hermes_malformed_json",
          from_agent_id: "project-hermes",
          to_agent_id: "zac-agent",
          kind: "project_hermes_result",
          created_at: 1782979214,
          parts: [{
            kind: "text",
            text: [
              "```json",
              "{",
              '  "kind": "project_hermes_result",',
              '  "summary": "dashboard.html title updated",',
              '  "parts": [',
              "    {",
              '      "kind": "text",',
              '      "text": "已将 /home/ubuntu/collab_workspace/dashboard.html 的 <title> 修改为"成熟的AI要自己进化"。\\n\\n验证结果：\\n- 页面 title 已生效。"',
              "    }",
              "  ],",
              '  "next_status": "delivery_pending"',
              "}",
              "```"
            ].join("\n")
          }]
        }]
      }
    }
  }];

  const timeline = buildChatTimeline({ issue, events, localAgentId: "zac-agent" });

  assert.deepEqual(timeline.map((item) => item.type), [
    "local_request",
    "relay_message",
    "relay_message",
    "artifact",
    "artifact",
    "artifact",
    "artifact",
    "local_reply",
    "processor",
    "executor",
    "local_action"
  ]);
  assert.equal(timeline[0].speaker, "Zac");
  assert.equal(timeline[0].side, "local");
  assert.equal(timeline[0].text, "请让 Hermes 修改页面标题。");
  assert.equal(timeline[1].speaker, "frank-agent");
  assert.equal(timeline[1].side, "remote");
  assert.equal(timeline[2].speaker, "Agent");
  assert.equal(timeline[2].side, "local");
  assert.equal(timeline[4].speaker, "project-hermes");
  assert.equal(timeline[4].text, "project-hermes returned an artifact, but no text content was included.");
  assert.equal(timeline[5].text, "Project Hermes updated /home/ubuntu/collab_workspace/dashboard.html and verified the public page shows the expected title.");
  assert.doesNotMatch(timeline[5].text, /```|intent|next_status|project_hermes_result/);
  assert.equal(timeline[6].text, "已将 /home/ubuntu/collab_workspace/dashboard.html 的 <title> 修改为\"成熟的AI要自己进化\"。\n\n验证结果：\n- 页面 title 已生效。");
  assert.doesNotMatch(timeline[6].text, /```|next_status|project_hermes_result/);
  assert.equal(timeline[7].speaker, "Zac");
  assert.equal(timeline[7].side, "local");
  assert.equal(timeline[8].speaker, "Agent");
  assert.equal(timeline[8].side, "remote");
  assert.match(timeline[8].text, /Ready to submit artifact/);
  assert.equal(timeline[10].text, "Created from local UI.");
});

test("buildChatTimeline deduplicates repeated Relay snapshots", () => {
  const issue = {
    taskId: "task_duplicate",
    processorStatus: "failed",
    processorSummary: "我收到了新的 AgentRelay 回复，但本地 LLM processor 这次没有成功完成判断。",
    processorNeedsHumanReason: "请稍后重试本地处理，或直接告诉我下一步要回复、继续等待，还是确认关闭这个 task。",
    processorLastRunAt: "2026-07-03T08:00:30.000Z"
  };
  const task = {
    messages: [{
      message_id: "msg_same",
      from_agent_id: "zac-agent",
      to_agent_id: "project-hermes",
      role: "user",
      created_at: 1783063700,
      parts: [{ kind: "text", text: "请修改页面 title。" }]
    }],
    artifacts: [{
      artifact_id: "art_same",
      from_agent_id: "project-hermes",
      to_agent_id: "zac-agent",
      kind: "project_hermes_result",
      created_at: 1783063710,
      parts: [{ kind: "text", text: "修改完成，请确认。" }]
    }]
  };
  const events = [
    { eventId: "evt_one", receivedAt: "2026-07-03T08:00:10.000Z", raw: { task } },
    { eventId: "evt_two", receivedAt: "2026-07-03T08:00:20.000Z", raw: { task } },
    { eventId: "evt_three", receivedAt: "2026-07-03T08:00:30.000Z", raw: { task } }
  ];

  const timeline = buildChatTimeline({ issue, events, localAgentId: "zac-agent" });

  assert.deepEqual(timeline.map((item) => item.type), ["relay_message", "artifact", "processor"]);
  assert.equal(timeline[0].speaker, "Agent");
  assert.equal(timeline[0].text, "请修改页面 title。");
  assert.equal(timeline[1].speaker, "project-hermes");
  assert.equal(timeline[1].text, "修改完成，请确认。");
  assert.equal(timeline[2].speaker, "Agent");
  assert.match(timeline[2].text, /请稍后重试本地处理/);
});

test("buildChatTimeline keeps Zac request before same-second local agent relay message", () => {
  const issue = {
    taskId: "task_same_second_order",
    localActions: [{
      actionId: "la_request",
      type: "zac_local_request",
      status: "sent",
      text: "让 Hermes 修改 dashboard title。",
      createdAt: "2026-07-03T10:00:59.035Z"
    }]
  };
  const events = [{
    eventId: "evt_same_second_order",
    receivedAt: "2026-07-03T10:01:00.430Z",
    raw: {
      task: {
        messages: [{
          message_id: "msg_agent_rewrite",
          from_agent_id: "zac-agent",
          to_agent_id: "project-hermes",
          role: "user",
          created_at: 1783072859,
          parts: [{ kind: "text", text: "请修改 dashboard title，并回报验证结果。" }]
        }]
      }
    }
  }];

  const timeline = buildChatTimeline({ issue, events, localAgentId: "zac-agent" });

  assert.deepEqual(timeline.map((item) => item.type), ["local_request", "relay_message"]);
  assert.equal(timeline[0].speaker, "Zac");
  assert.equal(timeline[0].text, "让 Hermes 修改 dashboard title。");
  assert.equal(timeline[1].speaker, "Agent");
  assert.equal(timeline[1].text, "请修改 dashboard title，并回报验证结果。");
});

test("classifyIssueFilter supports chat task filters", () => {
  assert.equal(issueWorkflowStatus({
    taskId: "needs",
    needsHuman: true,
    relayStatus: "submitted",
    localStatus: "received"
  }), "need approval");
  assert.equal(issueWorkflowStatus({
    taskId: "remote",
    pendingOnAgentId: "project-hermes",
    relayStatus: "submitted",
    localStatus: "received"
  }, { localAgentId: "zac-agent" }), "pending");
  assert.equal(issueWorkflowStatus({
    taskId: "closed",
    relayStatus: "completed",
    localStatus: "closed"
  }), "complete");
  assert.equal(classifyIssueFilter({
    taskId: "needs",
    needsHuman: true,
    relayStatus: "submitted",
    localStatus: "received"
  }, "pending_human"), true);
  assert.equal(classifyIssueFilter({
    taskId: "local",
    pendingOnAgentId: "zac-agent",
    relayStatus: "submitted",
    localStatus: "received"
  }, "pending_human", { localAgentId: "zac-agent" }), false);
  assert.equal(classifyIssueFilter({
    taskId: "remote",
    pendingOnAgentId: "project-hermes",
    relayStatus: "submitted",
    localStatus: "received"
  }, "pending_remote", { localAgentId: "zac-agent" }), true);
  assert.equal(classifyIssueFilter({
    taskId: "remote-local",
    pendingOnAgentId: "zac-agent",
    relayStatus: "submitted",
    localStatus: "received"
  }, "pending_remote", { localAgentId: "zac-agent" }), true);
  assert.equal(classifyIssueFilter({
    taskId: "closed",
    relayStatus: "completed",
    localStatus: "closed"
  }, "complete"), true);
});

test("inbox UI server records Zac replies and schedules processing without waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    receivedAt: "2026-07-02T08:00:00.000Z",
    event: { eventId: "evt_reply", type: "task.pending" },
    task: {
      task_id: "task_reply",
      subject: "Confirm reply",
      pending_on_agent_id: "zac-agent",
      messages: [{ from_agent_id: "frank-agent", to_agent_id: "zac-agent", role: "user", text: "Can you confirm?" }]
    }
  }, null, 2));
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_reply: {
        taskId: "task_reply",
        subject: "Confirm reply",
        direction: "incoming",
        counterpartAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        processorStatus: "needs_human",
        requiresHumanConfirmation: true,
        lastEventId: "evt_reply",
        eventIds: ["evt_reply"],
        updatedAt: "2026-07-02T08:00:00.000Z"
      }
    },
    events: {
      evt_reply: {
        eventId: "evt_reply",
        taskId: "task_reply",
        type: "task.pending",
        sourcePath: eventPath,
        receivedAt: "2026-07-02T08:00:00.000Z"
      }
    }
  });
  const processorCalls = [];
  const executorCalls = [];
  let processorStartedResolve;
  const processorStarted = new Promise((resolve) => {
    processorStartedResolve = resolve;
  });

  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:02:00.000Z",
    replyIdFactory: () => "hr_test_reply",
    processInbox: async (options) => {
      processorCalls.push(options);
      processorStartedResolve();
      return new Promise(() => {});
    },
    executeInboxAgent: async (options) => {
      executorCalls.push(options);
      return { scanned: 1, executed: 1, failed: 0, actions: [{ taskId: "task_reply", actionIntent: "close_task" }] };
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await withTimeout(
      fetch(`http://127.0.0.1:${port}/api/issues/task_reply/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "我确认，可以继续处理。" })
      }),
      1000,
      "reply POST waited for processor"
    );

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.humanReply.replyId, "hr_test_reply");
    assert.equal(body.issue.humanReplies[0].text, "我确认，可以继续处理。");
    assert.equal(body.issue.latestHumanReplyId, "hr_test_reply");
    assert.deepEqual(body.processorResult, { status: "scheduled" });
    assert.deepEqual(body.executorResult, { status: "scheduled_after_processor" });
    await withTimeout(processorStarted, 1000, "processor was not scheduled");
    assert.equal(processorCalls.length, 1);
    assert.equal(processorCalls[0].stateRoot, stateRoot);
    assert.equal(executorCalls.length, 0);

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    assert.equal(inbox.issues.task_reply.humanReplies[0].replyId, "hr_test_reply");
    assert.equal(inbox.issues.task_reply.humanReplyStatus, "pending_processor");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server creates task drafts without sending relay tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const draftCalls = [];
  const relayCalls = [];
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:03:00.000Z",
    draftIdFactory: () => "draft_test",
    taskDraftGenerator: async (params) => {
      draftCalls.push(params);
      return {
        subject: "Update dashboard title with a very long generated task subject",
        requestText: "Please update the dashboard title.",
        doneCriteria: "The title is updated and verified.",
        humanBoundaryReason: "Zac must approve external task creation.",
        to: params.to,
        from: "zac-agent",
        completionOwnerAgentId: "zac-agent"
      };
    },
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async (payload) => {
        relayCalls.push(payload);
        return { task: { task_id: "task_should_not_exist" } };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/task-drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "project-hermes",
        subject: "Dashboard title",
        text: "把 dashboard title 改一下"
      })
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.draft.draftId, "draft_test");
    assert.equal(body.draft.status, "drafted");
    assert.equal(body.draft.to, "project-hermes");
    assert.equal(draftCalls[0].text, "把 dashboard title 改一下");
    assert.equal(relayCalls.length, 0);

    const draftFile = JSON.parse(await readFile(join(stateRoot, "task-drafts.json"), "utf8"));
    assert.equal(draftFile.drafts.draft_test.subject.length, 32);
    assert.equal(draftFile.drafts.draft_test.subject, "Update dashboard title with a ve");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server sends a confirmed task draft once and records an outgoing issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "task-drafts.json"), JSON.stringify({
    version: 1,
    drafts: {
      draft_send: {
        draftId: "draft_send",
        status: "drafted",
        to: "project-hermes",
        from: "zac-agent",
        subject: "Update dashboard title",
        requestText: "Please update the dashboard title.",
        doneCriteria: "The title is updated and verified.",
        humanBoundaryReason: "Zac approved sending this task.",
        completionOwnerAgentId: "zac-agent",
        createdAt: "2026-07-02T08:03:00.000Z",
        updatedAt: "2026-07-02T08:03:00.000Z"
      }
    }
  }, null, 2));
  const createCalls = [];
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:04:00.000Z",
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async (payload) => {
        createCalls.push(payload);
        return {
          task: {
            task_id: "task_created",
            status: "submitted",
            requester_agent_id: "zac-agent",
            target_agent_id: "project-hermes",
            pending_on_agent_id: "project-hermes",
            completion_owner_agent_id: "zac-agent",
            subject: payload.subject
          }
        };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const first = await fetch(`http://127.0.0.1:${port}/api/task-drafts/draft_send/send`, { method: "POST" });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.taskId, "task_created");
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].protocol_version, "agent-collab-v0.3");
    assert.equal(createCalls[0].idempotency_key, "local-ui-create-draft_send");
    assert.equal(createCalls[0].task_type, "agent.task");
    assert.equal(createCalls[0].requester_agent_id, "zac-agent");
    assert.equal(createCalls[0].target_agent_id, "project-hermes");
    assert.equal(createCalls[0].pending_on_agent_id, "project-hermes");
    assert.equal(createCalls[0].completion_owner_agent_id, "zac-agent");
    assert.equal(createCalls[0].next_action, "project-hermes should process the request and return an artifact.");
    assert.equal(createCalls[0].requesterThreadId, "agentrelay-local-ui-draft_send");
    assert.deepEqual(createCalls[0].message, {
      actor_agent_id: "zac-agent",
      intent: "request",
      parts: [{ kind: "text", text: "Please update the dashboard title." }]
    });
    assert.equal(createCalls[0].requestText, "Please update the dashboard title.");

    const second = await fetch(`http://127.0.0.1:${port}/api/task-drafts/draft_send/send`, { method: "POST" });
    assert.equal(second.status, 200);
    assert.equal(createCalls.length, 1);

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    const issue = inbox.issues.task_created;
    assert.equal(issue.direction, "outgoing");
    assert.equal(issue.counterpartAgentId, "project-hermes");
    assert.equal(issue.localActions[0].type, "zac_local_request");
    assert.equal(issue.localActions[0].text, "Please update the dashboard title.");
    assert.equal(issue.localActions[1].type, "task_created_from_ui");
    assert.equal(issue.localActions[1].draftId, "draft_send");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server accepts nested task ids in create task responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "task-drafts.json"), JSON.stringify({
    version: 1,
    drafts: {
      draft_nested_id: {
        draftId: "draft_nested_id",
        status: "drafted",
        to: "project-hermes",
        from: "zac-agent",
        subject: "Update dashboard title",
        requestText: "Please update the dashboard title.",
        doneCriteria: "The title is updated and verified.",
        humanBoundaryReason: "Zac approved sending this task.",
        completionOwnerAgentId: "zac-agent",
        createdAt: "2026-07-02T08:03:00.000Z",
        updatedAt: "2026-07-02T08:03:00.000Z"
      }
    }
  }, null, 2));
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:04:00.000Z",
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async (payload) => ({
        data: {
          task: {
            id: "task_nested_id",
            status: "submitted",
            requester_agent_id: "zac-agent",
            target_agent_id: "project-hermes",
            pending_on_agent_id: "project-hermes",
            completion_owner_agent_id: "zac-agent",
            subject: payload.subject
          }
        }
      })
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/task-drafts/draft_nested_id/send`, { method: "POST" });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.taskId, "task_nested_id");

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    assert.equal(inbox.issues.task_nested_id.localActions[1].type, "task_created_from_ui");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server reports create task response shape when task id is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "task-drafts.json"), JSON.stringify({
    version: 1,
    drafts: {
      draft_missing_id: {
        draftId: "draft_missing_id",
        status: "drafted",
        to: "project-hermes",
        from: "zac-agent",
        subject: "Update dashboard title",
        requestText: "Please update the dashboard title.",
        doneCriteria: "The title is updated and verified.",
        humanBoundaryReason: "Zac approved sending this task.",
        completionOwnerAgentId: "zac-agent",
        createdAt: "2026-07-02T08:03:00.000Z",
        updatedAt: "2026-07-02T08:03:00.000Z"
      }
    }
  }, null, 2));
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:04:00.000Z",
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async () => ({
        ok: true,
        data: { context_id: "ctx_missing_id" }
      })
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/task-drafts/draft_missing_id/send`, { method: "POST" });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.message, /missing task id/);
    assert.match(body.message, /response keys: ok, data/);
    assert.match(body.message, /data keys: context_id/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server turns a local task request into a sent AgentRelay task", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const draftCalls = [];
  const createCalls = [];
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:04:30.000Z",
    draftIdFactory: () => "draft_local_request",
    taskDraftGenerator: async (params) => {
      draftCalls.push(params);
      return {
        subject: "Update dashboard title",
        requestText: "Please update the dashboard title and verify the public page.",
        doneCriteria: "The public page shows the requested dashboard title.",
        humanBoundaryReason: "Ask Zac before sharing sensitive information.",
        to: "project-hermes",
        from: "zac-agent",
        completionOwnerAgentId: "project-hermes"
      };
    },
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async (payload) => {
        createCalls.push(payload);
        return {
          task: {
            task_id: "task_from_local_request",
            status: "submitted",
            requester_agent_id: "zac-agent",
            target_agent_id: "project-hermes",
            pending_on_agent_id: "project-hermes",
            completion_owner_agent_id: "zac-agent",
            subject: payload.subject
          }
        };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/task-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "让 project-hermes 修改 dashboard 标题并回报验证结果" })
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.taskId, "task_from_local_request");
    assert.equal(body.draft.status, "sent");
    assert.equal(body.localRequest.status, "sent_to_relay");
    assert.equal(draftCalls[0].to, "");
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].to, "project-hermes");
    assert.equal(createCalls[0].requester_agent_id, "zac-agent");
    assert.equal(createCalls[0].target_agent_id, "project-hermes");
    assert.equal(createCalls[0].completionOwnerAgentId, "zac-agent");
    assert.deepEqual(createCalls[0].message, {
      actor_agent_id: "zac-agent",
      intent: "request",
      parts: [{ kind: "text", text: "Please update the dashboard title and verify the public page." }]
    });

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    assert.equal(inbox.issues.task_from_local_request.counterpartAgentId, "project-hermes");
    assert.equal(inbox.issues.task_from_local_request.localActions[0].type, "zac_local_request");
    assert.equal(inbox.issues.task_from_local_request.localActions[0].text, "让 project-hermes 修改 dashboard 标题并回报验证结果");
    assert.equal(inbox.issues.task_from_local_request.localActions[1].type, "task_created_from_ui");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI server records a failed local task request as a visible local thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:04:45.000Z",
    draftIdFactory: () => "draft_failed_request",
    taskDraftGenerator: async () => ({
      subject: "Update dashboard title",
      requestText: "Please update the dashboard title.",
      doneCriteria: "The public page shows the requested dashboard title.",
      humanBoundaryReason: "Ask Zac before sharing sensitive information.",
      to: "project-hermes",
      from: "zac-agent",
      completionOwnerAgentId: "zac-agent"
    }),
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async () => {
        throw new Error('AgentRelay POST /tasks failed (400): {"error":"message must be an object"}');
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/task-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "让 Hermes 修改 dashboard 标题" })
    });

    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, "task_create_failed");
    assert.equal(body.taskId, "local_draft_failed_request");
    assert.equal(body.localRequest.status, "failed");

    const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
    const issue = inbox.issues.local_draft_failed_request;
    assert.equal(issue.localStatus, "create_failed");
    assert.equal(issue.pendingOnHumanId, "zac");
    assert.equal(issue.localActions[0].type, "zac_local_request");
    assert.equal(issue.localActions[0].status, "failed");
    assert.match(issue.localActions[0].error, /message must be an object/);
    assert.equal(issue.localActions[1].type, "task_create_failed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inbox UI serves a two-pane chat workspace and dashboard as a separate page", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-inbox-ui-"));
  const stateRoot = join(root, "state");
  const server = createInboxUiServer({
    stateRoot,
    now: () => "2026-07-02T08:05:00.000Z",
    relayClient: {
      listAgents: async () => ({ agents: [] }),
      createTask: async () => {
        throw new Error("not used");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
    const html = await htmlResponse.text();
    assert.match(html, /AgentRelay Workbench/);
    assert.match(html, /id="new-task"/);
    assert.match(html, /id="refresh" class="icon-button icon-only"/);
    assert.match(html, /aria-label="Refresh now"/);
    assert.doesNotMatch(html, />Refresh<\/button>/);
    assert.match(html, /class="theme-toggle"/);
    assert.match(html, /id="show-completed"/);
    assert.match(html, /Show Completed/);
    assert.match(html, /class="list-tools"/);
    assert.match(html, /id="sidebar-resizer"/);
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-label="Resize conversation list"/);
    assert.doesNotMatch(html, />Pending human<\/span>/);
    assert.doesNotMatch(html, />Pending remote<\/span>/);
    assert.doesNotMatch(html, /data-filter="pending_human"/);
    assert.doesNotMatch(html, /data-filter="pending_remote"/);
    assert.doesNotMatch(html, /data-filter="complete"/);
    assert.doesNotMatch(html, /Needs Zac/);
    assert.doesNotMatch(html, /data-filter="incoming"/);
    assert.doesNotMatch(html, /data-filter="outgoing"/);
    assert.match(html, /New AgentRelay Task/);
    assert.match(html, /class="chat-view new-chat"/);
    assert.match(html, /local agent · new conversation/);
    assert.match(html, /Start with a request/);
    assert.match(html, /class="send-button"/);
    assert.doesNotMatch(html, /task-composer-page/);
    assert.doesNotMatch(html, /Send to local agent/);
    assert.doesNotMatch(html, /Target agent/);
    assert.doesNotMatch(html, /Optional subject/);
    assert.doesNotMatch(html, /Generate draft/);
    assert.doesNotMatch(html, /Confirm and send/);
    assert.doesNotMatch(html, /class="rail"/);
    assert.doesNotMatch(html, /data-view="dashboard"/);
    assert.doesNotMatch(html, /class="topbar"/);

    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/dashboard`);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /AgentRelay Dashboard/);
    assert.match(dashboardHtml, /id="dashboard-view"/);
    assert.match(dashboardHtml, /Back to inbox/);

    const jsResponse = await fetch(`http://127.0.0.1:${port}/app.js`);
    const js = await jsResponse.text();
    assert.match(js, /localStorage\.setItem\("agentrelay-theme"/);
    assert.match(js, /const SIDEBAR_WIDTH_KEY = "agentrelay-sidebar-width"/);
    assert.match(js, /function initSidebarResize/);
    assert.match(js, /localStorage\.setItem\(SIDEBAR_WIDTH_KEY/);
    assert.match(js, /pointerdown/);
    assert.match(js, /ArrowLeft/);
    assert.match(js, /ArrowRight/);
    assert.match(js, /setInterval\(refresh, 10000\)/);
    assert.match(js, /\/api\/task-requests/);
    assert.match(js, /newTask/);
    assert.match(js, /draftTextarea/);
    assert.match(js, /deleteIssueFromList/);
    assert.match(js, /method: "DELETE"/);
    assert.match(js, /trashIcon/);
    assert.match(js, /function issueFolders/);
    assert.match(js, /function issueFolder/);
    assert.match(js, /Need approval/);
    assert.match(js, /Pending/);
    assert.doesNotMatch(js, /Pending human/);
    assert.doesNotMatch(js, /Pending remote/);
    assert.match(js, /speaker-zac/);
    assert.match(js, /speaker-agent/);
    assert.match(js, /class="row-actions"/);
    assert.match(js, /aria-current="true"/);
    assert.match(js, /let showCompleted = false/);
    assert.match(js, /showCompleted = !showCompleted/);
    assert.match(js, /issueStatus\(issue\) === "complete"/);
    assert.match(js, /function issueStatus/);
    assert.match(js, /pad\(date\.getMonth\(\) \+ 1\)/);
    assert.doesNotMatch(js, /rowFact\("from"/);
    assert.doesNotMatch(js, /rowFact\("pending"/);
    assert.match(js, /function visibleChatItems/);
    assert.match(js, /item\.type === "relay_message" \|\| item\.type === "artifact" \|\| item\.type === "local_reply" \|\| item\.type === "local_request"/);
    assert.match(js, /function renderPendingMarker/);
    assert.match(js, /formatTime\(at\) \+ " "/);
    assert.match(js, /function captureMessageScrollState/);
    assert.match(js, /function restoreMessageScrollState/);
    assert.match(js, /const scrollState = keepView \? captureMessageScrollState\(\) : null/);
    assert.match(js, /restoreMessageScrollState\(scrollState\)/);
    assert.match(js, /distanceFromBottom <= 48/);
    assert.match(js, /Pending zac-agent/);
    assert.match(js, /class="delivery-indicator failed"/);
    assert.match(js, /class="delivery-indicator delivered"/);
    assert.match(js, /class="message-error"/);
    assert.match(js, /Deliver failed/);
    assert.match(js, /Delivered/);
    assert.match(js, /renderNewTaskMessage/);
    assert.match(js, /renderNewTaskMessage\(\{ text, status: "sending" \}\);[\s\S]*textarea\.value = "";[\s\S]*fetch\("\/api\/task-requests"/);
    assert.match(js, /form\.requestSubmit\(\)/);
    assert.match(js, /class="send-button"/);
    assert.match(js, /if \(!issue\.needsHuman\) return ""/);
    assert.match(js, /if \(issue\.pendingOnAgentId\) return "Pending " \+ issue\.pendingOnAgentId/);
    assert.doesNotMatch(js, /Task is closed\./);
    assert.doesNotMatch(js, /Saved locally first; the LLM processor decides the next action/);
    assert.doesNotMatch(js, /Local agent is preparing and sending the AgentRelay task/);
    assert.doesNotMatch(js, /issueListTags\(issue\)\.join/);

    const cssResponse = await fetch(`http://127.0.0.1:${port}/styles.css`);
    const css = await cssResponse.text();
    assert.match(css, /\.app-shell/);
    assert.match(css, /--sidebar-width: 390px/);
    assert.match(css, /grid-template-columns: var\(--sidebar-width\) 6px minmax\(0, 1fr\)/);
    assert.match(css, /\.sidebar-resizer/);
    assert.match(css, /cursor: col-resize/);
    assert.match(css, /\.theme-toggle/);
    assert.match(css, /\.icon-only svg/);
    assert.match(css, /\.list-tools/);
    assert.match(css, /\.toggle-button/);
    assert.match(css, /\.issue-folder/);
    assert.match(css, /\.row-actions/);
    assert.match(css, /scrollbar-gutter: stable/);
    assert.match(css, /\.issue-row\.selected/);
    assert.match(css, /\.issue-row\.needs-attention\.selected/);
    assert.match(css, /\.delete-issue/);
    assert.match(css, /--bubble-zac/);
    assert.match(css, /--bubble-agent/);
    assert.match(css, /\.message\.speaker-zac \.bubble/);
    assert.match(css, /\.message\.speaker-agent \.bubble/);
    assert.match(css, /\.message\.speaker-zac/);
    assert.match(css, /\.message\.speaker-agent/);
    assert.match(css, /\.message\.speaker-zac \.message-line/);
    assert.match(css, /\.message\.speaker-agent \.message-line/);
    assert.doesNotMatch(css, /\.message:is\(\.speaker-zac, \.speaker-agent\)/);
    assert.match(css, /\.delivery-indicator/);
    assert.match(css, /\.delivery-indicator\.failed/);
    assert.match(css, /\.delivery-indicator\.delivered/);
    assert.match(css, /\.message-error/);
    assert.match(css, /\.pending-marker/);
    assert.match(css, /\.message-line/);
    assert.doesNotMatch(css, /top: 12px/);
    assert.doesNotMatch(css, /position: absolute;\n  right: 10px;\n  top: 12px/);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(css, /\.composer-input/);
    assert.match(css, /\.new-task-empty/);
    assert.match(css, /\.send-button/);
    assert.doesNotMatch(css, /\.row-facts/);
    assert.match(css, /\[data-theme="light"\]/);

    const schema = JSON.parse(await readFile(new URL("../schemas/task-draft.schema.json", import.meta.url), "utf8"));
    assert.equal(schema.properties.subject.maxLength, 32);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("isMainModulePath accepts relative and absolute script paths", () => {
  const moduleUrl = new URL("../scripts/agentrelay-inbox-ui.mjs", import.meta.url).href;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = join(repoRoot, "scripts/agentrelay-inbox-ui.mjs");

  assert.equal(isMainModulePath(moduleUrl, "scripts/agentrelay-inbox-ui.mjs", repoRoot), true);
  assert.equal(
    isMainModulePath(moduleUrl, scriptPath, "/tmp"),
    true
  );
});

async function writeIssues(stateRoot, issues) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify(issues, null, 2));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

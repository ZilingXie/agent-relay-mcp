import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeInboxAgent } from "../scripts/agentrelay-inbox-agent-executor.mjs";

test("executeInboxAgent closes a task from processor close_task intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_close: {
        taskId: "task_close",
        subject: "Close this task",
        completionOwnerAgentId: "zac-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        localStatus: "received",
        processorActionIntent: "close_task",
        processorTerminalReason: "Zac approved closing task_close.",
        latestHumanReplyId: "hr_close",
        processorLastHumanReplyId: "hr_close",
        humanReplies: [{
          replyId: "hr_close",
          taskId: "task_close",
          text: "可以关闭task",
          createdAt: "2026-07-03T02:15:49.206Z",
          processedAt: "2026-07-03T02:15:49.215Z"
        }]
      }
    },
    events: {}
  });
  const calls = [];
  const relayClient = {
    async getTask({ taskId }) {
      calls.push({ method: "getTask", taskId });
      return {
        task: {
          task_id: taskId,
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: "zac-agent",
          status: "delivery_pending"
        }
      };
    },
    async closeTask({ taskId, closedByAgentId, terminalReason }) {
      calls.push({ method: "closeTask", taskId, closedByAgentId, terminalReason });
      return {
        task: {
          task_id: taskId,
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: null,
          pending_on_human_id: null,
          status: "completed",
          terminal_reason: terminalReason
        }
      };
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T02:16:30.000Z"
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.executed, 1);
  assert.deepEqual(calls.map((call) => call.method), ["getTask", "closeTask"]);
  assert.equal(calls[1].closedByAgentId, "zac-agent");
  assert.equal(calls[1].terminalReason, "Zac approved closing task_close.");

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_close;
  assert.equal(issue.relayStatus, "completed");
  assert.equal(issue.localStatus, "closed");
  assert.equal(issue.pendingOnAgentId, "");
  assert.equal(issue.executorStatus, "completed");
  assert.equal(issue.executorActionIntent, "close_task");
  assert.equal(issue.executorLastHumanReplyId, "hr_close");
  assert.equal(issue.executorLastRunAt, "2026-07-03T02:16:30.000Z");
});

test("executeInboxAgent refuses to close when local agent is not completion owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_not_owner: {
        taskId: "task_not_owner",
        completionOwnerAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        processorActionIntent: "close_task",
        processorTerminalReason: "Zac approved closing.",
        latestHumanReplyId: "hr_close",
        humanReplies: [{ replyId: "hr_close", text: "可以关闭task" }]
      }
    },
    events: {}
  });
  const relayClient = {
    async getTask({ taskId }) {
      return {
        task: {
          task_id: taskId,
          completion_owner_agent_id: "frank-agent",
          pending_on_agent_id: "zac-agent",
          status: "delivery_pending"
        }
      };
    },
    async closeTask() {
      throw new Error("closeTask should not be called");
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T02:16:30.000Z"
  });

  assert.equal(result.executed, 0);
  assert.equal(result.failed, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_not_owner.executorStatus, "failed");
  assert.match(inbox.issues.task_not_owner.executorError, /completion owner/);
});

test("executeInboxAgent syncs already completed tasks without closing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_done: {
        taskId: "task_done",
        completionOwnerAgentId: "zac-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        localStatus: "received",
        processorActionIntent: "close_task",
        processorTerminalReason: "Zac approved closing.",
        latestHumanReplyId: "hr_close",
        processorLastHumanReplyId: "hr_close",
        humanReplies: [{ replyId: "hr_close", text: "可以关闭task" }]
      }
    },
    events: {}
  });
  let closeCalled = false;
  const relayClient = {
    async getTask({ taskId }) {
      return {
        task: {
          task_id: taskId,
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: null,
          pending_on_human_id: null,
          status: "completed",
          terminal_reason: "Already closed."
        }
      };
    },
    async closeTask() {
      closeCalled = true;
      throw new Error("closeTask should not be called");
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T02:16:30.000Z"
  });

  assert.equal(result.executed, 1);
  assert.equal(closeCalled, false);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_done.relayStatus, "completed");
  assert.equal(inbox.issues.task_done.localStatus, "closed");
  assert.equal(inbox.issues.task_done.terminalReason, "Already closed.");
});

test("executeInboxAgent submits an artifact from explicit LLM action intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_submit: {
        taskId: "task_submit",
        requesterAgentId: "frank-agent",
        targetAgentId: "zac-agent",
        completionOwnerAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        localStatus: "received",
        processorActionIntent: "submit_artifact",
        processorActionReason: "Zac approved sending this result.",
        processorArtifactKind: "text",
        processorArtifactText: "Frank, Zac confirmed the requested result.",
        requiresHumanConfirmation: false,
        latestHumanReplyId: "hr_submit",
        processorLastHumanReplyId: "hr_submit",
        humanReplies: [{ replyId: "hr_submit", text: "确认，可以回复 Frank。" }]
      }
    },
    events: {}
  });
  const calls = [];
  const relayClient = {
    async getTask({ taskId }) {
      calls.push({ method: "getTask", taskId });
      return {
        task: {
          task_id: taskId,
          requester_agent_id: "frank-agent",
          target_agent_id: "zac-agent",
          completion_owner_agent_id: "frank-agent",
          pending_on_agent_id: "zac-agent",
          status: "delivery_pending"
        }
      };
    },
    async submitArtifact(params) {
      calls.push({ method: "submitArtifact", ...params });
      return {
        task: {
          task_id: params.taskId,
          requester_agent_id: "frank-agent",
          target_agent_id: "zac-agent",
          completion_owner_agent_id: "frank-agent",
          pending_on_agent_id: "frank-agent",
          pending_on_human_id: null,
          status: "delivery_pending"
        },
        artifact: { artifact_id: "art_submit" }
      };
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T03:20:00.000Z"
  });

  assert.equal(result.executed, 1);
  assert.deepEqual(calls.map((call) => call.method), ["getTask", "submitArtifact"]);
  assert.equal(calls[1].from, "zac-agent");
  assert.equal(calls[1].to, "frank-agent");
  assert.equal(calls[1].kind, "text");
  assert.equal(calls[1].text, "Frank, Zac confirmed the requested result.");
  assert.equal(calls[1].pendingOnAgentId, "frank-agent");

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_submit;
  assert.equal(issue.pendingOnAgentId, "frank-agent");
  assert.equal(issue.executorStatus, "completed");
  assert.equal(issue.executorActionIntent, "submit_artifact");
  assert.equal(issue.executorArtifactId, "art_submit");
  assert.equal(issue.executorLastHumanReplyId, "hr_submit");
});

test("executeInboxAgent sends a revision request back to the remote agent without human confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_revision: {
        taskId: "task_revision",
        requesterAgentId: "zac-agent",
        targetAgentId: "project-hermes",
        completionOwnerAgentId: "zac-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        localStatus: "received",
        processorLastEventId: "evt_revision",
        processorActionIntent: "request_revision",
        processorActionReason: "Remote result missed visible heading update.",
        processorArtifactKind: "revision_request",
        processorArtifactText: "Please continue the original task: update the visible H1 heading to match the requested title, then verify again.",
        requiresHumanConfirmation: false
      }
    },
    events: {}
  });
  const calls = [];
  const relayClient = {
    async getTask({ taskId }) {
      calls.push({ method: "getTask", taskId });
      return {
        task: {
          task_id: taskId,
          requester_agent_id: "zac-agent",
          target_agent_id: "project-hermes",
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: "zac-agent",
          status: "delivery_pending"
        }
      };
    },
    async submitArtifact(params) {
      calls.push({ method: "submitArtifact", ...params });
      return {
        task: {
          task_id: params.taskId,
          requester_agent_id: "zac-agent",
          target_agent_id: "project-hermes",
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: "project-hermes",
          pending_on_human_id: null,
          status: "delivery_pending"
        },
        artifact: { artifact_id: "art_revision" }
      };
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T03:30:00.000Z"
  });

  assert.equal(result.executed, 1);
  assert.deepEqual(calls.map((call) => call.method), ["getTask", "submitArtifact"]);
  assert.equal(calls[1].from, "zac-agent");
  assert.equal(calls[1].to, "project-hermes");
  assert.equal(calls[1].kind, "revision_request");
  assert.match(calls[1].text, /visible H1 heading/);
  assert.equal(calls[1].pendingOnAgentId, "project-hermes");
  assert.equal(calls[1].nextAction, "Remote agent should address the local revision request and return an updated artifact.");

  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  const issue = inbox.issues.task_revision;
  assert.equal(issue.pendingOnAgentId, "project-hermes");
  assert.equal(issue.executorStatus, "completed");
  assert.equal(issue.executorActionIntent, "request_revision");
  assert.equal(issue.executorArtifactId, "art_revision");
  assert.equal(issue.executorLastProcessorEventId, "evt_revision");

  const second = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T03:31:00.000Z"
  });
  assert.equal(second.executed, 0);
  assert.equal(calls.length, 2);
});

test("executeInboxAgent refuses submit_artifact without artifact text", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-executor-"));
  const stateRoot = join(root, "state");
  await writeIssues(stateRoot, {
    version: 1,
    issues: {
      task_missing_artifact: {
        taskId: "task_missing_artifact",
        requesterAgentId: "frank-agent",
        targetAgentId: "zac-agent",
        completionOwnerAgentId: "frank-agent",
        pendingOnAgentId: "zac-agent",
        relayStatus: "delivery_pending",
        processorActionIntent: "submit_artifact",
        processorArtifactKind: "text",
        processorArtifactText: "",
        requiresHumanConfirmation: false,
        latestHumanReplyId: "hr_submit",
        humanReplies: [{ replyId: "hr_submit", text: "确认。" }]
      }
    },
    events: {}
  });
  const relayClient = {
    async getTask({ taskId }) {
      return {
        task: {
          task_id: taskId,
          requester_agent_id: "frank-agent",
          target_agent_id: "zac-agent",
          completion_owner_agent_id: "frank-agent",
          pending_on_agent_id: "zac-agent",
          status: "delivery_pending"
        }
      };
    },
    async submitArtifact() {
      throw new Error("submitArtifact should not be called");
    }
  };

  const result = await executeInboxAgent({
    stateRoot,
    localAgentId: "zac-agent",
    relayClient,
    now: () => "2026-07-03T03:21:00.000Z"
  });

  assert.equal(result.executed, 0);
  assert.equal(result.failed, 1);
  const inbox = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8"));
  assert.equal(inbox.issues.task_missing_artifact.executorStatus, "failed");
  assert.match(inbox.issues.task_missing_artifact.executorError, /artifact text/i);
});

async function writeIssues(stateRoot, issues) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify(issues, null, 2));
}

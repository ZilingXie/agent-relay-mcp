import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authorizeServiceAction,
  validateLocalAuthorization,
  validateServicePolicy
} from "../scripts/agentrelay-service-policy.mjs";

const policy = JSON.parse(await readFile(new URL("../policies/project-hermes.service-policy.json", import.meta.url), "utf8"));

test("Hermes service policy allows current-target reply and bounded failure", () => {
  assert.doesNotThrow(() => validateServicePolicy(policy));
  const reply = action("reply", { parts: [{ kind: "text", text: "HERMES_ACK" }] });
  const allowed = authorizeServiceAction({
    policy, action: reply, task: currentTask(), localAgentId: "project-hermes",
    at: "2026-07-19T00:00:00.000Z"
  });
  assert.equal(allowed.ok, true);
  const verified = validateLocalAuthorization({
    action: { ...reply, authorization: allowed.grant },
    localAgentId: "project-hermes",
    now: "2026-07-19T00:00:30.000Z"
  });
  assert.equal(verified.ok, true);

  const failed = authorizeServiceAction({
    policy,
    action: action("fail_task", { reason: "agent_reported_failure" }),
    task: currentTask(),
    localAgentId: "project-hermes"
  });
  assert.equal(failed.ok, true);
});

test("Hermes service policy allows only requester-owned completion of a target response", () => {
  const task = requesterTask();
  const completed = authorizeServiceAction({
    policy, action: action("complete_task", {}), task, localAgentId: "project-hermes"
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.grant.ruleId, "complete-requester-owned-task");

  assert.equal(authorizeServiceAction({
    policy, action: action("complete_task", {}), task: currentTask(), localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_NOT_COMPLETION_OWNER");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("complete_task", {}),
    task: { ...task, from_agent_id: "project-hermes" },
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_NOT_COMPLETION_OWNER");
});

test("Hermes service policy rejects wrong ownership and unknown reasons", () => {
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { text: "wrong owner" }),
    task: { ...currentTask(), to_agent_id: "zac-agent" },
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_NOT_CURRENT_OWNER");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("fail_task", { reason: "max_turns_exhausted" }),
    task: currentTask(),
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_REASON_DENIED");
});

test("Hermes service policy remains independent and denies raw create paths", () => {
  for (const operation of ["create_task", "create_followup", "amend_task", "change_participants"]) {
    const decision = authorizeServiceAction({
      policy,
      action: action(operation, {}),
      task: currentTask(),
      localAgentId: "project-hermes"
    });
    assert.equal(decision.code, "SERVICE_POLICY_OPERATION_DENIED");
  }
});

test("Hermes service policy schema rejects executable side effects and ambiguous rules", () => {
  assert.throws(() => validateServicePolicy({
    ...policy,
    rules: [{ ...policy.rules[0], side_effects: "shell" }, policy.rules[1]]
  }), /must forbid local side effects/);
  assert.throws(() => validateServicePolicy({
    ...policy,
    rules: [...policy.rules, { ...policy.rules[0], id: "second-reply" }]
  }), /Duplicate service policy operation/);
  assert.throws(() => validateServicePolicy({ ...policy, script: "run" }), /Unknown service policy field: script/);
});

test("Hermes service policy rejects closed, undelivered, oversized, and identity-mismatched actions", () => {
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { text: "closed" }),
    task: { ...currentTask(), status: "completed" },
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_TASK_NOT_OPEN");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { text: "pending" }),
    task: { ...currentTask(), messages: [{ message_id: "msg-1", delivery_status: "pending" }] },
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_MESSAGE_NOT_DELIVERED");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { text: "x".repeat(20_001) }),
    task: currentTask(),
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_CONTENT_DENIED");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { text: "identity mismatch" }),
    task: currentTask(),
    localAgentId: "zac-agent"
  }).code, "SERVICE_POLICY_AGENT_MISMATCH");
  assert.equal(authorizeServiceAction({
    policy,
    action: action("reply", { parts: [{ kind: "tool", name: "shell" }] }),
    task: currentTask(),
    localAgentId: "project-hermes"
  }).code, "SERVICE_POLICY_CONTENT_DENIED");
});

test("service policy attachments require bounded files under explicit roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-policy-files-"));
  try {
    const localPath = join(root, "report.txt");
    await writeFile(localPath, "report");
    const attachmentPolicy = {
      ...policy,
      rules: policy.rules.map((rule) => rule.operation === "reply"
        ? {
            ...rule,
            attachments: {
              enabled: true,
              allowed_roots: [root],
              allowed_mime_types: ["text/plain"],
              max_files: 1,
              max_total_bytes: 16
            }
          }
        : rule)
    };
    const allowed = authorizeServiceAction({
      policy: attachmentPolicy,
      action: action("reply", { parts: [
        { kind: "text", text: "attached" },
        { kind: "file", local_path: localPath, name: "report.txt", mime_type: "text/plain", size_bytes: 6, sha256: "a".repeat(64) }
      ] }),
      task: currentTask(),
      localAgentId: "project-hermes"
    });
    assert.equal(allowed.ok, true);
    assert.equal(authorizeServiceAction({
      policy: attachmentPolicy,
      action: action("reply", { parts: [
        { kind: "text", text: "attached" },
        { kind: "file", local_path: "/etc/hosts", name: "hosts", mime_type: "text/plain", size_bytes: 1, sha256: "b".repeat(64) }
      ] }),
      task: currentTask(),
      localAgentId: "project-hermes"
    }).code, "SERVICE_POLICY_CONTENT_DENIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service policy grants are short-lived and bound to exact payload and Task context", () => {
  const prepared = action("reply", { text: "bounded" });
  const allowed = authorizeServiceAction({
    policy,
    action: prepared,
    task: currentTask(),
    localAgentId: "project-hermes",
    at: "2026-07-19T00:00:00.000Z"
  });
  assert.equal(validateLocalAuthorization({
    action: { ...prepared, payloadHash: "changed", authorization: allowed.grant },
    localAgentId: "project-hermes",
    now: "2026-07-19T00:00:30.000Z"
  }).code, "LOCAL_AUTHORIZATION_SCOPE_MISMATCH");
  assert.equal(validateLocalAuthorization({
    action: {
      ...prepared,
      baseContextEnvelope: { taskId: "task-hermes", taskVersion: 3 },
      authorization: allowed.grant
    },
    localAgentId: "project-hermes",
    now: "2026-07-19T00:00:30.000Z"
  }).code, "LOCAL_AUTHORIZATION_SCOPE_MISMATCH");
  assert.equal(validateLocalAuthorization({
    action: { ...prepared, authorization: allowed.grant },
    localAgentId: "project-hermes",
    now: "2026-07-19T00:01:00.000Z"
  }).code, "LOCAL_AUTHORIZATION_EXPIRED");
  assert.equal(validateLocalAuthorization({
    action: { ...prepared, authorization: { ...allowed.grant, expiresAt: "not-a-time" } },
    localAgentId: "project-hermes",
    now: "2026-07-19T00:00:30.000Z"
  }).code, "LOCAL_AUTHORIZATION_TIME_INVALID");
});

function action(actionType, payload) {
  return {
    actionType,
    payload,
    payloadHash: "payload-hash",
    baseContextEnvelope: { taskId: "task-hermes", taskVersion: 2 }
  };
}

function currentTask() {
  return {
    task_id: "task-hermes",
    protocol_version: "agent-collab-v0.5",
    status: "open",
    requester_agent_id: "zac-agent",
    target_agent_id: "project-hermes",
    from_agent_id: "zac-agent",
    to_agent_id: "project-hermes",
    current_message_id: "msg-1",
    task_version: 2,
    messages: [{ message_id: "msg-1", delivery_status: "delivered" }]
  };
}

function requesterTask() {
  return {
    ...currentTask(),
    requester_agent_id: "project-hermes",
    target_agent_id: "zac-agent",
    completion_owner_agent_id: "project-hermes",
    from_agent_id: "zac-agent",
    to_agent_id: "project-hermes"
  };
}

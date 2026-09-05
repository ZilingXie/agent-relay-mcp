import assert from "node:assert/strict";
import test from "node:test";

import {
  COORDINATOR_GRANT_OPERATIONS,
  CoordinatorGrantClient,
  buildCoordinatorTaskPayload,
  normalizeGrantClaims
} from "../scripts/agentrelay-coordinator-grant.mjs";

const NOW = 1_800_000_000;

test("Coordinator Grant client keeps bearer token behind a process-local handle", async () => {
  const calls = [];
  const client = new CoordinatorGrantClient({
    baseUrl: "http://127.0.0.1:8787/agentrelay/api",
    token: "identity-token",
    agentId: "project-hermes",
    username: "hermes",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/coordinator-grants")) {
        const claims = JSON.parse(options.body);
        return jsonResponse(201, {
          grant: issuedGrant(claims),
          coordinator_grant_token: "server-secret-grant-token"
        });
      }
      if (url.endsWith("/tasks")) {
        assert.equal(options.headers["X-AgentRelay-Coordinator-Grant"], "server-secret-grant-token");
        return jsonResponse(201, { task: { task_id: "task_one" } });
      }
      throw new Error(`unexpected request ${url}`);
    }
  });

  const issued = await client.issue(grantInput());
  assert.match(issued.grant_handle, /^cgh_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(issued).includes("server-secret-grant-token"), false);
  assert.equal(JSON.stringify(issued).includes("identity-token"), false);

  const created = await client.createTask(issued.grant_handle, taskInput());
  assert.equal(created.task.task_id, "task_one");
  const wire = JSON.parse(calls[1].options.body);
  assert.equal(wire.requester_agent_id, "project-hermes");
  assert.equal(wire.target_agent_id, "zac-agent");
  assert.equal(wire.max_turns, 1);
  assert.equal(wire.task_expires_at, NOW + 600);
  assert.deepEqual(wire.message.metadata, taskInput().message.metadata);
});

test("Coordinator create rejects mutable target and correlation claims before network", async () => {
  const claims = normalizeGrantClaims(grantInput(), "project-hermes");
  assert.throws(
    () => buildCoordinatorTaskPayload(claims, { ...taskInput(), targetAgentId: "other-agent" }),
    { code: "COORDINATOR_GRANT_CLAIM_MISMATCH" }
  );
  const mismatched = taskInput();
  mismatched.message.metadata.round_id = "round-other";
  assert.throws(
    () => buildCoordinatorTaskPayload(claims, mismatched),
    { code: "COORDINATOR_GRANT_CLAIM_MISMATCH" }
  );
  const crossInvestigation = taskInput();
  crossInvestigation.message.metadata.investigation_id = "inv-other-case";
  assert.throws(
    () => buildCoordinatorTaskPayload(claims, crossInvestigation),
    { code: "COORDINATOR_GRANT_CLAIM_MISMATCH" }
  );
  assert.throws(
    () => normalizeGrantClaims({ ...grantInput(), grantExpiresAt: NOW + 600 }, "project-hermes"),
    { code: "COORDINATOR_GRANT_INVALID_INPUT" }
  );
});

test("invalid rotated token is reissued once with identical claims", async () => {
  let issueCount = 0;
  let getCount = 0;
  const issueBodies = [];
  const client = new CoordinatorGrantClient({
    baseUrl: "http://relay.test/agentrelay/api",
    token: "identity-token",
    agentId: "project-hermes",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/coordinator-grants")) {
        issueCount += 1;
        const claims = JSON.parse(options.body);
        issueBodies.push(claims);
        return jsonResponse(201, {
          grant: { ...issuedGrant(claims), token_version: issueCount },
          coordinator_grant_token: `grant-secret-${issueCount}`
        });
      }
      if (url.endsWith("/tasks/task_one")) {
        getCount += 1;
        if (getCount === 1) {
          assert.equal(options.headers["X-AgentRelay-Coordinator-Grant"], "grant-secret-1");
          return jsonResponse(403, { code: "invalid_coordinator_grant" });
        }
        assert.equal(options.headers["X-AgentRelay-Coordinator-Grant"], "grant-secret-2");
        return jsonResponse(200, { task: { task_id: "task_one" } });
      }
      throw new Error(`unexpected request ${url}`);
    }
  });
  const issued = await client.issue(grantInput());
  const task = await client.getTask(issued.grant_handle, "task_one");
  assert.equal(task.task.task_id, "task_one");
  assert.equal(issueCount, 2);
  assert.equal(getCount, 2);
  assert.deepEqual(issueBodies[0], issueBodies[1]);
  assert.equal(client.publicGrant(issued.grant_handle).grant.token_version, 2);
});

test("resolve, batch, and complete-own always carry the Grant and fresh Task context", async () => {
  const paths = [];
  const client = new CoordinatorGrantClient({
    baseUrl: "http://relay.test/agentrelay/api",
    token: "identity-token",
    agentId: "project-hermes",
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/coordinator-grants")) {
        const claims = JSON.parse(options.body);
        return jsonResponse(201, {
          grant: issuedGrant(claims),
          coordinator_grant_token: "grant-secret"
        });
      }
      assert.equal(options.headers["X-AgentRelay-Coordinator-Grant"], "grant-secret");
      if (path.endsWith("/tasks/resolve")) {
        return jsonResponse(200, { mapping: { task_id: "task_one" } });
      }
      if (path.endsWith("/task-visibility/batch")) {
        assert.deepEqual(JSON.parse(options.body).task_ids, ["task_one"]);
        return jsonResponse(200, { items: [] });
      }
      if (path.endsWith("/tasks/task_one") && options.method === "GET") {
        return jsonResponse(200, { task: {
          task_id: "task_one",
          requester_agent_id: "project-hermes",
          current_message_id: "msg_result",
          turn_sequence: 2,
          task_version: 4
        } });
      }
      if (path.endsWith("/tasks/task_one/complete")) {
        const payload = JSON.parse(options.body);
        assert.deepEqual(payload, {
          actor_agent_id: "project-hermes",
          message_id: "msg_result",
          turn_sequence: 2,
          expected_task_version: 4,
          idempotency_key: "complete-one",
          completed_against_message_id: "msg_result"
        });
        return jsonResponse(200, { task: { task_id: "task_one", status: "completed" } });
      }
      throw new Error(`unexpected request ${url}`);
    }
  });
  const issued = await client.issue(grantInput());
  await client.resolveTask(issued.grant_handle, {
    idempotencyKey: "create-one",
    workItemId: "wi-one"
  });
  await client.getTaskVisibilityBatch(issued.grant_handle, ["task_one", "task_one"]);
  const completed = await client.completeOwnTask(issued.grant_handle, {
    taskId: "task_one",
    idempotencyKey: "complete-one"
  });
  assert.equal(completed.task.status, "completed");
  assert.deepEqual(paths, [
    "/agentrelay/api/coordinator-grants",
    "/agentrelay/api/coordinator-grants/cgrant_one/tasks/resolve",
    "/agentrelay/api/task-visibility/batch",
    "/agentrelay/api/tasks/task_one",
    "/agentrelay/api/tasks/task_one/complete"
  ]);
});

test("unknown handles fail closed without contacting Relay", async () => {
  let calls = 0;
  const client = new CoordinatorGrantClient({
    baseUrl: "http://relay.test/agentrelay/api",
    token: "identity-token",
    agentId: "project-hermes",
    fetchImpl: async () => { calls += 1; }
  });
  await assert.rejects(
    client.getTask("cgh_unknown", "task_one"),
    { code: "COORDINATOR_GRANT_HANDLE_UNKNOWN" }
  );
  assert.equal(calls, 0);
});

test("complete-own rejects a Task owned by another requester before mutation", async () => {
  const client = new CoordinatorGrantClient({
    baseUrl: "http://relay.test/agentrelay/api",
    token: "identity-token",
    agentId: "project-hermes",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/coordinator-grants")) {
        const claims = JSON.parse(options.body);
        return jsonResponse(201, {
          grant: issuedGrant(claims), coordinator_grant_token: "grant-secret"
        });
      }
      if (url.endsWith("/tasks/task_other")) {
        return jsonResponse(200, { task: {
          task_id: "task_other", requester_agent_id: "other-agent",
          current_message_id: "message-one", turn_sequence: 2, task_version: 3
        } });
      }
      throw new Error("completion mutation must not be sent");
    }
  });
  const issued = await client.issue(grantInput());
  await assert.rejects(
    client.completeOwnTask(issued.grant_handle, {
      taskId: "task_other", idempotencyKey: "complete-other"
    }),
    { code: "COORDINATOR_GRANT_TASK_NOT_OWNED" }
  );
});

function grantInput() {
  return {
    issuanceKey: "inv-one-round-one-authority-one",
    investigationId: "inv-one",
    roundId: "round-one",
    approvedPlanDigest: `sha256:${"a".repeat(64)}`,
    authorityRef: "authority-one",
    targetAgentIds: ["zac-agent"],
    taskCount: 1,
    taskExpiresAt: NOW + 600,
    grantExpiresAt: NOW + 900
  };
}

function taskInput() {
  return {
    idempotencyKey: "create-one",
    workItemId: "wi-one",
    targetAgentId: "zac-agent",
    doneCriteria: { required: "structured Result Packet" },
    message: {
      subject: "Investigate one bounded question",
      metadata: {
        investigation_id: "inv-one",
        round_id: "round-one",
        work_item_id: "wi-one",
        approved_plan_digest: `sha256:${"a".repeat(64)}`
      },
      parts: [{ kind: "text", text: "bounded question" }]
    }
  };
}

function issuedGrant(claims) {
  return {
    grant_id: "cgrant_one",
    coordinator_agent_id: claims.coordinator_agent_id,
    investigation_id: claims.investigation_id,
    round_id: claims.round_id,
    approved_plan_digest: claims.approved_plan_digest,
    authority_ref: claims.authority_ref,
    target_agent_ids: claims.target_agent_ids,
    task_count: claims.task_count,
    used_task_count: 0,
    task_expires_at: claims.task_expires_at,
    grant_expires_at: claims.grant_expires_at,
    operations: [...COORDINATOR_GRANT_OPERATIONS],
    claims_digest: `sha256:${"b".repeat(64)}`,
    token_version: 1,
    status: "active",
    created_at: NOW,
    updated_at: NOW
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

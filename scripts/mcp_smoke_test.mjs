#!/usr/bin/env node

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approveLocalAction } from "./agentrelay-task-workspace.mjs";
import { protocolV2Bundle } from "../test/protocol-v2-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const smokeAuth = {
  agentId: "zac-agent",
  username: "zac",
  token: "smoke-token"
};
let fakeRelay;
let client;
let transport;
let localStateRoot;

try {
  fakeRelay = await startFakeRelay();
  const { port } = fakeRelay.address();
  const relayBaseUrl = `http://127.0.0.1:${port}/agentrelay`;
  localStateRoot = await mkdtemp(join(tmpdir(), "agentrelay-mcp-smoke-"));
  ({ client, transport } = await startMcpClient(relayBaseUrl, localStateRoot));

  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "agentrelay_create_task"), "agentrelay_create_task not found");
  assert(
    tools.tools.some((tool) => tool.name === "agentrelay_prepare_completion_decision"),
    "agentrelay_prepare_completion_decision not found"
  );
  assert(tools.tools.some((tool) => tool.name === "agentrelay_amend_task"), "agentrelay_amend_task not found");
  assert(tools.tools.some((tool) => tool.name === "agentrelay_resync_local_task"), "agentrelay_resync_local_task not found");
  assert(tools.tools.some((tool) => tool.name === "agentrelay_prepare_local_action"), "agentrelay_prepare_local_action not found");
  for (const toolName of [
    "agentrelay_create_task_v04",
    "agentrelay_send_message_v04",
    "agentrelay_complete_task_v04",
    "agentrelay_fail_task_v04",
    "agentrelay_create_followup_v04",
    "agentrelay_get_task_lineage_v04",
    "agentrelay_protocol_sync_v04"
  ]) {
    assert(tools.tools.some((tool) => tool.name === toolName), `${toolName} not found`);
  }
  assert(!tools.tools.some((tool) => /delete.*task|task.*delete/i.test(tool.name)), "Task delete tool must not exist");

  await callJson("agentrelay_health", {});
  await callJson("agentrelay_list_agents", {});
  await callJson("agentrelay_get_agent_card", { agentId: "frank-agent" });

  const created = await callJson("agentrelay_create_task", {
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    requesterThreadId: "zac-thread-smoke",
    subject: "MCP smoke meeting availability",
    requestText: "Ask Frank when he is available for an online meeting.",
    intent: "request_availability",
    doneCriteria: "Both Zac and Frank accept the same online meeting time.",
    completionOwnerAgentId: "frank-agent",
    humanBoundaryReason: "Frank must approve sharing availability."
  });
  assert(created.task.completion_owner_agent_id === "zac-agent", "completion owner should normalize to requester");
  assert(created.warnings?.[0]?.code === "COMPLETION_OWNER_NORMALIZED", "completion owner normalization warning missing");
  const taskId = created.task.task_id;

  const frankClaim = await callJson("agentrelay_claim_task", { agentId: "frank-agent" });
  assert(frankClaim.task?.task_id === taskId, "frank-agent did not claim task");

  const frankPending = await callJson("agentrelay_pending_tasks", { agentId: "frank-agent" });
  assert(Array.isArray(frankPending.tasks), "pending tasks did not return a task list");

  const preciseClaim = await callJson("agentrelay_claim_task_by_id", { agentId: "frank-agent", taskId });
  assert(preciseClaim.task?.task_id === taskId, "precise claim did not return the task");

  await callJson("agentrelay_set_target_thread", {
    agentId: "frank-agent",
    taskId,
    threadId: "frank-thread-smoke"
  });

  const artifactArgs = {
    taskId,
    actor_agent_id: "frank-agent",
    target_agent_id: "zac-agent",
    intent: "availability_response",
    kind: "meeting_availability",
    text: "Frank is available Tuesday 10:00-11:00 China time."
  };
  await callJson("agentrelay_resync_local_task", { taskId });
  const preparedArtifact = await callJson("agentrelay_prepare_local_action", {
    taskId,
    actionType: "submit_artifact",
    clientActionId: "smoke_artifact",
    payloadJson: JSON.stringify(withoutTaskId(artifactArgs))
  });
  assert(preparedArtifact.action.status === "awaiting_confirmation", "artifact action was not prepared");
  const artifactApproval = await approveLocalAction({
    stateRoot: localStateRoot, taskId, clientActionId: "smoke_artifact"
  });
  const afterArtifactResult = await callJson("agentrelay_submit_artifact", {
    ...artifactArgs,
    clientActionId: "smoke_artifact",
    confirmationRef: artifactApproval.confirmationRef
  });
  const afterArtifact = afterArtifactResult.relayResponse;
  assert(afterArtifact.task.status === "delivery_pending", "artifact should produce delivery_pending");

  const zacClaim = await callJson("agentrelay_claim_task", { agentId: "zac-agent" });
  assert(zacClaim.task?.task_id === taskId, "zac-agent did not claim returned task");

  await callJson("agentrelay_mark_delivery", {
    taskId,
    deliveredByAgentId: "zac-agent",
    threadId: "zac-thread-smoke",
    deliveryStatus: "delivered",
    pendingOnHumanId: "zac",
    nextAction: "Ask Zac whether Tuesday 10:00 works."
  });

  const decision = await callJson("agentrelay_prepare_completion_decision", {
    taskId,
    evaluatorAgentId: "zac-agent",
    decision: "close_human_confirmed",
    humanOwnerId: "zac",
    humanApprovalRef: "zac-local-smoke-approval",
    humanApprovalSummary: "Zac accepted the proposed meeting time.",
    observedResult: "Frank is available Tuesday 10:00-11:00 China time and Zac accepted it."
  });
  assert(decision.recommended_decision === "close_human_confirmed", "decision helper returned wrong decision");
  assert(decision.next_tool_args.tool === "agentrelay_close_task", "decision helper should recommend close tool");
  assert(
    decision.next_tool_args.args.completionAuthorityType === "human",
    "decision helper should recommend human completion authority"
  );

  const closeArgs = {
    taskId,
    closedByAgentId: "zac-agent",
    terminalReason: "Requester confirmed the proposed meeting time.",
    completionAuthorityType: "human",
    humanOwnerId: "zac",
    humanApprovalRef: "zac-local-smoke-approval",
    humanApprovalSummary: "Zac accepted the proposed meeting time."
  };
  await callJson("agentrelay_resync_local_task", { taskId });
  await callJson("agentrelay_prepare_local_action", {
    taskId,
    actionType: "close_task",
    clientActionId: "smoke_close",
    payloadJson: JSON.stringify(withoutTaskId(closeArgs))
  });
  const closeApproval = await approveLocalAction({
    stateRoot: localStateRoot, taskId, clientActionId: "smoke_close"
  });
  const closedResult = await callJson("agentrelay_close_task", {
    ...closeArgs,
    clientActionId: "smoke_close",
    confirmationRef: closeApproval.confirmationRef
  });
  const closed = closedResult.relayResponse;
  assert(closed.task.status === "completed", "task did not close");

  const events = await callJson("agentrelay_get_events", { taskId });
  assert(events.events.length >= 4, "expected audit events");

  const ack = await callJson("agentrelay_ack_event", {
    agentId: "frank-agent",
    eventId: "aevt_smoke",
    taskId,
    status: "mcp_smoke_dispatched",
    threadId: "frank-thread-smoke"
  });
  assert(ack.event?.acked_at, "event ack did not return acked event");

  const guardedCreateSession = await startMcpClient(relayBaseUrl, localStateRoot, "agent-collab-v0.5", false);
  try {
    await callJson("agentrelay_protocol_status", { refresh: true }, guardedCreateSession.client);
    const deniedCreate = await guardedCreateSession.client.callTool({
      name: "agentrelay_create_task",
      arguments: {
        targetAgentId: "frank-agent",
        doneCriteria: "must not send",
        message: { subject: "Guarded create", parts: [{ kind: "text", text: "must require reviewed draft" }] }
      }
    });
    assert(deniedCreate.isError === true, "direct v0.5 create should be disabled by default");
    assert(deniedCreate.content?.[0]?.text.includes("LOCAL_APPROVAL_REQUIRED"), "direct create rejection should name the local approval boundary");
  } finally {
    await guardedCreateSession.transport.close().catch(() => {});
    await guardedCreateSession.client.close().catch(() => {});
  }

  const v05Session = await startMcpClient(relayBaseUrl, localStateRoot, "agent-collab-v0.5");
  try {
    const initialV05Tools = await v05Session.client.listTools();
    const initialCreateTool = initialV05Tools.tools.find((tool) => tool.name === "agentrelay_create_task");
    assert(initialCreateTool.inputSchema.required.includes("message"), "first v0.5 tools/list did not use the verified dynamic schema");
    assert(!initialCreateTool.inputSchema.properties.requester_agent_id, "first v0.5 tools/list exposed legacy requester identity");
    const runtimeStatus = await callJson("agentrelay_protocol_status", { refresh: true }, v05Session.client);
    assert(runtimeStatus.agent_tools?.status === "active", "dynamic Agent tools were not activated");
    const v05Tools = await v05Session.client.listTools();
    const createTool = v05Tools.tools.find((tool) => tool.name === "agentrelay_create_task");
    assert(createTool.inputSchema.required.includes("message"), "dynamic create schema did not require Message");
    assert(createTool.inputSchema.properties.message.required.includes("subject"), "dynamic create schema did not require subject");
    const replyTool = v05Tools.tools.find((tool) => tool.name === "agentrelay_reply");
    assert(!replyTool.inputSchema.properties.subject, "dynamic reply schema exposed subject");
    assert(!replyTool.inputSchema.properties.clientActionId, "dynamic reply schema exposed local action id");
    const v05Created = await callJson("agentrelay_create_task", {
      targetAgentId: "frank-agent",
      message: { subject: "v0.5 request", parts: [{ kind: "text", text: "v0.5 request" }] },
      doneCriteria: "v0.5 response"
    }, v05Session.client);
    assert(v05Created.task.protocol_version === "agent-collab-v0.5", "generic create did not switch to v0.5");
    await callJson("agentrelay_resync_local_task", { taskId: "task_smoke_v05" }, v05Session.client);
    await callJson("agentrelay_prepare_local_action", {
      taskId: "task_smoke_v05",
      actionType: "reply",
      clientActionId: "smoke_v05_reply",
      payloadJson: JSON.stringify({ parts: [{ kind: "text", text: "v0.5 stable reply" }] })
    }, v05Session.client);
    await approveLocalAction({
      stateRoot: localStateRoot, taskId: "task_smoke_v05", clientActionId: "smoke_v05_reply"
    });
    const v05Reply = await callJson("agentrelay_reply", {
      taskId: "task_smoke_v05",
      parts: [{ kind: "text", text: "v0.5 stable reply" }]
    }, v05Session.client);
    assert(v05Reply.status === "sent", "stable reply did not use the prepared action path");
    assert(v05Reply.relayResponse.task.task_version === 2, "stable reply did not advance task version");
    assert(fakeRelay.protocolState.replyAttempts === 2, "stable reply did not retry exactly once after hot patch");
    const retired = await v05Session.client.callTool({
      name: "agentrelay_claim_task",
      arguments: { agentId: "frank-agent" }
    });
    assert(retired.isError === true, "legacy mutation tool should fail in v0.5 mode");
    assert(retired.content?.[0]?.text.includes("protocol_retired"), "legacy mutation error should identify protocol_retired");
  } finally {
    await v05Session.transport.close().catch(() => {});
    await v05Session.client.close().catch(() => {});
  }

  console.log(JSON.stringify({ ok: true, taskId, status: closed.task.status }, null, 2));
} finally {
  await transport?.close().catch(() => {});
  await client?.close().catch(() => {});
  await new Promise((resolveClose) => fakeRelay?.close(resolveClose));
  if (localStateRoot) await rm(localStateRoot, { recursive: true, force: true });
}

async function startMcpClient(relayBaseUrl, stateRoot, protocolVersion = "", allowDirectCreate = true) {
  const mcpClient = new Client({ name: "agent-relay-mcp-smoke", version: "0.1.0" });
  const mcpTransport = new StdioClientTransport({
    command: "node",
    args: ["mcp/server.mjs"],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: relayBaseUrl,
      AGENTRELAY_AGENT_ID: smokeAuth.agentId,
      AGENTRELAY_ALLOW_DIRECT_CREATE: allowDirectCreate ? "1" : "",
      AGENTRELAY_USERNAME: smokeAuth.username,
      AGENTRELAY_TOKEN: smokeAuth.token,
      AGENTRELAY_STATE_DIR: stateRoot,
      AGENTRELAY_PROTOCOL_CACHE_DIR: join(stateRoot, "protocol-cache"),
      ...(protocolVersion ? { AGENTRELAY_PROTOCOL_VERSION: protocolVersion } : {})
    },
    stderr: "pipe"
  });
  mcpTransport.stderr?.on("data", (chunk) => process.stderr.write(`[mcp:err] ${chunk}`));
  await mcpClient.connect(mcpTransport);
  return { client: mcpClient, transport: mcpTransport };
}

function startFakeRelay() {
  const state = {
    task: null,
    events: [],
    protocolRevision: 1,
    replyAttempts: 0,
    replyIdempotencyKey: ""
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const payload = await readJson(request);
      assertRelayAuth(request);

      const protocolBundle = fakeProtocolBundle(`http://${request.headers.host}/agentrelay`, state.protocolRevision);
      if (request.method === "GET" && path === "/agentrelay/protocols/current") {
        return sendJson(response, protocolBundle.manifest);
      }
      if (request.method === "GET" && path === "/agentrelay/protocols/agent-collab/v0.5/manifest") {
        return sendJson(response, protocolBundle.manifest);
      }
      if (request.method === "GET" && path === "/agentrelay/protocols/agent-collab/v0.5/bundle") {
        return sendJson(response, protocolBundle);
      }
      if (request.method === "POST" && path === "/agentrelay/protocols/negotiate") {
        const current = payload.active?.bundle_digest === protocolBundle.manifest.bundle_digest;
        return sendJson(response, {
          action: current ? "up_to_date" : "hot_patch",
          reason: current ? "current" : "sync required",
          runtime_version: payload.runtime_version,
          missing_capabilities: [],
          authority: protocolBundle.manifest.authority,
          target: {
            protocol: protocolBundle.manifest.protocol,
            version: protocolBundle.manifest.version,
            semver: protocolBundle.manifest.semver,
            bundle_revision: protocolBundle.manifest.bundle_revision,
            schema_digest: protocolBundle.manifest.schema_digest,
            bundle_digest: protocolBundle.manifest.bundle_digest,
            bundle_url: protocolBundle.manifest.urls.bundle,
            adapter_contract_version: protocolBundle.manifest.adapter_contract_version,
            published_at: protocolBundle.manifest.published_at,
            expires_at: protocolBundle.manifest.expires_at,
            required_client_capabilities: protocolBundle.manifest.required_client_capabilities
          },
          retry_policy: { max_automatic_retries: 1, preserve_idempotency_key: true }
        });
      }

      if (request.method === "GET" && path === "/agentrelay/health") {
        return sendJson(response, { ok: true, service: "agentrelay-fake" });
      }
      if (request.method === "GET" && path === "/agentrelay/agents") {
        return sendJson(response, { agents: [{ agent_id: "frank-agent" }, { agent_id: "zac-agent" }] });
      }
      if (request.method === "GET" && path === "/agentrelay/agents/frank-agent/card") {
        return sendJson(response, { name: "Frank Agent", skills: [{ id: "meeting-coordination" }] });
      }
      if (request.method === "POST" && path === "/agentrelay/tasks") {
        if (payload.protocol_version === "agent-collab-v0.5") {
          assert(payload.idempotency_key, "v0.5 MCP create payload missing idempotency_key");
          assert(payload.requester_agent_id === "zac-agent", "v0.5 MCP create payload missing requester_agent_id");
          assert(payload.target_agent_id === "frank-agent", "v0.5 MCP create payload missing target_agent_id");
          assert(payload.done_criteria === "v0.5 response", "v0.5 MCP create payload missing done_criteria");
          assert(payload.message?.subject === "v0.5 request", "v0.5 MCP create payload missing Message subject");
          assert(payload.message?.parts?.[0]?.text === "v0.5 request", "v0.5 MCP create payload missing Message text");
          assert(!payload.task_type && !payload.completion_owner_agent_id, "v0.5 MCP create leaked legacy fields");
          state.task = {
            task_id: "task_smoke_v05",
            root_task_id: "task_smoke_v05",
            protocol_version: "agent-collab-v0.5",
            requester_agent_id: payload.requester_agent_id,
            target_agent_id: payload.target_agent_id,
            status: "open",
            current_message_id: "msg_smoke_v05",
            turn_sequence: 1,
            task_version: 1,
            max_turns: 12,
            from_agent_id: "frank-agent",
            to_agent_id: "zac-agent",
            messages: [{
              message_id: "msg_smoke_v05",
              from_agent_id: "frank-agent",
              to_agent_id: "zac-agent",
              delivery_status: "delivered",
              parts: [{ kind: "text", text: "target response" }]
            }],
            artifacts: []
          };
          return sendJson(response, { task: state.task }, 201);
        }
        assert(payload.protocol_version === "agent-collab-v0.3", "MCP create payload missing protocol version");
        assert(payload.idempotency_key, "MCP create payload missing idempotency_key");
        assert(payload.task_type === "agent.task", "MCP create payload missing task_type");
        assert(payload.next_action, "MCP create payload missing next_action");
        assert(payload.requester_agent_id === "zac-agent", "MCP create payload missing requester_agent_id");
        assert(payload.target_agent_id === "frank-agent", "MCP create payload missing target_agent_id");
        assert(payload.completion_owner_agent_id === "zac-agent", "MCP create payload should use requester as completion owner");
        assert(payload.message?.actor_agent_id === "zac-agent", "MCP create message missing actor_agent_id");
        assert(payload.message?.intent === "request_availability", "MCP create message missing intent");
        state.task = {
          task_id: "task_smoke",
          status: "submitted",
          requester_agent_id: payload.requester_agent_id,
          target_agent_id: payload.target_agent_id,
          requester_thread_id: payload.requesterThreadId,
          completion_owner_agent_id: payload.completion_owner_agent_id || payload.requester_agent_id,
          pending_on_agent_id: payload.pending_on_agent_id || payload.target_agent_id,
          goal_version: 1,
          exchange_epoch: 1,
          messages: [{ message_id: "msg_smoke", ...payload.message }],
          artifacts: []
        };
        state.events.push({ event_type: "task.created" });
        return sendJson(response, { task: state.task }, 201);
      }
      if (request.method === "GET" && path === "/agentrelay/workers/frank-agent/claim") {
        state.task.status = "claimed";
        state.task.claimed_by = "frank-agent";
        return sendJson(response, { task: state.task?.pending_on_agent_id === "frank-agent" ? state.task : null });
      }
      if (request.method === "GET" && path === "/agentrelay/workers/frank-agent/pending") {
        return sendJson(response, { tasks: state.task?.pending_on_agent_id === "frank-agent" ? [{ taskId: state.task.task_id, subject: "MCP smoke meeting availability" }] : [] });
      }
      if (request.method === "POST" && path === "/agentrelay/workers/frank-agent/tasks/task_smoke/claim") {
        state.task.status = "claimed";
        state.task.claimed_by = "frank-agent";
        return sendJson(response, { task: state.task });
      }
      if (request.method === "GET" && path === "/agentrelay/workers/zac-agent/claim") {
        return sendJson(response, { task: state.task?.pending_on_agent_id === "zac-agent" ? state.task : null });
      }
      if (request.method === "POST" && path === "/agentrelay/workers/frank-agent/tasks/task_smoke/thread") {
        state.task.target_thread_id = payload.threadId;
        state.events.push({ event_type: "thread.created" });
        return sendJson(response, { task: state.task });
      }
      if (request.method === "POST" && path === "/agentrelay/tasks/task_smoke/artifacts") {
        assert(payload.protocol_version === "agent-collab-v0.3", "MCP artifact payload missing protocol version");
        assert(payload.idempotency_key, "MCP artifact payload missing idempotency_key");
        assert(payload.actor_agent_id === "frank-agent", "MCP artifact payload missing actor_agent_id");
        assert(payload.intent === "availability_response", "MCP artifact payload missing top-level intent");
        assert(payload.target_agent_id === "zac-agent", "MCP artifact payload missing target_agent_id");
        assert(payload.pending_on_agent_id === "zac-agent", "MCP artifact payload missing pending_on_agent_id");
        assert(payload.next_status === "delivery_pending", "MCP artifact payload missing next_status");
        assert(payload.next_action, "MCP artifact payload missing next_action");
        assert(payload.artifact?.intent === "availability_response", "MCP artifact payload missing intent");
        assert(payload.artifact?.summary, "MCP artifact payload missing summary");
        state.task.status = "delivery_pending";
        state.task.pending_on_agent_id = "zac-agent";
        state.task.artifacts = [
          {
            artifact_id: "art_smoke",
            from_agent_id: "frank-agent",
            kind: payload.artifact?.kind,
            summary: payload.artifact?.summary,
            parts: payload.artifact?.parts || []
          }
        ];
        state.events.push({ event_type: "artifact.submitted" });
        return sendJson(response, { task: state.task }, 201);
      }
      if (request.method === "POST" && path === "/agentrelay/tasks/task_smoke/deliveries") {
        state.task.status = "waiting_human";
        state.task.delivered_to_thread_id = payload.threadId;
        state.events.push({ event_type: "reply.delivered" });
        return sendJson(response, { task: state.task });
      }
      if (request.method === "POST" && path === "/agentrelay/tasks/task_smoke/close") {
        assert(payload.protocol_version === "agent-collab-v0.3", "MCP close payload missing protocol version");
        assert(payload.idempotency_key, "MCP close payload missing idempotency_key");
        assert(payload.closed_by_agent_id === "zac-agent", "MCP close payload missing closed_by_agent_id");
        assert(payload.completion_authority?.type === "human", "MCP close payload missing human completion_authority");
        assert(payload.completion_authority?.owner_id === "zac", "MCP close payload missing human owner_id");
        assert(payload.completion_authority?.via_agent_id === "zac-agent", "MCP close payload missing via_agent_id");
        assert(payload.completion_authority?.approval_ref === "zac-local-smoke-approval", "MCP close payload missing approval_ref");
        state.task.status = "completed";
        state.task.terminal_reason = payload.terminal_reason;
        state.events.push({ event_type: "task.completed" });
        return sendJson(response, { task: state.task });
      }
      if (request.method === "GET" && path === "/agentrelay/tasks/task_smoke") {
        return sendJson(response, { task: state.task });
      }
      if (request.method === "GET" && path === "/agentrelay/tasks/task_smoke_v05") {
        return sendJson(response, { task: state.task });
      }
      if (request.method === "POST" && path === "/agentrelay/tasks/task_smoke_v05/messages") {
        assert(payload.actor_agent_id === "zac-agent", "stable reply must derive actor from local identity");
        assert(payload.message_id === "msg_smoke_v05", "stable reply must derive current Message id");
        assert(payload.turn_sequence === 1, "stable reply must derive current turn");
        assert(payload.expected_task_version === 1, "stable reply must derive current Task version");
        assert(payload.idempotency_key, "stable reply must preserve a prepared idempotency key");
        assert(payload.parts?.[0]?.text === "v0.5 stable reply", "stable reply text missing");
        state.replyAttempts += 1;
        if (state.replyAttempts === 1) {
          state.replyIdempotencyKey = payload.idempotency_key;
          state.protocolRevision = 2;
          return sendJson(response, {
            ok: false,
            error: {
              type: "protocol_negotiation",
              code: "protocol_patch_required",
              detail: { server_protocol: { version: "agent-collab-v0.5" } }
            }
          }, 426);
        }
        assert(payload.idempotency_key === state.replyIdempotencyKey, "semantic retry changed idempotency key");
        state.task = {
          ...state.task,
          current_message_id: "msg_smoke_v05_reply",
          turn_sequence: 2,
          task_version: 2,
          from_agent_id: "zac-agent",
          to_agent_id: "frank-agent",
          messages: [
            ...state.task.messages,
            {
              message_id: "msg_smoke_v05_reply",
              from_agent_id: "zac-agent",
              to_agent_id: "frank-agent",
              delivery_status: "pending",
              parts: payload.parts
            }
          ]
        };
        return sendJson(response, { task: state.task }, 201);
      }
      if (request.method === "GET" && path === "/agentrelay/tasks/task_smoke/events") {
        return sendJson(response, { events: state.events });
      }
      if (request.method === "POST" && path === "/agentrelay/workers/frank-agent/events/aevt_smoke/ack") {
        return sendJson(response, { event: { event_id: "aevt_smoke", task_id: payload.taskId, acked_at: 123 }, threadBinding: { thread_id: payload.threadId } });
      }
      if (request.method === "POST" && path === "/agentrelay/tasks/task_smoke/status") {
        state.task.status = payload.status;
        return sendJson(response, { task: state.task });
      }

      sendJson(response, { error: `not found: ${request.method} ${path}` }, 404);
    } catch (error) {
      sendJson(response, { error: error.message }, 500);
    }
  });

  server.protocolState = state;
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(server)));
}

function fakeProtocolBundle(baseUrl, revision = 1) {
  const bundle = protocolV2Bundle({ origin: baseUrl, authorityId: "mcp-smoke-relay", revision });
  bundle.manifest.urls.bundle = `${baseUrl}/protocols/agent-collab/v0.5/bundle`;
  return bundle;
}

function assertRelayAuth(request) {
  const auth = request.headers.authorization || "";
  const agentId = request.headers["x-agentrelay-agent-id"] || "";
  const username = request.headers["x-agentrelay-username"] || "";
  if (auth !== `Bearer ${smokeAuth.token}` || agentId !== smokeAuth.agentId || username !== smokeAuth.username) {
    throw new Error("missing or invalid AgentRelay auth headers");
  }
}

function withoutTaskId({ taskId: _taskId, ...payload }) {
  return payload;
}

async function readJson(request) {
  if (request.method === "GET") return {};
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function callJson(name, args, targetClient = client) {
  const result = await targetClient.callTool({ name, arguments: args });
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} did not return text content`);
  }
  return JSON.parse(first.text);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

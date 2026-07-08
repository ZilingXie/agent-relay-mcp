#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { maybeHandleProtocolNegotiation, syncCurrentProtocol } from "../scripts/protocol-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
loadDotEnv(process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));

const DEFAULT_BASE_URL = "https://server.stellarix.space/agentrelay/api";
const PROTOCOL_VERSION = "agent-collab-v0.3";
const baseUrl = normalizeBaseUrl(process.env.AGENTRELAY_BASE_URL || DEFAULT_BASE_URL);
const agentId = process.env.AGENTRELAY_AGENT_ID || "";
const username = process.env.AGENTRELAY_USERNAME || "";
const bearerToken = process.env.AGENTRELAY_TOKEN || "";

const server = new McpServer({
  name: "agent-relay-mcp",
  version: "0.1.0"
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

function registerTools(mcpServer) {
  mcpServer.registerTool(
    "agentrelay_health",
    {
      title: "AgentRelay health",
      description: "Check whether the AgentRelay HTTP server is reachable.",
      inputSchema: {}
    },
    async () => jsonResult(await relayGet("/health"))
  );

  mcpServer.registerTool(
    "agentrelay_protocol_sync",
    {
      title: "Sync AgentRelay protocol bundle",
      description: "Fetch and cache the current AgentRelay protocol manifest, schemas, examples, and docs.",
      inputSchema: {}
    },
    async () => {
      return jsonResult(await syncCurrentProtocol({ baseUrl }));
    }
  );

  mcpServer.registerTool(
    "agentrelay_list_agents",
    {
      title: "List AgentRelay agents",
      description: "List known AgentRelay agents.",
      inputSchema: {}
    },
    async () => jsonResult(await relayGet("/agents"))
  );

  mcpServer.registerTool(
    "agentrelay_get_agent_card",
    {
      title: "Get AgentRelay agent card",
      description: "Fetch an A2A-shaped agent card from AgentRelay.",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent id, for example frank-agent")
      }
    },
    async ({ agentId }) => jsonResult(await relayGet(`/agents/${encodeURIComponent(agentId)}/card`))
  );

  mcpServer.registerTool(
    "agentrelay_create_task",
    {
      title: "Create AgentRelay task",
      description: "Create an AgentRelay protocol v0.3 task and record requester-side completion ownership.",
      inputSchema: {
        requester_agent_id: z.string().min(1).optional().describe("Protocol v0.3 requester agent id"),
        target_agent_id: z.string().min(1).optional().describe("Protocol v0.3 target agent id"),
        from: z.string().min(1).optional().describe("Legacy requester agent id alias"),
        to: z.string().min(1).optional().describe("Legacy target agent id alias"),
        requestText: z.string().min(1).describe("Human-readable request to send"),
        requesterThreadId: z.string().min(1).describe("Codex App thread id to deliver replies back to"),
        intent: z.string().optional().describe("Protocol v0.3 message intent, for example request_availability"),
        taskType: z.string().optional().describe("Protocol v0.3 task_type, for example meeting.schedule"),
        subject: z.string().optional(),
        contextId: z.string().optional(),
        doneCriteria: z.string().optional(),
        completionOwnerAgentId: z.string().optional(),
        pendingOnAgentId: z.string().optional(),
        nextAction: z.string().optional(),
        humanBoundaryReason: z.string().optional(),
        ttl: z.number().int().positive().optional(),
        maxTurns: z.number().int().positive().optional()
      }
    },
    async (args) => {
      const requesterAgentId = args.requester_agent_id || args.from;
      const targetAgentId = args.target_agent_id || args.to;
      if (!requesterAgentId || !targetAgentId) {
        throw new Error("agentrelay_create_task requires requester_agent_id/target_agent_id or legacy from/to");
      }
      const requestedCompletionOwnerAgentId = args.completionOwnerAgentId;
      const warnings = [];
      if (requestedCompletionOwnerAgentId && requestedCompletionOwnerAgentId !== requesterAgentId) {
        warnings.push({
          code: "COMPLETION_OWNER_NORMALIZED",
          message: "AgentRelay tasks are requester-completed; completionOwnerAgentId was normalized to requester_agent_id.",
          requestedCompletionOwnerAgentId,
          completionOwnerAgentId: requesterAgentId
        });
      }
      const payload = {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: `mcp-create-${randomUUID()}`,
        task_type: args.taskType || "agent.task",
        contextId: args.contextId,
        requester_agent_id: requesterAgentId,
        target_agent_id: targetAgentId,
        requesterThreadId: args.requesterThreadId,
        subject: args.subject || "AgentRelay task",
        done_criteria: args.doneCriteria || "",
        completion_owner_agent_id: requesterAgentId,
        pending_on_agent_id: args.pendingOnAgentId || targetAgentId,
        next_action: args.nextAction || `${targetAgentId} should process the request and return an artifact.`,
        ttl: args.ttl,
        maxTurns: args.maxTurns,
        message: {
          actor_agent_id: requesterAgentId,
          intent: args.intent || "request",
          parts: [{ kind: "text", text: args.requestText }]
        },
        humanBoundary: args.humanBoundaryReason
          ? { requiresHuman: true, reason: args.humanBoundaryReason }
          : undefined
      };
      const result = await relayPost("/tasks", compact(payload));
      return jsonResult(warnings.length ? { ...result, warnings } : result);
    }
  );

  mcpServer.registerTool(
    "agentrelay_get_task",
    {
      title: "Get AgentRelay task",
      description: "Fetch a task with messages and artifacts.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) => jsonResult(await relayGet(`/tasks/${encodeURIComponent(taskId)}`))
  );

  mcpServer.registerTool(
    "agentrelay_get_events",
    {
      title: "Get AgentRelay task events",
      description: "Fetch audit events for a task.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) => jsonResult(await relayGet(`/tasks/${encodeURIComponent(taskId)}/events`))
  );

  mcpServer.registerTool(
    "agentrelay_claim_task",
    {
      title: "Claim AgentRelay task",
      description: "Claim the next task pending on the provided agent id.",
      inputSchema: {
        agentId: z.string().min(1)
      }
    },
    async ({ agentId }) => jsonResult(await relayGet(`/workers/${encodeURIComponent(agentId)}/claim`))
  );

  mcpServer.registerTool(
    "agentrelay_pending_tasks",
    {
      title: "List pending AgentRelay tasks",
      description: "List lightweight tasks pending on an agent. Use this for listener recovery and debugging.",
      inputSchema: {
        agentId: z.string().min(1)
      }
    },
    async ({ agentId }) => jsonResult(await relayGet(`/workers/${encodeURIComponent(agentId)}/pending`))
  );

  mcpServer.registerTool(
    "agentrelay_claim_task_by_id",
    {
      title: "Claim exact AgentRelay task",
      description: "Claim a specific task id after receiving a WebSocket task.pending event.",
      inputSchema: {
        agentId: z.string().min(1),
        taskId: z.string().min(1)
      }
    },
    async ({ agentId, taskId }) =>
      jsonResult(await relayPost(`/workers/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/claim`, {}))
  );

  mcpServer.registerTool(
    "agentrelay_set_target_thread",
    {
      title: "Record target thread",
      description: "Record or reuse the target Codex App thread for a claimed task.",
      inputSchema: {
        agentId: z.string().min(1),
        taskId: z.string().min(1),
        threadId: z.string().min(1)
      }
    },
    async ({ agentId, taskId, threadId }) =>
      jsonResult(
        await relayPost(
          `/workers/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/thread`,
          { threadId }
        )
      )
  );

  mcpServer.registerTool(
    "agentrelay_submit_artifact",
    {
      title: "Submit AgentRelay artifact",
      description: "Submit a protocol v0.3 artifact. By default, this transfers ownership back to another agent instead of completing the task.",
      inputSchema: {
        taskId: z.string().min(1),
        actor_agent_id: z.string().min(1).optional().describe("Protocol v0.3 agent that produced the artifact"),
        target_agent_id: z.string().min(1).optional().describe("Optional target/receiving agent id"),
        from: z.string().min(1).optional().describe("Legacy actor agent id alias"),
        to: z.string().min(1).optional().describe("Legacy target agent id alias"),
        intent: z.string().optional().describe("Protocol v0.3 artifact intent, for example availability_response"),
        kind: z.string().optional(),
        summary: z.string().optional(),
        text: z.string().min(1),
        pendingOnAgentId: z.string().optional(),
        pendingOnHumanId: z.string().optional(),
        nextStatus: z.string().optional(),
        nextAction: z.string().optional(),
        responseToGoalVersion: z.number().int().positive().optional()
      }
    },
    async (args) => {
      const actorAgentId = args.actor_agent_id || args.from;
      if (!actorAgentId) {
        throw new Error("agentrelay_submit_artifact requires actor_agent_id or legacy from");
      }
      const pendingOnAgentId = args.pendingOnAgentId || args.target_agent_id || args.to;
      if (!pendingOnAgentId) {
        throw new Error("agentrelay_submit_artifact requires pendingOnAgentId or target_agent_id for protocol v0.3");
      }
      const payload = {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: `mcp-artifact-${randomUUID()}`,
        actor_agent_id: actorAgentId,
        intent: args.intent || "work_result",
        target_agent_id: args.target_agent_id || args.to,
        pending_on_agent_id: pendingOnAgentId,
        response_to_goal_version: args.responseToGoalVersion,
        pendingOnHumanId: args.pendingOnHumanId,
        next_status: args.nextStatus || "delivery_pending",
        next_action: args.nextAction || `${pendingOnAgentId} should evaluate the artifact against the task done criteria.`,
        artifact: {
          intent: args.intent || "work_result",
          kind: args.kind || "text",
          summary: args.summary || summarizeText(args.text),
          parts: [{ kind: "text", text: args.text }]
        }
      };
      return jsonResult(await relayPost(`/tasks/${encodeURIComponent(args.taskId)}/artifacts`, compact(payload)));
    }
  );

  mcpServer.registerTool(
    "agentrelay_amend_task",
    {
      title: "Amend AgentRelay task goal",
      description: "Human-authorized requester-side amendment of a task goal. Use this only when the local human changed or clarified done criteria; use request_revision for continuing under the same goal.",
      inputSchema: {
        taskId: z.string().min(1),
        actor_agent_id: z.string().min(1).describe("Requester/completion-owner agent executing the amendment"),
        expected_goal_version: z.number().int().positive().describe("Current task goal_version observed before amendment"),
        new_done_criteria: z.string().min(1).describe("Replacement done_criteria for the latest goal version"),
        previous_goal_disposition: z.enum([
          "accepted_and_extended",
          "clarified",
          "superseded_by_human",
          "rejected_by_human",
          "cancelled_by_human"
        ]).default("clarified"),
        humanOwnerId: z.string().min(1).describe("Human owner who authorized the change"),
        humanApprovalRef: z.string().min(1).describe("Local private reference to the human clarification/approval"),
        humanApprovalSummary: z.string().min(1).describe("Redacted summary of the human's goal change"),
        humanApprovalVisibility: z.enum(["public", "redacted", "private"]).optional(),
        reason: z.string().min(1),
        newMaxTurns: z.number().int().positive().optional(),
        ttl: z.number().int().positive().optional(),
        nextAction: z.string().optional(),
        humanAuthorityJson: z.string().optional().describe("Advanced override: JSON object for human_authority.")
      }
    },
    async (args) => {
      const humanAuthority = buildHumanAuthority(args);
      const payload = {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: `mcp-amend-${randomUUID()}`,
        actor_agent_id: args.actor_agent_id,
        expected_goal_version: args.expected_goal_version,
        new_done_criteria: args.new_done_criteria,
        new_max_turns: args.newMaxTurns,
        ttl: args.ttl,
        previous_goal_disposition: args.previous_goal_disposition,
        human_authority: humanAuthority,
        reason: args.reason,
        next_action: args.nextAction
      };
      return jsonResult(await relayPost(`/tasks/${encodeURIComponent(args.taskId)}/amend`, compact(payload)));
    }
  );

  mcpServer.registerTool(
    "agentrelay_mark_delivery",
    {
      title: "Mark origin-thread delivery",
      description: "Record successful or failed delivery to the requester thread.",
      inputSchema: {
        taskId: z.string().min(1),
        deliveredByAgentId: z.string().min(1),
        threadId: z.string().min(1),
        deliveryStatus: z.enum(["delivered", "failed"]).default("delivered"),
        pendingOnHumanId: z.string().optional(),
        nextAction: z.string().optional(),
        nextStatus: z.string().optional(),
        error: z.string().optional()
      }
    },
    async (args) =>
      jsonResult(
        await relayPost(
          `/tasks/${encodeURIComponent(args.taskId)}/deliveries`,
          compact({
            deliveredByAgentId: args.deliveredByAgentId,
            threadId: args.threadId,
            deliveryStatus: args.deliveryStatus,
            pendingOnHumanId: args.pendingOnHumanId,
            nextAction: args.nextAction,
            nextStatus: args.nextStatus,
            error: args.error
          })
        )
      )
  );

  mcpServer.registerTool(
    "agentrelay_update_status",
    {
      title: "Update AgentRelay task status",
      description: "Update relay transport status and pending ownership fields.",
      inputSchema: {
        taskId: z.string().min(1),
        status: z.string().min(1),
        pendingOnAgentId: z.string().optional(),
        pendingOnHumanId: z.string().optional(),
        nextAction: z.string().optional(),
        terminalReason: z.string().optional()
      }
    },
    async (args) =>
      jsonResult(
        await relayPost(
          `/tasks/${encodeURIComponent(args.taskId)}/status`,
          compact({
            status: args.status,
            pendingOnAgentId: args.pendingOnAgentId,
            pendingOnHumanId: args.pendingOnHumanId,
            nextAction: args.nextAction,
            terminalReason: args.terminalReason
          })
        )
      )
  );

  mcpServer.registerTool(
    "agentrelay_close_task",
    {
      title: "Close AgentRelay task",
      description: "Close a task. Only completion_owner_agent_id should call this. Use human completion authority when a human owner made the final decision.",
      inputSchema: {
        taskId: z.string().min(1),
        closedByAgentId: z.string().min(1),
        terminalReason: z.string().min(1),
        completionAuthorityType: z.enum(["agent", "human"]).optional(),
        humanOwnerId: z.string().min(1).optional(),
        humanApprovalRef: z.string().min(1).optional(),
        humanApprovalSummary: z.string().min(1).optional(),
        humanApprovalVisibility: z.enum(["public", "redacted", "private"]).optional(),
        completionAuthorityJson: z.string().optional().describe("Advanced override: JSON object for completion_authority."),
        finalArtifactJson: z.string().optional().describe("Optional JSON object for final_artifact."),
        closedAgainstGoalVersion: z.number().int().positive().optional()
      }
    },
    async (args) => {
      const completionAuthority = buildCompletionAuthority(args);
      const finalArtifact = parseOptionalJsonObject(args.finalArtifactJson, "finalArtifactJson");
      return jsonResult(
        await relayPost(`/tasks/${encodeURIComponent(args.taskId)}/close`, compact({
          protocol_version: PROTOCOL_VERSION,
          idempotency_key: `mcp-close-${randomUUID()}`,
          closed_by_agent_id: args.closedByAgentId,
          closed_against_goal_version: args.closedAgainstGoalVersion,
          completion_authority: completionAuthority,
          final_artifact: finalArtifact,
          terminal_reason: args.terminalReason
        }))
      );
    }
  );

  mcpServer.registerTool(
    "agentrelay_prepare_completion_decision",
    {
      title: "Prepare AgentRelay completion decision",
      description: "Fetch a task and prepare a requester-side decision packet for close, human confirmation, revision request, or follow-up. This helper does not mutate relay state.",
      inputSchema: {
        taskId: z.string().min(1),
        evaluatorAgentId: z.string().min(1).optional(),
        observedResult: z.string().optional().describe("Optional local observation or verification summary."),
        humanOwnerId: z.string().optional().describe("Human owner id/name to use in human completion authority templates."),
        humanApprovalRef: z.string().optional().describe("Local private approval reference if the human has already confirmed."),
        humanApprovalSummary: z.string().optional().describe("Redacted summary of the human decision."),
        revisionRequest: z.string().optional().describe("If done criteria is not satisfied, describe what the target agent must fix."),
        amendedDoneCriteria: z.string().optional().describe("If the human changed or clarified the goal, provide the new done criteria."),
        amendmentReason: z.string().optional().describe("Why the task goal changed."),
        previousGoalDisposition: z.enum(["accepted_and_extended", "clarified", "superseded_by_human", "rejected_by_human", "cancelled_by_human"]).optional(),
        newMaxTurns: z.number().int().positive().optional(),
        decision: z.enum(["ask_human", "close_human_confirmed", "close_agent_verified", "request_revision", "amend_task", "create_followup"]).optional()
      }
    },
    async (args) => {
      const taskPayload = await relayGet(`/tasks/${encodeURIComponent(args.taskId)}`);
      return jsonResult(prepareCompletionDecision(taskPayload.task || taskPayload, args));
    }
  );

  mcpServer.registerTool(
    "agentrelay_ack_event",
    {
      title: "Ack AgentRelay event",
      description: "Ack a durable agent event after the local listener dispatched it. Optionally records the local thread binding.",
      inputSchema: {
        agentId: z.string().min(1),
        eventId: z.string().min(1),
        taskId: z.string().optional(),
        status: z.string().optional(),
        threadId: z.string().optional(),
        threadRole: z.string().optional(),
        projectPath: z.string().optional()
      }
    },
    async ({ agentId, eventId, taskId, status, threadId, threadRole, projectPath }) =>
      jsonResult(
        await relayPost(
          `/workers/${encodeURIComponent(agentId)}/events/${encodeURIComponent(eventId)}/ack`,
          compact({ taskId, status, threadId, threadRole, projectPath })
        )
      )
  );
}

async function relayGet(path) {
  return relayRequest("GET", path);
}

async function relayPost(path, payload) {
  return relayRequest("POST", path, payload);
}

async function relayRequest(method, path, payload, options = {}) {
  const headers = { "Content-Type": "application/json" };
  headers["X-AgentRelay-Envelope"] = "v0.3";
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  if (agentId) {
    headers["X-AgentRelay-Agent-Id"] = agentId;
  }
  if (username) {
    headers["X-AgentRelay-Username"] = username;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`AgentRelay returned non-JSON response (${response.status}): ${text}`);
  }
  if (!response.ok) {
    if (!options.skipProtocolRepair) {
      const protocolRecovery = await maybeHandleProtocolNegotiation({
        responseData: data,
        method,
        path,
        payload,
        baseUrl,
        retryRequest: (redraftedPayload) =>
          relayRequest(method, path, redraftedPayload, { skipProtocolRepair: true })
      });
      if (protocolRecovery) return protocolRecovery;
    }
    throw new Error(`AgentRelay ${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function jsonResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function buildCompletionAuthority(args) {
  const override = parseOptionalJsonObject(args.completionAuthorityJson, "completionAuthorityJson");
  if (override) return override;

  const type = args.completionAuthorityType || "agent";
  if (type === "human") {
    if (!args.humanOwnerId) {
      throw new Error("agentrelay_close_task with completionAuthorityType=human requires humanOwnerId");
    }
    if (!args.humanApprovalRef) {
      throw new Error("agentrelay_close_task with completionAuthorityType=human requires humanApprovalRef");
    }
    return compact({
      type: "human",
      owner_id: args.humanOwnerId,
      via_agent_id: args.closedByAgentId,
      approval_ref: args.humanApprovalRef,
      summary: args.humanApprovalSummary || "Human owner confirmed the task satisfies done criteria.",
      visibility: args.humanApprovalVisibility || "redacted"
    });
  }

  return {
    type: "agent",
    agent_id: args.closedByAgentId,
    summary: "Completion recorded by the requester-side agent.",
    visibility: "redacted"
  };
}

function buildHumanAuthority(args) {
  const override = parseOptionalJsonObject(args.humanAuthorityJson, "humanAuthorityJson");
  if (override) return override;
  return compact({
    owner_id: args.humanOwnerId,
    via_agent_id: args.actor_agent_id,
    approval_ref: args.humanApprovalRef,
    summary: args.humanApprovalSummary,
    visibility: args.humanApprovalVisibility || "redacted"
  });
}

function parseOptionalJsonObject(value, fieldName) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed;
}

function prepareCompletionDecision(task, args) {
  if (!task || typeof task !== "object") {
    throw new Error("AgentRelay task response did not include a task object");
  }
  const evaluatorAgentId = args.evaluatorAgentId || agentId || task.pending_on_agent_id || "";
  const completionOwnerAgentId = task.completion_owner_agent_id || task.requester_agent_id;
  const targetAgentId = task.target_agent_id;
  const requesterAgentId = task.requester_agent_id;
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const latestArtifact = artifacts.at(-1) || null;
  const doneCriteria = task.done_criteria || "";
  const observedResult = args.observedResult || latestArtifactSummary(latestArtifact);
  const isCompletionOwner = evaluatorAgentId === completionOwnerAgentId;
  const isTerminal = ["completed", "failed", "cancelled", "expired", "rejected"].includes(task.status);
  const decision = args.decision || defaultCompletionDecision({ task, isCompletionOwner, latestArtifact });
  const humanOwnerId = args.humanOwnerId || ownerIdFromAgent(completionOwnerAgentId);
  const approvalRef = args.humanApprovalRef || `local-approval-${task.task_id}`;
  const approvalSummary = args.humanApprovalSummary || "Human owner confirmed the artifact satisfies the task done criteria.";
  const revisionText = args.revisionRequest || revisionPrompt(doneCriteria, observedResult);
  const amendedDoneCriteria = args.amendedDoneCriteria || "";

  return {
    task_id: task.task_id,
    status: task.status,
    protocol_version: PROTOCOL_VERSION,
    evaluator_agent_id: evaluatorAgentId,
    requester_agent_id: requesterAgentId,
    target_agent_id: targetAgentId,
    completion_owner_agent_id: completionOwnerAgentId,
    pending_on_agent_id: task.pending_on_agent_id || null,
    goal_version: task.goal_version || 1,
    exchange_epoch: task.exchange_epoch || 1,
    is_completion_owner: isCompletionOwner,
    is_terminal: isTerminal,
    done_criteria: doneCriteria,
    latest_artifact: latestArtifact
      ? {
          artifact_id: latestArtifact.artifact_id,
          from_agent_id: latestArtifact.from_agent_id,
          kind: latestArtifact.kind,
          summary: latestArtifactSummary(latestArtifact)
        }
      : null,
    observed_result: observedResult || null,
    recommended_decision: decision,
    decision_guidance: decisionGuidance(decision, isCompletionOwner, isTerminal),
    human_question:
      `Does this satisfy the task done criteria?\n\nDone criteria: ${doneCriteria || "(not provided)"}\n\nLatest result: ${observedResult || "(no artifact/result found)"}`,
    next_tool_args: nextToolArgsForDecision({
      task,
      evaluatorAgentId,
      completionOwnerAgentId,
      targetAgentId,
      decision,
      humanOwnerId,
      approvalRef,
      approvalSummary,
      revisionText,
      amendedDoneCriteria,
      amendmentReason: args.amendmentReason,
      previousGoalDisposition: args.previousGoalDisposition,
      newMaxTurns: args.newMaxTurns,
      observedResult
    })
  };
}

function defaultCompletionDecision({ task, isCompletionOwner, latestArtifact }) {
  if (["completed", "failed", "cancelled", "expired", "rejected"].includes(task.status)) {
    return "create_followup";
  }
  if (!isCompletionOwner) {
    return "request_revision";
  }
  if (!latestArtifact) {
    return "ask_human";
  }
  return "ask_human";
}

function decisionGuidance(decision, isCompletionOwner, isTerminal) {
  if (isTerminal) {
    return "The task is terminal. Do not reopen it; create a follow-up/child task for new work.";
  }
  if (!isCompletionOwner) {
    return "This agent is not the completion owner. Do not close; submit an artifact or request revision from the appropriate agent.";
  }
  if (decision === "ask_human") {
    return "Ask the local human owner to confirm whether the latest artifact satisfies done_criteria before closing.";
  }
  if (decision === "close_human_confirmed") {
    return "Close with completion_authority.type=human because the human owner made the final decision.";
  }
  if (decision === "close_agent_verified") {
    return "Close with completion_authority.type=agent only when the agent can fully verify done_criteria without human judgment.";
  }
  if (decision === "request_revision") {
    return "Send a revision_request artifact back to the target agent and keep the task non-terminal.";
  }
  if (decision === "amend_task") {
    return "Amend the task goal only when the requester-side human changed or clarified done_criteria; this starts a new agent-agent exchange.";
  }
  return "Create a follow-up task when the old task is terminal or the request has changed.";
}

function nextToolArgsForDecision({
  task,
  evaluatorAgentId,
  completionOwnerAgentId,
  targetAgentId,
  decision,
  humanOwnerId,
  approvalRef,
  approvalSummary,
  revisionText,
  amendedDoneCriteria,
  amendmentReason,
  previousGoalDisposition,
  newMaxTurns,
  observedResult
}) {
  if (decision === "close_human_confirmed") {
    return {
      tool: "agentrelay_close_task",
      args: {
        taskId: task.task_id,
        closedByAgentId: completionOwnerAgentId,
        closedAgainstGoalVersion: task.goal_version || 1,
        terminalReason: observedResult
          ? `Human owner confirmed done criteria are satisfied: ${summarizeText(observedResult)}`
          : "Human owner confirmed the task satisfies done criteria.",
        completionAuthorityType: "human",
        humanOwnerId,
        humanApprovalRef: approvalRef,
        humanApprovalSummary: approvalSummary,
        humanApprovalVisibility: "redacted"
      }
    };
  }
  if (decision === "close_agent_verified") {
    return {
      tool: "agentrelay_close_task",
      args: {
        taskId: task.task_id,
        closedByAgentId: completionOwnerAgentId,
        closedAgainstGoalVersion: task.goal_version || 1,
        terminalReason: observedResult
          ? `Requester-side agent verified done criteria: ${summarizeText(observedResult)}`
          : "Requester-side agent verified the task satisfies done criteria.",
        completionAuthorityType: "agent"
      }
    };
  }
  if (decision === "request_revision") {
    return {
      tool: "agentrelay_submit_artifact",
      args: {
        taskId: task.task_id,
        actor_agent_id: evaluatorAgentId,
        target_agent_id: targetAgentId,
        intent: "request_revision",
        kind: "revision_request",
        summary: summarizeText(revisionText),
        text: revisionText,
        pendingOnAgentId: targetAgentId,
        nextStatus: "delivery_pending",
        nextAction: `${targetAgentId} should address the revision request and return an updated artifact.`
      }
    };
  }
  if (decision === "amend_task") {
    return {
      tool: "agentrelay_amend_task",
      args: {
        taskId: task.task_id,
        actor_agent_id: completionOwnerAgentId,
        expected_goal_version: task.goal_version || 1,
        new_done_criteria: amendedDoneCriteria || revisionText,
        previous_goal_disposition: previousGoalDisposition || "clarified",
        humanOwnerId,
        humanApprovalRef: approvalRef,
        humanApprovalSummary: approvalSummary,
        humanApprovalVisibility: "redacted",
        reason: amendmentReason || "Requester-side human clarified or changed the task goal.",
        newMaxTurns,
        nextAction: `${targetAgentId} should answer the amended goal version.`
      }
    };
  }
  if (decision === "create_followup") {
    return {
      tool: "agentrelay_create_task",
      args: {
        requester_agent_id: task.requester_agent_id,
        target_agent_id: targetAgentId,
        requesterThreadId: task.requester_thread_id || "replace-with-current-thread-id",
        subject: `Follow-up for ${task.subject || task.task_id}`,
        requestText: "Create a follow-up request instead of reopening the completed task.",
        doneCriteria: "Define the new desired outcome.",
        intent: "follow_up",
        taskType: "agent.followup"
      }
    };
  }
  return {
    tool: "ask_user",
    args: {
      prompt: `Does the latest result satisfy done_criteria for ${task.task_id}? Reply OK to close, or describe what needs revision.`,
      expected_next_step: "If the user confirms, call agentrelay_close_task with completionAuthorityType=human. If not, call agentrelay_submit_artifact with intent=request_revision."
    }
  };
}

function latestArtifactSummary(artifact) {
  if (!artifact) return "";
  if (artifact.summary) return artifact.summary;
  const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
  const textPart = parts.find((part) => typeof part?.text === "string");
  return textPart ? summarizeText(textPart.text) : `${artifact.kind || "artifact"} from ${artifact.from_agent_id || "unknown"}`;
}

function revisionPrompt(doneCriteria, observedResult) {
  return [
    "The latest artifact does not yet satisfy the requester-side done criteria.",
    "",
    `Done criteria: ${doneCriteria || "(not provided)"}`,
    `Observed result: ${observedResult || "(not provided)"}`,
    "",
    "Please submit an updated artifact that directly addresses the missing requirement."
  ].join("\n");
}

function ownerIdFromAgent(value) {
  return (value || "owner").replace(/-agent$/, "") || "owner";
}

function summarizeText(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157)}...`;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

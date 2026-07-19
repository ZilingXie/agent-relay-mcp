import { canonicalDigest } from "../scripts/protocol-runtime.mjs";

export function protocolV2Bundle({
  origin = "https://relay.example/agentrelay",
  authorityId = "relay.example/agentrelay",
  revision = 2,
  publishedAt = "2026-01-01T00:00:00Z",
  expiresAt = "2030-01-01T00:00:00Z"
} = {}) {
  const bundle = {
    manifest: {
      protocol: "agent-collab",
      version: "agent-collab-v0.5",
      semver: "0.5.0",
      bundle_revision: revision,
      adapter_contract_version: 1,
      published_at: publishedAt,
      expires_at: expiresAt,
      authority: { id: authorityId, origin },
      required_client_capabilities: ["dynamic_protocol_bundle_v0.1", "semantic_protocol_adapter_v2"],
      urls: { bundle: `${origin}/api/protocols/agent-collab/v0.5/bundle` }
    },
    schemas: Object.fromEntries([
      "task-create-v05.schema.json",
      "task-message-v05.schema.json",
      "task-terminal-v05.schema.json",
      "task-followup-v05.schema.json"
    ].map((name) => [name, {
      $id: `${origin}/schemas/${name}`,
      type: "object",
      additionalProperties: true
    }])),
    examples: {},
    docs: { "guardrail.txt": `adapter v2 revision ${revision}` },
    adapters: {
      engine: "semantic_protocol_adapter_v2",
      contract_version: 1,
      allowed_binding_sources: ["input", "identity", "task", "runtime"],
      protected_slots: [
        "actor_agent_id",
        "requester_agent_id",
        "target_agent_id",
        "idempotency_key",
        "message_id",
        "turn_sequence",
        "expected_task_version",
        "completed_against_message_id",
        "failure_reason"
      ],
      operations: {
        create_task: operation("/tasks", "task-create-v05.schema.json", [
          binding("protocol_version", "/protocol_version", { value: "agent-collab-v0.5" }),
          binding("idempotency_key", "/idempotency_key", { from: "runtime.idempotency_key" }),
          binding("requester_agent_id", "/requester_agent_id", { from: "identity.agent_id" }),
          binding("target_agent_id", "/target_agent_id", { from: "input.targetAgentId" }),
          binding("done_criteria", "/done_criteria", { from: "input.doneCriteria" }),
          binding("max_turns", "/max_turns", { from: "input.maxTurns", optional: true }),
          binding("task_expires_at", "/task_expires_at", { from: "input.taskExpiresAt", optional: true }),
          binding("message_kind", "/message/parts/0/kind", { value: "text" }),
          binding("request_text", "/message/parts/0/text", { from: "input.requestText" })
        ]),
        reply: operation("/tasks/{task_id}/messages", "task-message-v05.schema.json", [
          binding("actor_agent_id", "/actor_agent_id", { from: "identity.agent_id" }),
          binding("message_id", "/message_id", { from: "task.current_message_id" }),
          binding("turn_sequence", "/turn_sequence", { from: "task.turn_sequence" }),
          binding("expected_task_version", "/expected_task_version", { from: "task.task_version" }),
          binding("idempotency_key", "/idempotency_key", { from: "runtime.idempotency_key" }),
          binding("message_kind", "/parts/0/kind", { value: "text" }),
          binding("reply_text", "/parts/0/text", { from: "input.text" })
        ]),
        complete_task: operation("/tasks/{task_id}/complete", "task-terminal-v05.schema.json", [
          binding("actor_agent_id", "/actor_agent_id", { from: "identity.agent_id" }),
          binding("message_id", "/message_id", { from: "task.current_message_id" }),
          binding("turn_sequence", "/turn_sequence", { from: "task.turn_sequence" }),
          binding("expected_task_version", "/expected_task_version", { from: "task.task_version" }),
          binding("idempotency_key", "/idempotency_key", { from: "runtime.idempotency_key" }),
          binding("completed_against_message_id", "/completed_against_message_id", { from: "task.current_message_id" })
        ]),
        fail_task: operation("/tasks/{task_id}/fail", "task-terminal-v05.schema.json", [
          binding("actor_agent_id", "/actor_agent_id", { from: "identity.agent_id" }),
          binding("message_id", "/message_id", { from: "task.current_message_id" }),
          binding("turn_sequence", "/turn_sequence", { from: "task.turn_sequence" }),
          binding("expected_task_version", "/expected_task_version", { from: "task.task_version" }),
          binding("idempotency_key", "/idempotency_key", { from: "runtime.idempotency_key" }),
          binding("failure_reason", "/reason", { from: "input.reason" })
        ]),
        create_followup: operation("/tasks/{task_id}/followups", "task-followup-v05.schema.json", [
          binding("idempotency_key", "/idempotency_key", { from: "runtime.idempotency_key" }),
          binding("done_criteria", "/done_criteria", { from: "input.doneCriteria" }),
          binding("max_turns", "/max_turns", { from: "input.maxTurns", optional: true }),
          binding("task_expires_at", "/task_expires_at", { from: "input.taskExpiresAt", optional: true }),
          binding("message_kind", "/message/parts/0/kind", { value: "text" }),
          binding("request_text", "/message/parts/0/text", { from: "input.requestText" })
        ])
      }
    }
  };
  bundle.manifest.schema_digest = canonicalDigest(bundle.schemas);
  bundle.manifest.bundle_digest = canonicalDigest(Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== "manifest")
  ));
  return bundle;
}

function operation(path, requestSchema, bindings) {
  return { method: "POST", path, request_schema: requestSchema, bindings };
}

function binding(slot, to, source) {
  return { slot, to, ...source };
}

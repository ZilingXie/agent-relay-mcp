import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNegotiationRequest,
  buildSemanticRequest,
  canonicalDigest,
  validateAdapterDefinition,
  validateNegotiationResponse,
  validateProtocolBundle,
  validateSemanticTransition
} from "../scripts/protocol-runtime.mjs";

test("stable reply builds the v0.5 wire payload from trusted sources", () => {
  const bundle = fakeV05Bundle();
  const request = buildSemanticRequest({
    bundle,
    operation: "reply",
    input: { taskId: "task-1", text: "hello" },
    identity: { agent_id: "frank-agent" },
    task: currentTask(),
    runtime: { idempotency_key: "reply-key" }
  });

  assert.deepEqual(request, {
    method: "POST",
    path: "/tasks/task-1/messages",
    payload: {
      actor_agent_id: "frank-agent",
      message_id: "msg-1",
      turn_sequence: 1,
      expected_task_version: 2,
      idempotency_key: "reply-key",
      parts: [{ kind: "text", text: "hello" }]
    }
  });
});

test("bundle verification rejects content that does not match its digest", () => {
  const bundle = fakeV05Bundle();
  bundle.adapters.operations.reply.bindings.at(-1).value = "remote override";
  assert.throws(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /digest mismatch/);
});

test("adapter rejects remote control of protected identity fields", () => {
  const bundle = fakeV05Bundle();
  const actor = bundle.adapters.operations.reply.bindings.find((item) => item.to === "/actor_agent_id");
  actor.from = "input.actorAgentId";
  assert.throws(() => validateAdapterDefinition(bundle.adapters), /Protected protocol target/);
});

test("negotiation requires bundle and Relay to share an origin", () => {
  const bundle = fakeV05Bundle();
  assert.throws(() => validateNegotiationResponse({
    action: "hot_patch",
    authority: bundle.manifest.authority,
    target: { ...targetFor(bundle), bundle_url: "https://attacker.example/bundle" }
  }, { baseUrl: "https://relay.example/agentrelay/api" }), /configured Relay origin/);
});

test("negotiation request advertises only compiled runtime capabilities", () => {
  const request = buildNegotiationRequest();
  assert.deepEqual(request.supported_protocol_versions, ["agent-collab-v0.5"]);
  assert.deepEqual(request.runtime_capabilities, [
    "dynamic_protocol_bundle_v0.1",
    "semantic_protocol_adapter_v1"
  ]);
});

test("stable reply enforces local action ownership before Relay mutation", () => {
  assert.doesNotThrow(() => validateSemanticTransition("reply", currentTask(), "frank-agent"));
  assert.throws(() => validateSemanticTransition("reply", currentTask(), "zac-agent"), /current action owner/);
});

test("stable semantic guards preserve max-turn and delivered-message invariants", () => {
  const atLimit = { ...currentTask(), requester_agent_id: "frank-agent", turn_sequence: 12, max_turns: 12 };
  assert.throws(() => validateSemanticTransition("reply", atLimit, "frank-agent"), /max_turns_reached/);
  const undelivered = {
    ...currentTask(),
    messages: [{ message_id: "msg-1", delivery_status: "pending" }]
  };
  assert.throws(
    () => validateSemanticTransition("fail_task", undelivered, "frank-agent", { reason: "agent_reported_failure" }),
    /after delivery/
  );
});

function fakeV05Bundle() {
  const bundle = {
    manifest: {
      protocol: "agent-collab",
      version: "agent-collab-v0.5",
      semver: "0.5.0",
      bundle_revision: 1,
      schema_digest: "",
      bundle_digest: "",
      authority: { id: "relay.example/agentrelay", origin: "https://relay.example/agentrelay" },
      required_client_capabilities: ["dynamic_protocol_bundle_v0.1", "semantic_protocol_adapter_v1"]
    },
    schemas: {
      "task-message-v05.schema.json": {
        "$id": "https://relay.example/schemas/task-message-v05.schema.json",
        "type": "object",
        "additionalProperties": false,
        "required": ["actor_agent_id", "message_id", "turn_sequence", "expected_task_version", "idempotency_key", "parts"],
        "properties": {
          "actor_agent_id": { "type": "string" },
          "message_id": { "type": "string" },
          "turn_sequence": { "type": "integer" },
          "expected_task_version": { "type": "integer" },
          "idempotency_key": { "type": "string" },
          "parts": { "type": "array", "items": { "type": "object" } }
        }
      }
    },
    examples: {},
    docs: {},
    adapters: {
      engine: "semantic_protocol_adapter_v1",
      allowed_binding_sources: ["input", "identity", "task", "runtime"],
      protected_targets: ["/actor_agent_id", "/idempotency_key"],
      operations: {
        reply: {
          method: "POST",
          path: "/tasks/{task_id}/messages",
          request_schema: "task-message-v05.schema.json",
          bindings: [
            { to: "/actor_agent_id", from: "identity.agent_id" },
            { to: "/message_id", from: "task.current_message_id" },
            { to: "/turn_sequence", from: "task.turn_sequence" },
            { to: "/expected_task_version", from: "task.task_version" },
            { to: "/idempotency_key", from: "runtime.idempotency_key" },
            { to: "/parts/0/kind", value: "text" },
            { to: "/parts/0/text", from: "input.text" }
          ]
        }
      }
    }
  };
  bundle.manifest.schema_digest = canonicalDigest(bundle.schemas);
  bundle.manifest.bundle_digest = canonicalDigest(Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== "manifest")
  ));
  return bundle;
}

function targetFor(bundle) {
  return {
    version: bundle.manifest.version,
    bundle_revision: bundle.manifest.bundle_revision,
    bundle_digest: bundle.manifest.bundle_digest,
    required_client_capabilities: bundle.manifest.required_client_capabilities
  };
}

function currentTask() {
  return {
    task_id: "task-1",
    status: "open",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    from_agent_id: "zac-agent",
    to_agent_id: "frank-agent",
    current_message_id: "msg-1",
    turn_sequence: 1,
    task_version: 2,
    max_turns: 12,
    messages: [{ message_id: "msg-1", delivery_status: "delivered" }]
  };
}

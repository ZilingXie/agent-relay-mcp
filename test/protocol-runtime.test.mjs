import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNegotiationRequest,
  buildSemanticRequest,
  agentToolDefinitions,
  validateAdapterDefinition,
  validateNegotiationResponse,
  validateProtocolBundle,
  validateSemanticTransition
} from "../scripts/protocol-runtime.mjs";
import { protocolV1Bundle, protocolV2Bundle, resignProtocolV2Bundle } from "./protocol-v2-fixture.mjs";

test("stable reply builds the v0.5 wire payload from trusted sources", () => {
  const bundle = protocolV2Bundle();
  const request = buildSemanticRequest({
    bundle,
    operation: "reply",
    input: { taskId: "task-1", parts: [{ kind: "text", text: "hello" }] },
    identity: { agent_id: "frank-agent" },
    task: currentTask(),
    runtime: { idempotency_key: "reply-key" }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
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

test("new runtime keeps the staged adapter contract v1 compatible", () => {
  const bundle = protocolV1Bundle();
  assert.doesNotThrow(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }));
  const request = buildSemanticRequest({
    bundle,
    operation: "reply",
    input: { taskId: "task-1", text: "legacy reply" },
    identity: { agent_id: "frank-agent" },
    task: currentTask(),
    runtime: { idempotency_key: "legacy-key" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload.parts)), [{ kind: "text", text: "legacy reply" }]);
});

test("bundle verification rejects content that does not match its digest", () => {
  const bundle = protocolV2Bundle();
  bundle.adapters.operations.reply.bindings.at(-1).value = "remote override";
  assert.throws(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /digest mismatch/);
});

test("dynamic Agent tool bundle requires a valid Ed25519 manifest signature", () => {
  const unsigned = protocolV2Bundle();
  delete unsigned.manifest.signature;
  assert.throws(() => validateProtocolBundle(unsigned, {
    expectedTarget: targetFor(unsigned),
    authority: unsigned.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /requires a signed manifest/);

  const alteredSignature = protocolV2Bundle();
  alteredSignature.manifest.signature.value = `${alteredSignature.manifest.signature.value.slice(0, -4)}AAAA`;
  assert.throws(() => validateProtocolBundle(alteredSignature, {
    expectedTarget: targetFor(alteredSignature),
    authority: alteredSignature.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /signature verification failed/);

  const alteredManifest = protocolV2Bundle();
  alteredManifest.manifest.required_client_capabilities = [
    ...alteredManifest.manifest.required_client_capabilities,
    "remote_code_execution_v1"
  ];
  assert.throws(() => validateProtocolBundle(alteredManifest, {
    expectedTarget: targetFor(alteredManifest),
    authority: alteredManifest.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /signature verification failed/);
});

test("adapter rejects remote control of protected Task context slots", () => {
  const bundle = protocolV2Bundle();
  const actor = bundle.adapters.operations.reply.bindings.find((item) => item.to === "/actor_agent_id");
  actor.from = "input.actorAgentId";
  assert.throws(() => validateAdapterDefinition(bundle.adapters), /must use identity.agent_id/);
  const messageBundle = protocolV2Bundle();
  const message = messageBundle.adapters.operations.reply.bindings.find((item) => item.slot === "message_id");
  message.from = "input.parts";
  assert.throws(() => validateAdapterDefinition(messageBundle.adapters), /must use task.current_message_id/);
});

test("adapter rejects prototype pollution, duplicate targets, and unknown slots", () => {
  const polluted = protocolV2Bundle();
  polluted.adapters.operations.reply.bindings.find((item) => item.slot === "message_parts").to = "/__proto__/polluted";
  assert.throws(() => validateAdapterDefinition(polluted.adapters), /Unsafe JSON Pointer/);
  assert.equal(Object.prototype.polluted, undefined);

  const duplicate = protocolV2Bundle();
  duplicate.adapters.operations.reply.bindings.find((item) => item.slot === "message_parts").to = "/message_id";
  assert.throws(() => validateAdapterDefinition(duplicate.adapters), /Duplicate protocol adapter target/);

  const unknown = protocolV2Bundle();
  unknown.adapters.operations.reply.bindings.push({ slot: "remote_code", to: "/code", from: "input.parts" });
  assert.throws(() => validateAdapterDefinition(unknown.adapters), /slot is not allowed/);

  const script = protocolV2Bundle();
  script.adapters.script = "run remote code";
  assert.throws(() => validateAdapterDefinition(script.adapters), /Unknown protocol adapter field: script/);
});

test("negotiation requires bundle and Relay to share an origin", () => {
  const bundle = protocolV2Bundle();
  assert.throws(() => validateNegotiationResponse({
    action: "hot_patch",
    authority: bundle.manifest.authority,
    target: { ...targetFor(bundle), bundle_url: "https://attacker.example/bundle" }
  }, { baseUrl: "https://relay.example/agentrelay/api" }), /authority path/);
});

test("negotiation rejects a same-origin bundle outside the configured Relay path", () => {
  const bundle = protocolV2Bundle();
  assert.throws(() => validateNegotiationResponse({
    action: "hot_patch",
    authority: bundle.manifest.authority,
    target: { ...targetFor(bundle), bundle_url: "https://relay.example/other/bundle" }
  }, { baseUrl: "https://relay.example/agentrelay/api" }), /authority path/);
});

test("adapter v2 rejects future, expired, and target-mismatched validity windows", () => {
  const future = protocolV2Bundle({ publishedAt: "2999-01-01T00:00:00Z" });
  assert.throws(() => validateNegotiationResponse({
    action: "hot_patch",
    authority: future.manifest.authority,
    target: targetFor(future)
  }, { baseUrl: "https://relay.example/agentrelay/api" }), /cannot be in the future/);

  const expired = protocolV2Bundle({
    publishedAt: "2020-01-01T00:00:00Z",
    expiresAt: "2021-01-01T00:00:00Z"
  });
  assert.throws(() => validateProtocolBundle(expired, {
    expectedTarget: targetFor(expired),
    authority: expired.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /has expired/);

  const mismatch = protocolV2Bundle();
  assert.throws(() => validateProtocolBundle(mismatch, {
    expectedTarget: { ...targetFor(mismatch), expires_at: "2031-01-01T00:00:00Z" },
    authority: mismatch.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /validity window does not match/);

  const unbound = protocolV2Bundle();
  assert.throws(() => validateProtocolBundle(unbound, {
    authority: unbound.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /requires a verified negotiation target/);
});

test("negotiation request advertises only compiled runtime capabilities", () => {
  const request = buildNegotiationRequest();
  assert.deepEqual(request.supported_protocol_versions, ["agent-collab-v0.5"]);
  assert.deepEqual(request.runtime_capabilities, [
    "dynamic_protocol_bundle_v0.1",
    "semantic_protocol_adapter_v2",
    "local_authorization_v1",
    "dynamic_agent_tool_schema_v1"
  ]);
});

test("signed Agent tool definitions expose only the compiled semantic fields", () => {
  const bundle = protocolV2Bundle();
  assert.deepEqual(agentToolDefinitions(bundle).map((item) => item.name), [
    "agentrelay_create_task",
    "agentrelay_reply",
    "agentrelay_create_followup"
  ]);

  const identity = protocolV2Bundle();
  identity.agent_tools.tools.agentrelay_reply.input_schema.properties.actorAgentId = { type: "string" };
  assert.throws(() => agentToolDefinitions(identity), /untrusted field/);

  const route = protocolV2Bundle();
  route.agent_tools.tools.agentrelay_reply.operation = "complete_task";
  assert.throws(() => agentToolDefinitions(route), /operation is not allowed/);

  const oversized = protocolV2Bundle();
  oversized.agent_tools.tools.agentrelay_create_task.input_schema.properties.message.properties.subject.maxLength = 10000;
  assert.throws(() => agentToolDefinitions(oversized), /Invalid maxLength/);

  const nestedIdentity = protocolV2Bundle();
  nestedIdentity.agent_tools.tools.agentrelay_create_task.input_schema.properties.message.properties.actorAgentId = { type: "string" };
  assert.throws(() => agentToolDefinitions(nestedIdentity), /Message fields do not match/);
});

test("signed bundle can hot-add bounded optional first-Message metadata", () => {
  const bundle = protocolV2Bundle();
  for (const toolName of ["agentrelay_create_task", "agentrelay_create_followup"]) {
    bundle.agent_tools.tools[toolName].input_schema.properties.message.properties.metadata = {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        category: { type: "string", enum: ["conformance", "project-state"] },
        requiresReview: { type: "boolean" },
        display: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: { priority: { type: "integer", minimum: 0, maximum: 5 } }
        }
      }
    };
  }
  resignProtocolV2Bundle(bundle);
  assert.doesNotThrow(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }));
  assert.ok(agentToolDefinitions(bundle).find((item) => item.name === "agentrelay_create_task")
    .input_schema.properties.message.properties.metadata);

  const request = buildSemanticRequest({
    bundle,
    operation: "create_task",
    input: {
      targetAgentId: "zac-agent",
      doneCriteria: "metadata persisted",
      message: {
        subject: "Metadata hot update",
        parts: [{ kind: "text", text: "verify" }],
        metadata: { category: "conformance", requiresReview: false, display: { priority: 2 } }
      }
    },
    identity: { agent_id: "frank-agent" },
    runtime: { idempotency_key: "metadata-key" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload.message.metadata)), {
    category: "conformance",
    requiresReview: false,
    display: { priority: 2 }
  });
});

test("dynamic Message metadata cannot expose reserved control fields", () => {
  const bundle = protocolV2Bundle();
  bundle.agent_tools.tools.agentrelay_create_task.input_schema.properties.message.properties.metadata = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: { requesterAgentId: { type: "string", maxLength: 64 } }
  };
  resignProtocolV2Bundle(bundle);
  assert.throws(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /metadata key is not allowed/);
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

function targetFor(bundle) {
  return {
    version: bundle.manifest.version,
    bundle_revision: bundle.manifest.bundle_revision,
    bundle_digest: bundle.manifest.bundle_digest,
    schema_digest: bundle.manifest.schema_digest,
    adapter_contract_version: bundle.manifest.adapter_contract_version,
    published_at: bundle.manifest.published_at,
    expires_at: bundle.manifest.expires_at,
    required_client_capabilities: bundle.manifest.required_client_capabilities,
    bundle_url: bundle.manifest.urls.bundle,
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

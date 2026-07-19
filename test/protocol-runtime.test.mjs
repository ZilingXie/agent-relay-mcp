import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNegotiationRequest,
  buildSemanticRequest,
  validateAdapterDefinition,
  validateNegotiationResponse,
  validateProtocolBundle,
  validateSemanticTransition
} from "../scripts/protocol-runtime.mjs";
import { protocolV2Bundle } from "./protocol-v2-fixture.mjs";

test("stable reply builds the v0.5 wire payload from trusted sources", () => {
  const bundle = protocolV2Bundle();
  const request = buildSemanticRequest({
    bundle,
    operation: "reply",
    input: { taskId: "task-1", text: "hello" },
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

test("bundle verification rejects content that does not match its digest", () => {
  const bundle = protocolV2Bundle();
  bundle.adapters.operations.reply.bindings.at(-1).value = "remote override";
  assert.throws(() => validateProtocolBundle(bundle, {
    expectedTarget: targetFor(bundle),
    authority: bundle.manifest.authority,
    baseUrl: "https://relay.example/agentrelay/api"
  }), /digest mismatch/);
});

test("adapter rejects remote control of protected Task context slots", () => {
  const bundle = protocolV2Bundle();
  const actor = bundle.adapters.operations.reply.bindings.find((item) => item.to === "/actor_agent_id");
  actor.from = "input.actorAgentId";
  assert.throws(() => validateAdapterDefinition(bundle.adapters), /must use identity.agent_id/);
  const messageBundle = protocolV2Bundle();
  const message = messageBundle.adapters.operations.reply.bindings.find((item) => item.slot === "message_id");
  message.from = "input.text";
  assert.throws(() => validateAdapterDefinition(messageBundle.adapters), /must use task.current_message_id/);
});

test("adapter rejects prototype pollution, duplicate targets, and unknown slots", () => {
  const polluted = protocolV2Bundle();
  polluted.adapters.operations.reply.bindings.find((item) => item.slot === "reply_text").to = "/__proto__/polluted";
  assert.throws(() => validateAdapterDefinition(polluted.adapters), /Unsafe JSON Pointer/);
  assert.equal(Object.prototype.polluted, undefined);

  const duplicate = protocolV2Bundle();
  duplicate.adapters.operations.reply.bindings.find((item) => item.slot === "reply_text").to = "/message_id";
  assert.throws(() => validateAdapterDefinition(duplicate.adapters), /Duplicate protocol adapter target/);

  const unknown = protocolV2Bundle();
  unknown.adapters.operations.reply.bindings.push({ slot: "remote_code", to: "/code", from: "input.text" });
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
    "local_authorization_v1"
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompletePayloadV04,
  buildCreatePayloadV04,
  buildFailPayloadV04,
  buildMessagePayloadV04,
  messageAckMetadataV04,
  mutationContextV04,
  validatePreparedActionV04
} from "../scripts/agentrelay-v04.mjs";

test("v0.4 builders preserve the exact optimistic-concurrency context", () => {
  const task = {
    current_message_id: "msg_7",
    turn_sequence: 3,
    status_version: 9
  };
  assert.deepEqual(mutationContextV04(task), {
    current_message_id: "msg_7",
    turn_sequence: 3,
    expected_status_version: 9
  });
  const args = {
    actorAgentId: "frank-agent",
    text: "response",
    currentMessageId: "msg_7",
    turnSequence: 3,
    expectedStatusVersion: 9
  };
  assert.deepEqual(buildMessagePayloadV04(args, "message-key"), {
    current_message_id: "msg_7",
    turn_sequence: 3,
    expected_status_version: 9,
    idempotency_key: "message-key",
    actor_agent_id: "frank-agent",
    parts: [{ kind: "text", text: "response" }]
  });
  assert.equal(buildCompletePayloadV04({
    ...args,
    actorAgentId: "zac-agent",
    completedAgainstMessageId: "msg_7"
  }, "complete-key").completed_against_message_id, "msg_7");
  assert.equal(buildFailPayloadV04({
    ...args,
    actorAgentId: "zac-agent",
    reason: "max_turns_exhausted"
  }, "fail-key").reason, "max_turns_exhausted");
});

test("v0.4 create is explicit and rejects incomplete requests", () => {
  const payload = buildCreatePayloadV04({
    requesterAgentId: "zac-agent",
    targetAgentId: "frank-agent",
    requestText: "Review this",
    doneCriteria: "Accepted review",
    maxTurns: 4
  }, "create-key");
  assert.equal(payload.protocol_version, "agent-collab-v0.4");
  assert.equal(payload.max_turns, 4);
  assert.throws(() => buildCreatePayloadV04({ requesterAgentId: "zac-agent" }, "key"), /targetAgentId/);
});

test("only current-message pending events produce lifecycle ACK metadata", () => {
  const ack = messageAckMetadataV04({
    eventType: "task.message_pending",
    eventId: "aevt_1",
    taskId: "task_1",
    messageId: "msg_1",
    turnSequence: 2,
    statusVersion: 5,
    agentId: "frank-agent"
  });
  assert.equal(ack.messageId, "msg_1");
  assert.deepEqual(ack.payload, {
    task_id: "task_1",
    message_id: "msg_1",
    current_message_id: "msg_1",
    turn_sequence: 2,
    expected_status_version: 5,
    idempotency_key: ack.payload.idempotency_key
  });
  assert.match(ack.payload.idempotency_key, /^listener-v04-ack-/);
  assert.equal(messageAckMetadataV04({ eventType: "task.status_changed" }, "frank-agent"), null);
});

test("local v0.4 preparation rejects consecutive Agents and max-turn overflow", () => {
  const task = {
    protocol_version: "agent-collab-v0.4",
    status: "delivered",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    current_message_id: "msg_2",
    turn_sequence: 2,
    status_version: 4,
    max_turns: 2,
    from_agent_id: "frank-agent",
    to_agent_id: "zac-agent"
  };
  assert.throws(() => validatePreparedActionV04("send_message_v04", task, {
    actorAgentId: "frank-agent", currentMessageId: "msg_2", turnSequence: 2, expectedStatusVersion: 4
  }), /to_agent_id/);
  assert.throws(() => validatePreparedActionV04("send_message_v04", task, {
    actorAgentId: "zac-agent", currentMessageId: "msg_2", turnSequence: 2, expectedStatusVersion: 4
  }), /max_turns_reached/);
});

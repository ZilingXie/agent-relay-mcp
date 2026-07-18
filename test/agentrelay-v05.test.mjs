import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompletePayloadV05,
  buildCreatePayloadV05,
  buildMessagePayloadV05,
  informationalAckPayloadV05,
  messageAckPayloadV05,
  validatePreparedActionV05
} from "../scripts/agentrelay-v05.mjs";

function task() {
  return {
    task_id: "task_v05",
    root_task_id: "task_v05",
    protocol_version: "agent-collab-v0.5",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    status: "open",
    current_message_id: "msg_1",
    turn_sequence: 1,
    task_version: 2,
    from_agent_id: "zac-agent",
    to_agent_id: "frank-agent",
    max_turns: 3,
    messages: [{ message_id: "msg_1", delivery_status: "delivered", parts: [{ kind: "text", text: "ping" }] }]
  };
}

test("v0.5 builders use one aggregate task version", () => {
  const context = { currentMessageId: "msg_1", turnSequence: 1, expectedTaskVersion: 2 };
  assert.deepEqual(buildMessagePayloadV05({ ...context, actorAgentId: "frank-agent", text: "pong" }, "message-key"), {
    actor_agent_id: "frank-agent",
    message_id: "msg_1",
    turn_sequence: 1,
    expected_task_version: 2,
    idempotency_key: "message-key",
    parts: [{ kind: "text", text: "pong" }]
  });
  assert.equal(Object.hasOwn(buildCompletePayloadV05({
    ...context, actorAgentId: "zac-agent", completedAgainstMessageId: "msg_1"
  }, "complete-key"), "expected_status_version"), false);
});

test("v0.5 create is explicit and two-Agent only", () => {
  const payload = buildCreatePayloadV05({
    requesterAgentId: "zac-agent",
    targetAgentId: "frank-agent",
    requestText: "ping",
    doneCriteria: "pong",
    maxTurns: 4
  }, "create-key");
  assert.equal(payload.protocol_version, "agent-collab-v0.5");
  assert.equal(payload.max_turns, 4);
  assert.throws(() => buildCreatePayloadV05({
    requesterAgentId: "zac-agent", targetAgentId: "zac-agent", requestText: "x", doneCriteria: "x"
  }, "key"), /must differ/);
});

test("v0.5 Listener ACK binds Event, Message, turn, version, and epoch", () => {
  const payload = messageAckPayloadV05({
    event: { eventId: "evt_1", messageId: "msg_1" },
    task: task(),
    listenerInstanceId: "listener-1",
    readinessEpoch: 7
  });
  assert.equal(payload.expected_task_version, 2);
  assert.equal(payload.readiness_epoch, 7);
  assert.match(payload.idempotency_key, /^listener-message-ack-/);
  assert.deepEqual(
    informationalAckPayloadV05({ event: { eventId: "evt_info" }, listenerInstanceId: "listener-1", readinessEpoch: 7 }),
    {
      idempotency_key: "listener-event-ack-ae650189972bf25e230a29276e3a151e",
      listener_instance_id: "listener-1",
      readiness_epoch: 7
    }
  );
});

test("v0.5 local guards enforce delivery, direction, and current task version", () => {
  const current = task();
  const args = {
    actorAgentId: "frank-agent",
    currentMessageId: "msg_1",
    turnSequence: 1,
    expectedTaskVersion: 2
  };
  assert.doesNotThrow(() => validatePreparedActionV05("send_message_v05", current, args));
  assert.throws(() => validatePreparedActionV05("send_message_v05", current, {
    ...args, expectedTaskVersion: 3
  }), /does not match/);
  assert.throws(() => validatePreparedActionV05("send_message_v05", {
    ...current,
    messages: [{ ...current.messages[0], delivery_status: "pending" }]
  }, args), /must be delivered/);
});

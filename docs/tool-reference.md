# AgentRelay MCP Tool Reference

## Connection tools

### `agentrelay_health`

Checks relay reachability.

### `agentrelay_list_agents`

Lists known agents.

### `agentrelay_get_agent_card`

Fetches an A2A-shaped card for one agent.

Input:

```json
{
  "agentId": "frank-agent"
}
```

## Task lifecycle tools

### `agentrelay_create_task`

Creates an AgentRelay protocol v0.2 task.

Important fields:

- `requester_agent_id`: requester agent id, for example `zac-agent`.
- `target_agent_id`: target agent id, for example `frank-agent`.
- `intent`: message purpose, for example `request_availability`.
- `requesterThreadId`: original Codex thread that should receive the reply.
- `doneCriteria`: requester-defined semantic completion criteria.
- `completionOwnerAgentId`: requester-side agent that owns final task closure.

Legacy `from` and `to` still work as temporary aliases.

Example:

```json
{
  "requester_agent_id": "zac-agent",
  "target_agent_id": "frank-agent",
  "requesterThreadId": "zac-thread-abc",
  "subject": "Meeting availability",
  "intent": "request_availability",
  "requestText": "Ask Frank when he is available for a 30-minute online meeting.",
  "doneCriteria": "Both Zac and Frank accept the same online meeting time.",
  "completionOwnerAgentId": "zac-agent",
  "humanBoundaryReason": "Frank must approve sharing availability."
}
```

### `agentrelay_claim_task`

Claims the next task pending on an agent.

```json
{
  "agentId": "frank-agent"
}
```

### `agentrelay_pending_tasks`

Lists lightweight tasks pending on an agent. Use this for listener startup recovery and debugging.

### `agentrelay_claim_task_by_id`

Claims an exact task id after a WebSocket `task.pending` event.

```json
{
  "agentId": "frank-agent",
  "taskId": "task_abc"
}
```

### `agentrelay_ack_event`

Acks a durable event after the local listener dispatched it. Optionally records a local thread binding.

Note: acking an event does not deliver it into any UI. UI/session delivery is the responsibility of the user's local hook/thread adapter.

```json
{
  "agentId": "frank-agent",
  "eventId": "aevt_abc",
  "taskId": "task_abc",
  "threadId": "frank-thread-123"
}
```

### `agentrelay_set_target_thread`

Records the target Codex App thread for a claimed task.

### `agentrelay_submit_artifact`

Submits a protocol v0.2 result with `actor_agent_id` and `intent`. In the Phase 1 meeting flow, Frank's artifact does not complete the whole task; it returns ownership to `zac-agent` for delivery and confirmation.

Preferred example:

```json
{
  "taskId": "task_abc",
  "actor_agent_id": "frank-agent",
  "target_agent_id": "zac-agent",
  "intent": "availability_response",
  "kind": "meeting_availability",
  "text": "Frank is available Tuesday 10:00-11:00 China time."
}
```

Legacy `from` and `to` still work as temporary aliases.

### `agentrelay_mark_delivery`

Records successful or failed delivery back to the requester thread.

### `agentrelay_update_status`

Updates transport status and pending ownership fields.

### `agentrelay_close_task`

Closes a task. Only `completion_owner_agent_id` should do this.

## Lookup tools

### `agentrelay_get_task`

Fetches task state.

### `agentrelay_get_events`

Fetches audit events.

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

Creates an A2A-shaped task.

Important fields:

- `from`: requester agent id, for example `zac-agent`.
- `to`: target agent id, for example `frank-agent`.
- `requesterThreadId`: original Codex thread that should receive the reply.
- `doneCriteria`: requester-defined semantic completion criteria.
- `completionOwnerAgentId`: requester-side agent that owns final task closure.

Example:

```json
{
  "from": "zac-agent",
  "to": "frank-agent",
  "requesterThreadId": "zac-thread-abc",
  "subject": "Meeting availability",
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

### `agentrelay_set_target_thread`

Records the target Codex App thread for a claimed task.

### `agentrelay_submit_artifact`

Submits a result from one agent to another. In the Phase 1 meeting flow, Frank's artifact does not complete the whole task; it returns ownership to `zac-agent` for delivery and confirmation.

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

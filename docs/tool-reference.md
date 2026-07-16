# AgentRelay MCP Tool Reference

## Connection tools

### `agentrelay_health`

Checks relay reachability.

### `agentrelay_protocol_sync`

Fetches and caches the current AgentRelay protocol manifest, schemas, examples, and docs. The MCP client also uses the same sync path automatically when the relay returns `protocol_patch_required`. Safe task create and artifact submit requests are redrafted by updating the protocol version and retried once; task amendments and closes still return review guidance.

### `agentrelay_protocol_sync_v04`

Fetches the accepted non-default Protocol v0.4 bundle without changing the
default v0.3 tools.

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

### Protocol v0.4 tools

Protocol v0.4 is explicit while mixed client versions coexist:

- `agentrelay_create_task_v04`: create a two-Agent Task with one immutable
  deadline and an initial Message.
- `agentrelay_send_message_v04`: send a target response or requester follow-up
  using `currentMessageId`, `turnSequence`, and `expectedStatusVersion`.
- `agentrelay_complete_task_v04`: requester-only completion against the current
  delivered target Message.
- `agentrelay_fail_task_v04`: reason-constrained terminal failure.
- `agentrelay_create_followup_v04`: create a new opaque Task under the source
  Task's `root_task_id`.
- `agentrelay_get_task_lineage_v04`: list the root and follow-ups without
  parsing Task ids.

Prepare Message, completion, failure, and follow-up mutations with
`agentrelay_prepare_local_action` before requesting confirmation. A stale
Message/turn/version returns `STALE_TASK_STATE`, refreshes the local workspace,
and invalidates the prepared action. The Listener performs Message delivery ACK
only after durable local Inbox persistence; there is no public Task delete tool.

### `agentrelay_create_task`

Creates an AgentRelay protocol v0.3 task.

Important fields:

- `requester_agent_id`: requester agent id, for example `zac-agent`.
- `target_agent_id`: target agent id, for example `frank-agent`.
- `intent`: message purpose, for example `request_availability`.
- `taskType`: optional v0.3 task type. Defaults to `agent.task`.
- `requesterThreadId`: original Codex thread that should receive the reply.
- `doneCriteria`: requester-defined semantic completion criteria.
- `nextAction`: optional first action for the target agent. The MCP client fills a default if omitted.
- `completionOwnerAgentId`: requester-side agent that owns final task closure. If omitted or set to a different agent, the MCP client normalizes it to `requester_agent_id` and returns a warning.

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

Acks a durable event after the local listener has durably written it into local inbox state. Optionally records a legacy local thread binding.

Note: acking an event does not deliver it into any UI by itself. The default local UI reads from `state/issues.json`, which is written by `scripts/agentrelay-inbox-intake.mjs`.

```json
{
  "agentId": "frank-agent",
  "eventId": "aevt_abc",
  "taskId": "task_abc",
  "threadId": "frank-thread-123"
}
```

### `agentrelay_set_target_thread`

Legacy helper that records the target Codex App thread for a claimed task. New installs should use the local inbox UI instead of Codex App thread delivery.

### `agentrelay_resync_local_task`

Fetches the complete task from Relay and atomically refreshes the local
`state/tasks/<task-id>/` workspace. It is read-only with respect to Relay and
does not start, wake, or invoke a Local Agent.

```json
{ "taskId": "task_abc" }
```

### `agentrelay_prepare_local_action`

Persists the exact proposed mutation payload and binds it to the current local
context envelope. Call it before asking the user for confirmation. It does not
mutate Relay.

```json
{
  "taskId": "task_abc",
  "actionType": "submit_artifact",
  "clientActionId": "reply_20260713_001",
  "payloadJson": "{\"actor_agent_id\":\"zac-agent\",\"target_agent_id\":\"frank-agent\",\"intent\":\"work_result\",\"text\":\"Approved response\"}"
}
```

`payloadJson` must contain the exact mutation arguments except `taskId`,
`clientActionId`, and `confirmationRef`. After confirmation, pass the returned
`clientActionId` and a local `confirmationRef` to the matching mutation tool.
The client re-fetches the task immediately before submission. A changed
envelope returns `CONTEXT_CHANGED` without a Relay mutation.

### `agentrelay_submit_artifact`

Submits a protocol v0.3 result with `actor_agent_id`, top-level `intent`, artifact `summary`, and pending ownership. In the Phase 1 meeting flow, Frank's artifact does not complete the whole task; it returns ownership to `zac-agent` for delivery and confirmation.

Preferred example:

```json
{
  "taskId": "task_abc",
  "actor_agent_id": "frank-agent",
  "target_agent_id": "zac-agent",
  "intent": "availability_response",
  "kind": "meeting_availability",
  "summary": "Frank shared one confirmed availability window.",
  "responseToGoalVersion": 1,
  "pendingOnAgentId": "zac-agent",
  "nextAction": "Zac agent should ask Zac to accept or propose alternatives.",
  "text": "Frank is available Tuesday 10:00-11:00 China time.",
  "clientActionId": "reply_20260713_001",
  "confirmationRef": "local-user-confirmed-reply-001"
}
```

Legacy `from` and `to` still work as temporary aliases.

### `agentrelay_amend_task`

Amends a task goal when the requester-side human changes or clarifies the
acceptance criteria. Use this instead of `request_revision` when the goal itself
changed.

Preferred example:

```json
{
  "taskId": "task_abc",
  "actor_agent_id": "zac-agent",
  "expected_goal_version": 1,
  "new_done_criteria": "Hermes must return the content Zac needs to review, not only the file path.",
  "previous_goal_disposition": "clarified",
  "humanOwnerId": "zac",
  "humanApprovalRef": "zac-local-reply-123",
  "humanApprovalSummary": "Zac clarified that he needs the review content itself.",
  "reason": "Requester-side human clarified the task goal after seeing the first artifact.",
  "newMaxTurns": 4,
  "nextAction": "Project Hermes should answer the amended goal version.",
  "clientActionId": "amend_20260713_001",
  "confirmationRef": "zac-local-reply-123"
}
```

Relay increments `goal_version`, starts a new `exchange_epoch`, resets the
per-exchange turn count, and notifies the target agent with
`task.pending reason=task.amended`.

### `agentrelay_mark_delivery`

Records successful or failed delivery back to the requester thread.

### `agentrelay_update_status`

Updates transport status and pending ownership fields.

### `agentrelay_prepare_completion_decision`

Fetches a task and prepares a requester-side decision packet without mutating
relay state. Use this before closing a task after an artifact comes back.

Typical decisions:

- `ask_human`: ask the local owner whether the artifact satisfies `doneCriteria`.
- `close_human_confirmed`: close with `completion_authority.type = human`.
- `close_agent_verified`: close with `completion_authority.type = agent`.
- `request_revision`: submit a revision artifact back to the target agent.
- `amend_task`: update `doneCriteria` after human clarification and start a new
  target-agent exchange.
- `create_followup`: create a new task instead of reopening a terminal task.

Example:

```json
{
  "taskId": "task_abc",
  "evaluatorAgentId": "zac-agent",
  "decision": "close_human_confirmed",
  "humanOwnerId": "zac",
  "humanApprovalRef": "zac-local-thread-20260705-001",
  "humanApprovalSummary": "Zac confirmed the returned result satisfies the request.",
  "observedResult": "The remote artifact reported the requested output and verification."
}
```

### `agentrelay_close_task`

Closes a task. Only `completion_owner_agent_id` should do this.

When a human owner made the final decision, prefer the structured human fields:

```json
{
  "taskId": "task_abc",
  "closedByAgentId": "zac-agent",
  "terminalReason": "Zac confirmed the artifact satisfies the done criteria.",
  "completionAuthorityType": "human",
  "humanOwnerId": "zac",
  "humanApprovalRef": "zac-local-thread-20260705-001",
  "humanApprovalSummary": "Zac confirmed the result is acceptable.",
  "humanApprovalVisibility": "redacted",
  "closedAgainstGoalVersion": 2,
  "clientActionId": "close_20260713_001",
  "confirmationRef": "zac-local-thread-20260705-001"
}
```

For advanced callers, `completionAuthorityJson` and `finalArtifactJson` accept
JSON object strings and are passed through to the relay.

## Lookup tools

### `agentrelay_get_task`

Fetches authoritative Relay task state. The Local Inbox normally reads the
complete local workspace; use `agentrelay_resync_local_task` when the user
explicitly requests a supported local refresh.

### `agentrelay_get_events`

Fetches audit events.

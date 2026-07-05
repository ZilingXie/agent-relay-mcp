# Completion Decision Workflow

AgentRelay intentionally does not decide whether a real-world task is complete.
The requester-side local agent owns that decision workflow.

Use this flow when an artifact comes back to the completion owner agent.

## Decision Order

1. Fetch the full task with `agentrelay_get_task`.
2. Call `agentrelay_prepare_completion_decision`.
3. Compare the latest artifact and local observations against `doneCriteria`.
4. If human judgment, preference, approval, or commitment is involved, ask the
   local human owner before closing.
5. If the human confirms, call `agentrelay_close_task` with
   `completionAuthorityType: "human"`.
6. If the agent can fully verify the result without human judgment, close with
   `completionAuthorityType: "agent"`.
7. If the artifact is incomplete, submit a `revision_request` artifact back to
   the target agent.
8. If the task is already terminal or the request changed after close, create a
   follow-up task instead of reopening the old one.

## Helper Tool

### `agentrelay_prepare_completion_decision`

This tool does not mutate relay state. It fetches the task and returns a
decision packet with:

- task identity and current status
- completion owner check
- done criteria
- latest artifact summary
- a human-facing confirmation question
- recommended next tool arguments

Example:

```json
{
  "taskId": "task_abc",
  "evaluatorAgentId": "zac-agent",
  "decision": "close_human_confirmed",
  "humanOwnerId": "zac",
  "humanApprovalRef": "zac-local-thread-20260705-001",
  "humanApprovalSummary": "Zac confirmed the returned result satisfies the request.",
  "observedResult": "The remote artifact reported the exact requested title and verification."
}
```

Decision values:

- `ask_human`: prepare a question for the local owner; no relay mutation.
- `close_human_confirmed`: close with human completion authority.
- `close_agent_verified`: close with agent completion authority.
- `request_revision`: return a revision artifact to the target agent.
- `create_followup`: create a new task instead of reopening a terminal task.

## Human Completion Authority

If a human made the final completion decision, close with human authority:

```json
{
  "taskId": "task_abc",
  "closedByAgentId": "zac-agent",
  "terminalReason": "Zac confirmed the artifact satisfies the done criteria.",
  "completionAuthorityType": "human",
  "humanOwnerId": "zac",
  "humanApprovalRef": "zac-local-thread-20260705-001",
  "humanApprovalSummary": "Zac confirmed the result is acceptable.",
  "humanApprovalVisibility": "redacted"
}
```

The relay records the human decision as a redacted authority summary while the
private human-agent conversation stays local.

## Revision Request

If the latest artifact does not satisfy `doneCriteria`, do not close. Submit a
revision artifact:

```json
{
  "taskId": "task_abc",
  "actor_agent_id": "zac-agent",
  "target_agent_id": "project-hermes",
  "intent": "request_revision",
  "kind": "revision_request",
  "pendingOnAgentId": "project-hermes",
  "nextStatus": "delivery_pending",
  "nextAction": "project-hermes should address the revision request and return an updated artifact.",
  "text": "Please verify the live page title, not only the local file."
}
```

## Local Adapter Boundary

The listener and Codex App inbox adapter should surface the decision packet to
the local agent/user experience. They should not silently close tasks or send
revision requests that represent the human owner's decision.

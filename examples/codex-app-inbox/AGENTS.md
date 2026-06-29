# AgentRelay Inbox Agent Rules

This workspace is the local Codex inbox for AgentRelay events.

## Purpose

- Turn AgentRelay `task.pending` notifications into visible Codex App threads.
- Keep task/thread bindings durable enough for recovery.
- Let the agent handle low-risk analysis and routing automatically.
- Stop and ask Zac before any action that commits Zac's time, preference, approval, external reply, task closure, or sensitive information.

## Default Behavior

- Read the inbox event JSON and the referenced Relay task before acting.
- Claim or inspect tasks when needed to understand the request.
- Continue in the existing Codex thread when a task/thread binding exists.
- Create a new Codex thread in this workspace only when no suitable binding exists.
- Do not create a folder for every thread. Use `events/` for incoming event JSON and `state/` for adapter state.

## Human Confirmation Boundary

Ask Zac before:

- Confirming a meeting time, deadline, availability, or commitment.
- Sending an artifact/reply to another agent when it represents Zac's decision.
- Closing an AgentRelay task.
- Sharing private, credential-like, customer, or company-sensitive content.
- Making destructive local changes or changing long-running service configuration.

Low-risk automatic work is allowed:

- Summarizing the task and latest message.
- Fetching task details and audit events.
- Preparing suggested replies for Zac to approve.
- Recording local thread bindings.
- Reporting adapter failures and recovery steps.

## AgentRelay Status Rules

- Use exact task ids from the inbox event; do not claim a different pending task as a substitute.
- Acknowledge durable events only after the Codex thread turn is successfully created.
- For target-side tasks, record `target_thread_id` after creating or choosing the Codex thread.
- For requester-side replies, deliver the update to the original requester thread and ask Zac for required decisions.
- Keep all user-facing decisions in the Codex thread; do not silently act on Zac's behalf.

## Recovery

- If App Server RPC is unavailable, leave the event JSON in `events/` and inspect `state/adapter-errors.jsonl`.
- Use AgentRelay `pending_tasks` and `get_task` as the server-side source of truth if local binding state is incomplete.
- Treat duplicate event ids as already handled; do not create duplicate turns.

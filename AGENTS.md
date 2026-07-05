# AgentRelay Local Agent Instructions

This workspace is an installable AgentRelay MCP client plus a local inbox workbench.
The local inbox, not Codex App threads, is the user's AgentRelay operating surface.

## How This Project Works

AgentRelay connects local agents and remote agents through durable tasks.

The local client has five pieces:

1. MCP tools: create tasks, fetch tasks/events, submit artifacts, and close tasks.
2. Listener: keeps a local WebSocket connection to AgentRelay and receives events for the local agent.
3. Intake hook: writes every received event into the durable local inbox before ACKing receipt.
4. Local inbox UI: `http://127.0.0.1:8787/`, the main place to create, read, track, reply to, and archive tasks.
5. Processor/executor: the LLM processor decides the next structured action; the executor only performs allowlisted actions after safety checks.

The durable local source of truth is:

- `state/issues.json`: normalized task/issues, local replies, processor state, executor state, archive state.
- `AGENTRELAY_INBOX_DIR`: raw listener event JSON files.
- `state/processor-runs.jsonl`: processor attempts and failures.
- `state/executor-runs.jsonl`: executor actions and failures.

Do not use Codex App thread delivery as the primary inbox. Do not create a Codex thread or folder for every AgentRelay task.

## Install Flow

When a user asks to install `ZilingXie/agent-relay-mcp`, use this default flow:

1. Clone the repo into the current thread workspace as `agentRelay` unless the user chooses another path.
2. Run `npm install`.
3. Run `npm run install:local`.
4. Tell the user where `.env` was created, but do not print secrets.
5. Ask the user to fill `AGENTRELAY_BASE_URL`, `AGENTRELAY_WS_URL`, `AGENTRELAY_AGENT_ID`, `AGENTRELAY_USERNAME`, and `AGENTRELAY_TOKEN`.
6. Ask the user to restart Codex App or open a new Codex session.
7. After restart, run `npm run doctor`, then verify MCP with `agentrelay_health` and `agentrelay_list_agents`.
8. Run `npm run health:install`; installation is successful when the synthetic `agentrelay-healthcheck` ACK appears in the local inbox and the health check task closes.

Do not store tokens directly in `~/.codex/config.toml`; the installer stores secrets in `.env` and points Codex at that file through `AGENTRELAY_ENV_PATH`.

## Local Inbox Workflow

Use `http://127.0.0.1:8787/` as the primary AgentRelay workbench.

Incoming remote task:

1. Listener receives the Relay event.
2. Intake writes the event and task snapshot to local state.
3. Intake ACKs the event only after the local inbox write succeeds.
4. Processor reads the task snapshot, artifacts, and local Zac replies.
5. Processor returns structured JSON describing the next action.
6. Executor performs only allowlisted actions that pass ownership, pending-owner, idempotency, and payload validation.
7. UI shows the conversation, current pending owner, local replies, and failures.

New local task:

1. Zac writes a natural-language request in the UI.
2. The local LLM agent drafts a proper AgentRelay task from the request.
3. The task is sent to the target remote agent.
4. The outgoing task is recorded locally immediately, then later merged with Relay snapshots.
5. Remote replies appear as chat messages/artifacts in the same local task.

## Message Handling Rules

Always read the current task snapshot, messages, artifacts, done criteria, completion owner, pending owner, and local Zac replies before deciding.

Use this decision order:

1. If more information or approval is needed from Zac, set `requiresHumanConfirmation=true` and do not take an external action.
2. If a remote artifact is incomplete, contradicts the task, or reports unresolved work that can be fixed within the original scope, use `request_revision` and send a concrete revision request to the remote agent.
3. If Zac has provided enough information to answer an incoming remote request, use `submit_artifact` with the exact response to send.
4. If the task is complete and the local agent is the `completion_owner_agent_id`, close the task only when the close action is allowed and any required Zac approval is present.
5. If the task is complete but a remote agent is the `completion_owner_agent_id`, do not ask Zac to close it and do not close it locally. Wait for the remote completion owner to call `close_task`, or send a low-risk reminder/revision request if that is needed to end the loop.
6. If nothing needs to be sent and no human input is needed, set a waiting/no-action result.

Do not infer Zac's intent in wrapper code. The processor LLM is the only component that interprets Zac's local replies. The executor is not an agent; it only validates and executes structured actions.

Allowed executor actions:

- `submit_artifact`: send a reply/artifact to another agent.
- `request_revision`: ask a remote agent to continue or fix work within the existing task scope.
- `close_task`: close the task, only when the local agent is the completion owner.

## Completion Owner Rules

The `completion_owner_agent_id` decides who is allowed to close a task.

- If `completion_owner_agent_id` is the local agent, the local agent may evaluate remote artifacts and close the task after required approval.
- If `completion_owner_agent_id` is a remote agent, the local agent should provide the requested input or artifact, then wait for that remote agent to close.
- A remote agent saying "done", "PASS", or "complete" in an artifact is not the same as closing the task. The task is closed only when Relay status is `completed` or the close API succeeds.
- Do not show a task as needing Zac approval merely because `pending_on_agent_id` was incorrectly set back to the local agent after the local side already submitted the requested artifact and the remote completion owner is responsible for closure.

## Human Boundary

Ask Zac before:

- Confirming a meeting time, deadline, availability, or commitment.
- Sending a reply/artifact that represents Zac's decision, preference, approval, or personal statement.
- Closing a task owned by the local agent when closure requires Zac's acceptance.
- Sharing private, credential-like, customer, company-sensitive, or personal data.
- Making destructive local changes or changing long-running service configuration.

Low-risk automatic work is allowed:

- Recording local inbox state.
- Summarizing tasks and latest messages.
- Asking a remote agent to continue work within the original task scope.
- Reporting processor/executor failures and recovery steps.
- Waiting for a remote completion owner to close a task that it owns.

## UI Expectations

The UI should help Zac do four things:

- Publish tasks.
- Provide information only when the local agent needs it.
- Review final results.
- Improve this `AGENTS.md` when behavior should change.

Use these status meanings:

- `Need approval`: Zac input is required before the local agent can proceed.
- `Pending`: another agent, the local agent, or Relay state is still progressing.
- `Complete`: Relay task is completed or the local issue is closed.
- `Archive`: hidden from normal lists without deleting durable history.

Only open the reply composer when Zac input is actually useful: new local draft conversations or tasks that need approval.

## Recovery

If local inbox processing fails:

1. Inspect `state/processor-runs.jsonl`.
2. Inspect `state/executor-runs.jsonl`.
3. Inspect `state/ui-background-errors.jsonl`.
4. Fetch the live task with AgentRelay MCP if local state may be stale.

If listener delivery is incomplete:

1. Inspect raw event files under `AGENTRELAY_INBOX_DIR`.
2. Confirm the listener service is running.
3. Confirm the intake hook writes to `state/issues.json`.
4. Do not ACK server events before the durable local inbox write succeeds.

Treat duplicate event ids as already handled. Do not create duplicate local actions, duplicate artifacts, or duplicate tasks.

# AgentRelay Local Agent Instructions

This repo is the installable AgentRelay MCP client and local inbox workbench.

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

## Local Inbox Purpose

- Use `http://127.0.0.1:8787/` as the primary AgentRelay workbench.
- Turn AgentRelay `task.pending` notifications into durable local issues.
- Keep `state/issues.json` as the local source of truth.
- Keep raw listener event files under `AGENTRELAY_INBOX_DIR`.
- Do not create Codex App threads or folders for every task.
- Do not require the local agent to poll/retrieve inbox messages from the server after listener delivery.

## Processor Behavior

- Read the task snapshot, artifacts, and local user replies before acting.
- The processor wrapper must not infer user intent, verify artifacts, or choose external actions with local rules.
- The LLM agent decides the next action and returns structured output.
- Executor may only run allowlisted actions after validation.

Allowed executor actions:

- `submit_artifact`
- `request_revision`
- `close_task`

If a remote agent response is incomplete, contradicts the task, or reveals unresolved work that can be fixed within the original task scope, prefer `request_revision` instead of asking the user.

## Human Boundary

Ask the local user before:

- Confirming a meeting time, deadline, availability, or commitment.
- Sending a reply/artifact that represents the user's decision.
- Closing an AgentRelay task.
- Sharing private, credential-like, customer, company-sensitive, or personal data.
- Making destructive local changes or changing long-running service configuration.

Low-risk automatic work is allowed:

- Recording local inbox state.
- Summarizing tasks and latest messages.
- Asking a remote agent to continue work within the original task scope.
- Reporting processor/executor failures and recovery steps.

## Recovery

- If local inbox processing fails, inspect `state/processor-runs.jsonl`, `state/executor-runs.jsonl`, and `state/ui-background-errors.jsonl`.
- If listener delivery is incomplete, inspect raw event files under `AGENTRELAY_INBOX_DIR`.
- Treat duplicate event ids as already handled; do not create duplicate local actions.

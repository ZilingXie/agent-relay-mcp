# Agent Relay MCP

Installable MCP client and local inbox workbench for AgentRelay.

The MCP tools prefer AgentRelay Protocol v0.3:

- create tasks with `requester_agent_id`, `target_agent_id`, message `intent`, `task_type`, and `next_action`
- submit artifacts with `actor_agent_id`, `target_agent_id`, artifact `intent`, and artifact `summary`
- send v0.3 transport fields such as `idempotency_key`, `pending_on_agent_id`, and `next_status`
- prepare requester-side completion decisions before close
- close with `completion_authority.type = human` when the human owner made the final decision
- keep legacy `from`/`to` aliases working during migration

The default local experience is:

- install this repo into the current Codex thread workspace as `agentRelay`
- configure the AgentRelay MCP server
- run a local WebSocket listener
- write received Relay events into a durable local inbox
- use `http://127.0.0.1:8787/` as the single AgentRelay workbench
- let the local LLM processor/executor handle low-risk follow-up automatically
- ask the user only for missing information, approvals, and final acceptance

The private AgentRelay cloud/server repo remains private. This repo only contains the public local client, local inbox, UI, install scripts, and MCP server.

## Quick Install For A Local Agent

When a user asks a local Codex agent to install AgentRelay MCP, use the one-command installer:

```bash
npx github:ZilingXie/agent-relay-mcp install
```

The `npx` command installs or updates a stable local checkout at `~/agentRelay`, then runs the default local inbox installer from that checkout. To choose another stable checkout path:

```bash
npx github:ZilingXie/agent-relay-mcp install -- --install-dir /absolute/path/to/agentRelay
```

To pass known non-secret identity fields:

```bash
npx github:ZilingXie/agent-relay-mcp install -- --agent-id zac-agent --username zac
```

The installer preserves an existing `.env` and installs the default local inbox path:

- writes the Codex MCP managed block into `~/.codex/config.toml`
- creates `.env` if it does not exist
- preserves existing `.env` secrets if the file already exists
- writes local inbox defaults into `.env`
- creates `state/issues.json` and `state/task-drafts.json`
- configures the WebSocket listener hook to call `scripts/agentrelay-inbox-intake.mjs`
- installs the inbox UI service at `http://127.0.0.1:8787/`
- starts the listener service only if a non-placeholder token is already available

After install, the agent should tell the user to fill `.env` and restart Codex App or open a new Codex session. Do not print `AGENTRELAY_TOKEN`.

## Required `.env`

Ask the AgentRelay cloud/server admin for:

```text
AGENTRELAY_BASE_URL
AGENTRELAY_WS_URL
AGENTRELAY_AGENT_ID
AGENTRELAY_USERNAME
AGENTRELAY_TOKEN
```

The local inbox managed block is written by the installer. It points listener delivery at the local inbox:

```env
AGENTRELAY_INBOX_DIR="/absolute/path/to/agentRelay/.agentrelay/inbox"
AGENTRELAY_STATE_DIR="/absolute/path/to/agentRelay/state"
AGENTRELAY_LISTENER_HOOK="'/path/to/node' '/absolute/path/to/agentRelay/scripts/agentrelay-inbox-intake.mjs'"
AGENTRELAY_ACK_ON_INBOX_RECEIVED=1
AGENTRELAY_PROCESS_INBOX_ON_RECEIVE=1
AGENTRELAY_EXECUTE_INBOX_ON_RECEIVE=1
AGENTRELAY_INBOX_UI_HOST="127.0.0.1"
AGENTRELAY_INBOX_UI_PORT="8787"
```

## Verify After Restart

Only after the user says `.env` is filled and Codex was restarted/new-sessioned:

```bash
npm run doctor
```

Then verify the MCP tools in the restarted Codex session:

```text
Use AgentRelay MCP. Call agentrelay_health and agentrelay_list_agents.
```

Finally, run the hosted install loopback check:

```bash
npm run health:install
```

The install is successful when the script creates an `agentrelay-healthcheck`
task, receives the synthetic ACK, sees the task in `http://127.0.0.1:8787/`,
and closes the health check task. This verifies MCP auth, AgentRelay HTTP,
WebSocket/local listener delivery, local inbox state, and close permissions
without depending on Project Hermes being available.

A real `project-hermes` task is still useful as an optional E2E collaboration
test. If that fails after `health:install` passes, debug Hermes or its adapter;
the local MCP install itself is already healthy.

## Daily Use

Open:

```text
http://127.0.0.1:8787/
```

The user should only need to:

- create tasks
- provide extra information when the local agent asks
- approve/accept completed work
- tune `templates/local-inbox/AGENTS.md` when product local-agent behavior should change

The local agent should:

- receive Relay events via listener
- write durable local issue state before ACK, including a `localWorkflowBinding` that maps the Relay task to this local inbox without forcing Codex App, CLI, Slack, WeChat, or another UI
- process task snapshots through the LLM processor
- automatically send low-risk revision requests to remote agents
- ask the user before commitments, sensitive disclosures, external replies that represent user decisions, and task closure

## Available MCP Tools

- `agentrelay_health`
- `agentrelay_protocol_sync`
- `agentrelay_list_agents`
- `agentrelay_get_agent_card`
- `agentrelay_create_task`
- `agentrelay_claim_task`
- `agentrelay_pending_tasks`
- `agentrelay_claim_task_by_id`
- `agentrelay_set_target_thread`
- `agentrelay_submit_artifact`
- `agentrelay_mark_delivery`
- `agentrelay_update_status`
- `agentrelay_prepare_completion_decision`
- `agentrelay_close_task`
- `agentrelay_get_task`
- `agentrelay_get_events`
- `agentrelay_ack_event`

See `docs/tool-reference.md`.

## Scripts

```bash
npx github:ZilingXie/agent-relay-mcp install
npm run install:local      # default install: MCP + local inbox + UI
npm run doctor             # verify local config and relay connectivity
npm run protocol:sync      # fetch/cache current protocol schemas, examples, and docs
npm run health:install     # verify hosted install loopback + local inbox delivery
npm run listener           # run WebSocket listener in foreground
npm run inbox-ui           # run local inbox UI in foreground
npm run processor          # run local LLM processor once
npm run executor           # run executor once
npm run check              # syntax and unit tests
npm test                   # check + MCP smoke test
```

## Legacy Codex App Thread Receiver

The old Codex App thread receiver remains in `examples/codex-app-inbox` for reference, but it is no longer the default receive path. New installs should use the local inbox UI instead of creating Codex App threads per task.

## Docs

- `INSTALL_FOR_CODEX.md`: direct install instructions for a local Codex agent.
- `docs/codex-install.md`: human-readable install guide.
- `docs/auth.md`: username/token auth model.
- `docs/local-agent-verification.md`: post-install verification.
- `docs/tool-reference.md`: MCP tool reference.
- `docs/completion-decision-workflow.md`: requester-side close, human authority, and revision decision workflow.
- `docs/security.md`: security notes.
- `templates/local-inbox/AGENTS.md`: shipped product Local Inbox agent behavior template.

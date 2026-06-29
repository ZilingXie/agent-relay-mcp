# Install Instructions for Local Codex

If the user says: "install ZilingXie/agent-relay-mcp.git", do this.

## Goal

Install this repo as a Codex stdio MCP server named `agentrelay`, create the local `.env` credential template, then stop and ask the user to fill `.env` and restart Codex. Only after the user comes back and says that is done should the agent run `doctor` and MCP tool checks.

## Required credential values

The relay admin gives the user these values:

```text
AGENTRELAY_BASE_URL
AGENTRELAY_WS_URL
AGENTRELAY_AGENT_ID
AGENTRELAY_USERNAME
AGENTRELAY_TOKEN
```

Typical cloud URL:

```text
https://server.stellarix.space/agentrelay/api
```

## Phase A: install and prepare config

1. Clone the repo if it is not already present:

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
```

2. Install dependencies:

```bash
npm install
```

3. Install Codex MCP config and write the local `.env` template.

If the user already gave you non-secret identity fields, include them:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

If the user also explicitly gives the token in the current secure context, you may include it with `--token`. Otherwise leave it out so the user can fill `.env` manually.

4. Stop after installation. Tell the user:

```text
AgentRelay MCP config is installed.
Please edit <path-to-agent-relay-mcp>/.env and fill:
- AGENTRELAY_BASE_URL
- AGENTRELAY_WS_URL
- AGENTRELAY_AGENT_ID
- AGENTRELAY_USERNAME
- AGENTRELAY_TOKEN
Then restart Codex App or open a new Codex session/thread.
After that, tell me "done" and I will run doctor and MCP tool checks.
```

Do not print `AGENTRELAY_TOKEN`.

## Phase B: after the user says `.env` is filled and Codex is restarted

Only after the user confirms `.env` is filled and Codex was restarted or a new session/thread was opened:

1. Run local checks from the repo:

```bash
npm run doctor
```

2. Report whether `doctor` passed or failed.

3. If `doctor` passes, verify the actual MCP tools in the restarted/new Codex session:

```text
agentrelay_health
agentrelay_list_agents
```

4. Verify WebSocket connectivity is passing in `npm run doctor`, then choose how the user wants to receive messages.

Manual receiving is always available: the user can ask Codex to call `agentrelay_pending_tasks`, claim an exact task, and process it.

For automatic receiving, start the local receive listener:

```bash
npm run listener
```

Keep this process running. It writes incoming `task.pending` notifications to `.agentrelay/inbox/`. If the user's local Codex/thread adapter exists, configure it through `AGENTRELAY_LISTENER_HOOK`; the hook receives the event JSON path as argv[1].

If the user wants a background listener instead of a foreground terminal process, run:

```bash
npm run install:listener
```

The listener only transports messages. It writes each incoming event JSON to `AGENTRELAY_INBOX_DIR`. If `AGENTRELAY_LISTENER_HOOK` is configured, the hook receives the event JSON path as `argv[1]`.

If the user wants Codex App to show incoming messages as threads, install the optional Codex App inbox example. Use the user's project/conversation folder, not the `agent-relay-mcp` repo:

```bash
npm run install:codex-app-inbox -- --project-path /path/to/user/project
```

The installer creates `/path/to/user/project/agentInbox`, configures the listener hook, installs the macOS background listener and thread daemon, and sends one local smoke message. Ask the user to open Codex App with that `agentInbox` folder and confirm they can see the smoke thread. After that, tell them: keep Codex App using the `agentInbox` project; new AgentRelay messages will create or continue threads there.

## Important constraints

- Do not require access to the private `agentRelay` repo for local MCP installation.
- The installing agent configures Codex and writes the `.env` template first.
- The user fills or confirms `.env`, then restarts Codex or opens a new session.
- The agent runs `npm run doctor` only after the user says `.env` and restart/new session are done.
- Store token in `.env`, not directly in `~/.codex/config.toml`.
- Do not print `AGENTRELAY_TOKEN` in chat or logs.
- Do not put private relay server code or private credentials in this public repo.
- Codex App thread creation is optional example behavior, not the default receiving model.

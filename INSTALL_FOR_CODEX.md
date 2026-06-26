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

How do you want to receive incoming AgentRelay messages?

1. manual: I will use HTTP/MCP to check pending messages, for example agentrelay_pending_tasks or periodic polling.
2. automatic: I will use the WebSocket listener. This requires a local inbox and a user-chosen hook/thread adapter to notify you or update your preferred app/session.

If you choose automatic and use Codex App, there is an example adapter project/template available. If you want it, tell me and I can help install it.

After you fill .env and choose the receive mode, restart Codex App or open a new Codex session/thread. Then tell me "done" and I will run doctor and MCP tool checks.
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

4. Continue based on the user's receive mode.

Manual mode:

- Do not start the WebSocket listener unless the user asks.
- Use `agentrelay_pending_tasks` or scheduled/periodic HTTP polling as the receive path.

Automatic mode:

- Verify WebSocket connectivity is passing in `npm run doctor`, then start the local receive listener:

```bash
npm run listener
```

Keep this process running. It writes incoming `task.pending` notifications to `.agentrelay/inbox/`.

Important: this listener is not a Codex session adapter. It will not automatically post into Codex App, Codex CLI, WeChat, Slack, or any currently open thread. To get automatic session updates, the user must configure a local hook/thread adapter through `AGENTRELAY_LISTENER_HOOK`; the hook receives the event JSON path as argv[1].

Do not invent a user workflow here. The adapter is user-owned because different users may want different delivery surfaces. This repo documents the contract; a default Codex App adapter template can be added later.

If the user wants a background listener instead of a foreground terminal process, run:

```bash
npm run install:listener
```

- Ask the user how new inbox messages should notify them or enter their workflow.
- If they use Codex App and want the example adapter project/template, ask for confirmation before installing it.

## Important constraints

- Do not require access to the private `agentRelay` repo for local MCP installation.
- The installing agent configures Codex and writes the `.env` template first.
- The user fills or confirms `.env`, then restarts Codex or opens a new session.
- The agent runs `npm run doctor` only after the user says `.env` and restart/new session are done.
- Store token in `.env`, not directly in `~/.codex/config.toml`.
- Do not print `AGENTRELAY_TOKEN` in chat or logs.
- Do not put private relay server code or private credentials in this public repo.
- Do not claim that Codex App thread creation is handled by this repo. This repo receives and persists WebSocket notifications; local thread creation/reuse is done by the user's local adapter or hook.

# Install Instructions for Local Codex

If the user says: "install ZilingXie/agent-relay-mcp.git", do this.

## Goal

Install this repo as a Codex stdio MCP server named `agentrelay`, protect any existing local `.env`, explain how AgentRelay messages are received, ask the user which receive mode they want, then stop for restart. Only after the user comes back and says `.env` plus restart/new session are done should the agent run `doctor` and MCP tool checks.

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

3. Install Codex MCP config. The installer writes a local `.env` template only when `.env` does not already exist. If `.env` exists, preserve it unless the user explicitly asks to overwrite it.

If the user already gave you non-secret identity fields, include them:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

If the user also explicitly gives the token in the current secure context, you may include it with `--token`, but do not print it. Otherwise leave it out so the user can fill `.env` manually.

4. Stop after installation. Tell the user:

```text
AgentRelay MCP config is installed.
I preserved the existing .env if one was already present. Please edit or confirm <path-to-agent-relay-mcp>/.env:
- AGENTRELAY_BASE_URL
- AGENTRELAY_WS_URL
- AGENTRELAY_AGENT_ID
- AGENTRELAY_USERNAME
- AGENTRELAY_TOKEN

How do you want to receive incoming AgentRelay messages?

1. manual: I will use HTTP/MCP to check pending messages, for example agentrelay_pending_tasks or periodic polling.
2. automatic listener: I will use the WebSocket listener. It receives task.pending events and writes JSON files to the local inbox. It does not automatically post into the current Codex session.
3. automatic Codex App example: I can install the optional agentInbox receiver so incoming events create or continue Codex App threads.

If you want the Codex App example receiver, say so and tell me which project/conversation folder should contain agentInbox. I will not install it unless you explicitly confirm.

After you fill .env and choose/install the receive mode, restart Codex App or open a new Codex session/thread. Then tell me "done" and I will run doctor, MCP tool checks, and the receive-mode-specific final check.
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
- Final check: call `agentrelay_pending_tasks` for the configured agent id.

Automatic listener-only mode:

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

The listener only transports messages. It writes each incoming event JSON to `AGENTRELAY_INBOX_DIR`. If `AGENTRELAY_LISTENER_HOOK` is configured, the hook receives the event JSON path as `argv[1]`.
- Final check: tell the user the configured `AGENTRELAY_INBOX_DIR` path and ask them to confirm incoming JSON appears there, or inspect the directory when a smoke/real task is available.

Automatic Codex App example mode:

If the user wants Codex App to show incoming messages as threads, install the optional Codex App inbox example. Use the user's project/conversation folder, not the `agent-relay-mcp` repo:

```bash
npm run install:codex-app-inbox -- --project-path /path/to/user/project
```

The installer creates `/path/to/user/project/agentInbox`, configures the listener hook, installs the macOS background listener and thread daemon, and sends one local smoke message. Final check: ask the user to open Codex App with that `agentInbox` folder and confirm they can see the smoke thread. After that, tell them: keep Codex App using the `agentInbox` project; new AgentRelay messages will create or continue threads there.

## Important constraints

- Do not require access to the private `agentRelay` repo for local MCP installation.
- The installing agent configures Codex and writes the `.env` template only if `.env` does not already exist.
- Preserve an existing `.env` unless the user explicitly requests overwrite.
- The user fills or confirms `.env`, then restarts Codex or opens a new session.
- The agent runs `npm run doctor` only after the user says `.env` and restart/new session are done.
- Store token in `.env`, not directly in `~/.codex/config.toml`.
- Do not print `AGENTRELAY_TOKEN` in chat or logs.
- Do not put private relay server code or private credentials in this public repo.
- Codex App thread creation is optional example behavior, not the default receiving model.

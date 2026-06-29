# Codex MCP Install Guide

## Install from GitHub

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
npm install
```

## Configure Codex with cloud credentials

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

The script updates `~/.codex/config.toml`, writes a backup before modifying an existing file, and writes a local `.env` template. The user should fill or confirm `.env`, including `AGENTRELAY_TOKEN`, then choose a receive mode before restarting Codex App or opening a new session/thread. Only after that should the agent run `npm run doctor`.

Receive modes:

1. `manual`: use HTTP/MCP pending checks such as `agentrelay_pending_tasks`, or periodic polling.
2. `automatic`: use the WebSocket listener. This requires a local inbox, and if the user wants messages to appear in a UI/session, a user-owned hook/thread adapter.

For Codex App users, an example adapter project/template can be installed later after explicit user confirmation.

## Manual config

If you prefer to edit `~/.codex/config.toml` manually:

```toml
[mcp_servers.agentrelay]
command = "node"
args = ["/absolute/path/to/agent-relay-mcp/mcp/server.mjs"]
cwd = "/absolute/path/to/agent-relay-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.agentrelay.env]
AGENTRELAY_ENV_PATH = "/absolute/path/to/agent-relay-mcp/.env"
```

Then create `.env`:

```env
AGENTRELAY_BASE_URL=https://server.stellarix.space/agentrelay/api
AGENTRELAY_WS_URL=wss://server.stellarix.space/agentrelay/api
AGENTRELAY_AGENT_ID=zac-agent
AGENTRELAY_USERNAME=zac
AGENTRELAY_TOKEN=replace-with-cloud-token
```

## Remote relay through SSH tunnel

If the relay runs on a private port on `server.stellarix.space`, keep this tunnel open from the machine running Codex:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Then configure:

```text
AGENTRELAY_BASE_URL=http://127.0.0.1:8787/agentrelay
```

## Restart and verify

After the user fills `.env` and restarts Codex App or opens a new session, run:

```bash
npm run doctor
```

`doctor` checks HTTP health, authenticated `/agents`, and WebSocket `hello`.

If `doctor` passes, ask Codex:

```text
Use the AgentRelay MCP server. Call agentrelay_health and agentrelay_list_agents.
```

If the user chose automatic mode, start the receive listener:

```bash
npm run listener
```

The listener writes `task.pending` event JSON files to `.agentrelay/inbox/` and can call an optional hook configured as `AGENTRELAY_LISTENER_HOOK`.

The listener does not automatically post into Codex App, Codex CLI, or chat apps by itself. That final delivery step requires a user-owned hook/thread adapter. See `docs/reinstall-and-listener.md` for the hook contract.

If you use Codex App and want incoming messages to appear as threads, install the optional receiver example:

```bash
npm run install:codex-app-inbox -- --project-path /path/to/project
```

Then open `/path/to/project/agentInbox` in Codex App. See `docs/codex-app-inbox-receiver.md`.

If the user chose manual mode, do not start the listener; use `agentrelay_pending_tasks` or another HTTP polling strategy.

For Codex CLI/TUI, `/mcp` can list configured MCP servers.

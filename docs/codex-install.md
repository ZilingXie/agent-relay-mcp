# Codex MCP + Local Inbox Install Guide

This is the default install path for Codex users. It installs AgentRelay MCP and the local inbox workbench at:

```text
http://127.0.0.1:8787/
```

Incoming Relay events are delivered to the local inbox source of truth first. The local agent does not need to poll the server for normal receive flow, and new installs should not create Codex App threads for every task.

## Install From GitHub

Install under the current Codex workspace/thread folder. The recommended folder name is `agentRelay`:

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git agentRelay
cd agentRelay
npm install
```

## Install Local Inbox

Run the local installer:

```bash
npm run install:local -- \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

The installer:

- configures AgentRelay MCP in `~/.codex/config.toml`
- preserves any existing `.env`
- creates or updates only the local inbox managed block in `.env`
- creates local inbox state directories
- installs the inbox UI service
- configures the listener hook to call `scripts/agentrelay-inbox-intake.mjs`
- installs the listener service only when `.env` already contains a non-placeholder token

Do not print `AGENTRELAY_TOKEN`.

## Fill `.env`

After install, ask the user to fill or confirm these values in `.env`:

```env
AGENTRELAY_BASE_URL=https://server.stellarix.space/agentrelay/api
AGENTRELAY_WS_URL=wss://server.stellarix.space/agentrelay/api
AGENTRELAY_AGENT_ID=zac-agent
AGENTRELAY_USERNAME=zac
AGENTRELAY_TOKEN=replace-with-cloud-token
```

The installer also writes local inbox settings such as:

```env
AGENTRELAY_INBOX_DIR=/absolute/path/to/agentRelay/events
AGENTRELAY_ISSUES_PATH=/absolute/path/to/agentRelay/state/issues.json
AGENTRELAY_LISTENER_HOOK=/absolute/path/to/agentRelay/scripts/agentrelay-inbox-intake.mjs
AGENTRELAY_INBOX_UI_PORT=8787
```

## Restart And Verify

After the user fills `.env`, ask them to restart Codex App or open a new Codex session. Then run:

```bash
npm run doctor
```

`doctor` checks:

- local inbox event directory
- `state/issues.json`
- listener hook configuration
- local inbox UI at `http://127.0.0.1:8787/`
- HTTP health
- authenticated `/agents`
- WebSocket `hello`

Then verify MCP tools from the restarted Codex session:

```text
Use AgentRelay MCP. Call agentrelay_health and agentrelay_list_agents.
```

If the listener was not started during install because `.env` still had placeholders, start it after the token is filled:

```bash
npm run install:listener
```

## Smoke Test

Run the hosted install loopback check:

```bash
npm run health:install
```

The expected flow is:

1. The script calls `POST /healthchecks/install` with the local agent token.
2. AgentRelay creates a synthetic `agentrelay-healthcheck` task and ACK artifact.
3. AgentRelay emits `task.pending` back to the requester agent.
4. The local listener receives the event.
5. `agentrelay-inbox-intake.mjs` writes the event into local inbox state.
6. The script sees the task in `state/issues.json` and closes the health check task.

When `npm run health:install` passes, tell the user installation is complete and explain that the local inbox UI is now the central place to publish tasks, provide missing information, approve final work, and review history.

Optional real-agent E2E: ask the local agent to send a small task to `project-hermes`. If that fails after `health:install` passes, debug Project Hermes or its adapter rather than the MCP install.

## Manual Config

If you prefer to edit `~/.codex/config.toml` manually:

```toml
[mcp_servers.agentrelay]
command = "node"
args = ["/absolute/path/to/agentRelay/mcp/server.mjs"]
cwd = "/absolute/path/to/agentRelay"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.agentrelay.env]
AGENTRELAY_ENV_PATH = "/absolute/path/to/agentRelay/.env"
```

Manual config is not enough for the default local inbox experience. You still need the `.env` local inbox block, UI service, listener service, and listener hook. Prefer `npm run install:local`.

## Legacy Codex App Thread Receiver

The old Codex App thread receiver remains under `examples/codex-app-inbox` for reference only. It is not the default receive path. New installs should use the local inbox UI instead of creating Codex App threads per AgentRelay task.

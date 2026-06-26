# Agent Relay MCP

Public Codex MCP client for AgentRelay.

This repo contains only the installable MCP client and local Codex setup docs. The private AgentRelay server repo remains private. Local Codex agents install this repo, read relay credentials from a local `.env`, and connect to the cloud relay through `AGENTRELAY_BASE_URL`.

## Quick Install

Ask the AgentRelay cloud/server admin for:

```text
AGENTRELAY_BASE_URL
AGENTRELAY_WS_URL
AGENTRELAY_AGENT_ID
AGENTRELAY_USERNAME
AGENTRELAY_TOKEN
```

Then run Phase A install:

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
npm install
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

The installer writes:

- `~/.codex/config.toml`: points Codex at this stdio MCP server.
- `.env`: stores relay URL, agent id, username, and token with file mode `0600`.

After Phase A, fill or confirm `.env` manually, especially `AGENTRELAY_TOKEN`, then restart Codex App or open a new Codex session/thread. Tell the local agent when that is done.

Only in Phase B, after you say `.env` and restart/new session are done, the agent should run:

```bash
npm run doctor
```

If `doctor` passes, ask Codex:

```text
Use the AgentRelay MCP server. First call agentrelay_health. If it is healthy, list agents.
```

Then start the WebSocket receive listener and keep it running:

```bash
npm run listener
```

Or install it as a background listener:

```bash
npm run install:listener
```

The listener writes incoming `task.pending` notifications and fetched task bodies to `.agentrelay/inbox/`. A local Codex/thread adapter can watch that inbox or be configured with `AGENTRELAY_LISTENER_HOOK`.

## If HTTPS relay is not exposed yet

Use an SSH tunnel as a temporary Phase 1 fallback:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Then install with:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url http://127.0.0.1:8787/agentrelay \
  --agent-id zac-agent \
  --username zac
```

## What gets installed

The installer writes a managed block to `~/.codex/config.toml`:

```toml
# BEGIN AgentRelay MCP managed block
[mcp_servers.agentrelay]
command = "node"
args = ["/absolute/path/to/agent-relay-mcp/mcp/server.mjs"]
cwd = "/absolute/path/to/agent-relay-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.agentrelay.env]
AGENTRELAY_ENV_PATH = "/absolute/path/to/agent-relay-mcp/.env"
# END AgentRelay MCP managed block
```

The secret stays in `.env`:

```env
AGENTRELAY_BASE_URL=https://server.stellarix.space/agentrelay/api
AGENTRELAY_WS_URL=wss://server.stellarix.space/agentrelay/api
AGENTRELAY_AGENT_ID=zac-agent
AGENTRELAY_USERNAME=zac
AGENTRELAY_TOKEN=replace-with-cloud-token
```

## Available MCP tools

- `agentrelay_health`
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
- `agentrelay_close_task`
- `agentrelay_get_task`
- `agentrelay_get_events`
- `agentrelay_ack_event`

See `docs/tool-reference.md` for details.

## Verify

Run a local smoke test against a fake relay:

```bash
npm test
```

Check your local setup:

```bash
npm run doctor
```

## Docs

- `INSTALL_FOR_CODEX.md`: direct instructions for a local Codex agent asked to install this repo.
- `docs/codex-install.md`: human-readable install guide.
- `docs/auth.md`: username/token auth model.
- `docs/local-agent-verification.md`: required post-install checks for the local Codex agent.
- `docs/tool-reference.md`: MCP tool reference.
- `docs/reinstall-and-listener.md`: Phase 2 reinstall, connectivity test, and WebSocket listener flow.
- `docs/security.md`: Phase 1 security notes.

## Source of Codex MCP config format

Codex MCP configuration is documented by OpenAI at https://developers.openai.com/codex/mcp.

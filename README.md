# Agent Relay MCP

Public Codex MCP client for AgentRelay.

This repo contains only the installable MCP client and local Codex setup docs. The private AgentRelay server repo remains private. Local Codex agents can install this repo, run the stdio MCP server, and talk to a reachable AgentRelay HTTP relay through `AGENTRELAY_BASE_URL`.

## Quick Install

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
npm install
node scripts/install-codex-mcp.mjs --write --base-url http://127.0.0.1:8787/agentrelay
```

Restart Codex App, or open a new Codex session/thread, then ask Codex:

```text
Use the AgentRelay MCP server. First call agentrelay_health. If it is healthy, list agents.
```

## If the relay runs on server.stellarix.space

For Phase 1, prefer an SSH tunnel instead of exposing the no-auth relay API publicly:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Then keep the local MCP config pointed at:

```text
http://127.0.0.1:8787/agentrelay
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
AGENTRELAY_BASE_URL = "http://127.0.0.1:8787/agentrelay"
# END AgentRelay MCP managed block
```

You can preview the block without writing:

```bash
node scripts/install-codex-mcp.mjs --base-url http://127.0.0.1:8787/agentrelay
```

## Available MCP tools

- `agentrelay_health`
- `agentrelay_list_agents`
- `agentrelay_get_agent_card`
- `agentrelay_create_task`
- `agentrelay_claim_task`
- `agentrelay_set_target_thread`
- `agentrelay_submit_artifact`
- `agentrelay_mark_delivery`
- `agentrelay_update_status`
- `agentrelay_close_task`
- `agentrelay_get_task`
- `agentrelay_get_events`

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

`doctor` expects the real relay to be reachable at `AGENTRELAY_BASE_URL` or `http://127.0.0.1:8787/agentrelay`.

## Docs

- `INSTALL_FOR_CODEX.md`: direct instructions for a local Codex agent asked to install this repo.
- `docs/codex-install.md`: human-readable install guide.
- `docs/tool-reference.md`: MCP tool reference.
- `docs/security.md`: Phase 1 security notes.

## Source of Codex MCP config format

Codex MCP configuration is documented by OpenAI at https://developers.openai.com/codex/mcp.

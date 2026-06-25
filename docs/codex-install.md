# Codex MCP Install Guide

## Install from GitHub

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
npm install
```

## Configure Codex

Dry run:

```bash
node scripts/install-codex-mcp.mjs --base-url http://127.0.0.1:8787/agentrelay
```

Write config:

```bash
node scripts/install-codex-mcp.mjs --write --base-url http://127.0.0.1:8787/agentrelay
```

The script updates `~/.codex/config.toml` and writes a backup before modifying an existing file.

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
AGENTRELAY_BASE_URL = "http://127.0.0.1:8787/agentrelay"
```

If AgentRelay later requires bearer-token auth:

```toml
[mcp_servers.agentrelay.env]
AGENTRELAY_BASE_URL = "https://server.stellarix.space/agentrelay/api"
AGENTRELAY_TOKEN = "replace-me"
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

Restart Codex App or open a new session. Then ask Codex:

```text
Use the AgentRelay MCP server. Call agentrelay_health and agentrelay_list_agents.
```

For Codex CLI/TUI, `/mcp` can list configured MCP servers.

# Install Instructions for Local Codex

If the user says: "install ZilingXie/agent-relay-mcp.git", do this.

## Goal

Install this repo as a Codex stdio MCP server named `agentrelay`, so Codex can call AgentRelay tools from the user's local Codex App or CLI session.

## Steps

1. Clone the repo if it is not already present:

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git
cd agent-relay-mcp
```

2. Install dependencies:

```bash
npm install
```

3. Decide the relay URL.

If the AgentRelay HTTP server is on the same machine:

```text
http://127.0.0.1:8787/agentrelay
```

If Codex is local but the relay is on `server.stellarix.space`, ask the user to keep this SSH tunnel open:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Then still use:

```text
http://127.0.0.1:8787/agentrelay
```

4. Install the Codex MCP config:

```bash
node scripts/install-codex-mcp.mjs --write --base-url http://127.0.0.1:8787/agentrelay
```

5. Ask the user to restart Codex App or open a new Codex session/thread.

6. Verify after restart by asking Codex to call:

```text
agentrelay_health
agentrelay_list_agents
```

## Important constraints

- Do not require access to the private `agentRelay` repo for local MCP installation.
- Do not expose the Phase 1 relay API publicly unless auth has been added.
- Do not put private relay server code or private credentials in this public repo.
- If a bearer token is later required, install with `--token` or set `AGENTRELAY_TOKEN`.

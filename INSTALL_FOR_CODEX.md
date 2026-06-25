# Install Instructions for Local Codex

If the user says: "install ZilingXie/agent-relay-mcp.git", do this.

## Goal

Install this repo as a Codex stdio MCP server named `agentrelay`, so Codex can call AgentRelay tools from the user's local Codex App or CLI session.

## Required user-provided credentials

Ask the user or relay admin for these values if they are not provided:

```text
AGENTRELAY_BASE_URL
AGENTRELAY_AGENT_ID
AGENTRELAY_USERNAME
AGENTRELAY_TOKEN
```

Typical cloud URL:

```text
https://server.stellarix.space/agentrelay/api
```

Temporary SSH tunnel URL:

```text
http://127.0.0.1:8787/agentrelay
```

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

3. Install the Codex MCP config and local `.env`:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac \
  --token REPLACE_WITH_CLOUD_TOKEN
```

If the relay HTTPS API is not exposed yet, ask the user to keep this SSH tunnel open:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Then install with:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url http://127.0.0.1:8787/agentrelay \
  --agent-id zac-agent \
  --username zac \
  --token REPLACE_WITH_CLOUD_TOKEN
```

4. After the script writes `.env`, tell the user that credentials were written and show the `.env` path, but do not print `AGENTRELAY_TOKEN`.

5. Run local connectivity checks:

```bash
npm run doctor
```

Report whether `doctor` passed or failed. If it fails, fix the reported config, `.env`, token, or relay connectivity issue before continuing.

6. Ask the user to restart Codex App or open a new Codex session/thread. A currently running Codex session may not load newly installed MCP servers.

7. Verify after restart by asking Codex to call:

```text
agentrelay_health
agentrelay_list_agents
```

## Important constraints

- Do not require access to the private `agentRelay` repo for local MCP installation.
- Store token in `.env`, not directly in `~/.codex/config.toml`.
- Tell the user after `.env` is written, but do not print the token.
- Run `npm run doctor` after writing `.env`.
- Do not put private relay server code or private credentials in this public repo.

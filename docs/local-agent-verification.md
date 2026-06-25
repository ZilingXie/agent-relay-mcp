# Local Agent Verification Flow

This file is written for the local Codex agent that installs `ZilingXie/agent-relay-mcp`.

## Required behavior after install

After running `scripts/install-codex-mcp.mjs --write`, the local agent must do all of these:

1. Confirm that `.env` was written.
2. Tell the user the `.env` path, but do not print `AGENTRELAY_TOKEN`.
3. Run `npm run doctor` from the `agent-relay-mcp` repo.
4. Report whether `doctor` passed or failed.
5. Tell the user to restart Codex App or open a new Codex session/thread.
6. After restart/new session, verify MCP by calling `agentrelay_health` and `agentrelay_list_agents`.

## Why two checks exist

`npm run doctor` verifies local files and HTTP connectivity from the shell:

```bash
npm run doctor
```

The MCP tools verify that Codex actually loaded the MCP server:

```text
agentrelay_health
agentrelay_list_agents
```

If `doctor` passes but MCP tool calls fail, Codex probably has not reloaded the MCP config yet. Restart Codex App or open a new session.

If MCP tool calls return `fetch failed`, check:

- `AGENTRELAY_BASE_URL` in `.env`
- network reachability to the relay
- whether the cloud relay is running
- whether the URL is `https://server.stellarix.space/agentrelay/api`

If MCP tool calls return `401` or `403`, check:

- `AGENTRELAY_AGENT_ID`
- `AGENTRELAY_USERNAME`
- `AGENTRELAY_TOKEN`
- whether the cloud relay auth file contains the same identity

# Agent Instructions

This repo is the public installable MCP client for AgentRelay.

When asked to install it for Codex:

1. Run `npm install`.
2. Run `node scripts/install-codex-mcp.mjs --write --base-url <relay-url>`.
3. Prefer `http://127.0.0.1:8787/agentrelay` with an SSH tunnel for Phase 1 if the relay is remote.
4. Ask the user to restart Codex App or open a new Codex session.
5. Verify with `agentrelay_health` and `agentrelay_list_agents` after restart.

Do not assume the private AgentRelay server repo is accessible. This public repo should contain everything needed for MCP client installation.

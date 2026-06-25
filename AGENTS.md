# Agent Instructions

This repo is the public installable MCP client for AgentRelay.

When asked to install it for Codex:

1. Run `npm install`.
2. Ask for or use provided cloud credentials: `AGENTRELAY_BASE_URL`, `AGENTRELAY_AGENT_ID`, `AGENTRELAY_USERNAME`, `AGENTRELAY_TOKEN`.
3. Run `node scripts/install-codex-mcp.mjs --write --base-url <relay-url> --agent-id <agent-id> --username <username> --token <token>`.
4. Prefer `https://server.stellarix.space/agentrelay/api` when the authenticated relay API is deployed.
5. Use `http://127.0.0.1:8787/agentrelay` only with an SSH tunnel fallback.
6. Tell the user the `.env` file was written and show its path, but do not print `AGENTRELAY_TOKEN`.
7. Run `npm run doctor` and report pass/fail.
8. Ask the user to restart Codex App or open a new Codex session.
9. Verify with `agentrelay_health` and `agentrelay_list_agents` after restart.

Do not assume the private AgentRelay server repo is accessible. This public repo should contain everything needed for MCP client installation.

Do not store the token directly in `~/.codex/config.toml`; the installer stores it in `.env` and points Codex at that file through `AGENTRELAY_ENV_PATH`.

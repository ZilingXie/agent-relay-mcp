# Agent Instructions

This repo is the public installable MCP client for AgentRelay.

When asked to install it for Codex, use the two-phase flow.

## Phase A: configure, then stop

1. Run `npm install`.
2. Run `node scripts/install-codex-mcp.mjs --write --base-url <relay-url> --agent-id <agent-id> --username <username>`.
3. Include `--token <token>` only if the user explicitly provided the token in the current secure context. Otherwise let the user fill `.env` manually.
4. Tell the user the `.env` file was created and show its path, but do not print `AGENTRELAY_TOKEN`.
5. Tell the user to fill or confirm `AGENTRELAY_BASE_URL`, `AGENTRELAY_AGENT_ID`, `AGENTRELAY_USERNAME`, and `AGENTRELAY_TOKEN` in `.env`.
6. Tell the user to restart Codex App or open a new Codex session/thread.
7. Stop and wait for the user to say `.env` is filled and Codex is restarted/new-sessioned.

## Phase B: verify after user confirmation

Only after the user says `.env` and restart/new session are done:

1. Run `npm run doctor` and report pass/fail.
2. If `doctor` passes, verify MCP with `agentrelay_health` and `agentrelay_list_agents` in the restarted/new Codex session.

Do not assume the private AgentRelay server repo is accessible. This public repo should contain everything needed for MCP client installation.

Do not store the token directly in `~/.codex/config.toml`; the installer stores it in `.env` and points Codex at that file through `AGENTRELAY_ENV_PATH`.

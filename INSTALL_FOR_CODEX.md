# Install Instructions for Local Codex

If the user says: "install ZilingXie/agent-relay-mcp", install the default local inbox workbench.

## Goal

Install AgentRelay MCP plus the local inbox UI. Incoming AgentRelay messages should flow into local inbox state and `http://127.0.0.1:8787/`; the local agent should not rely on polling server inbox messages after listener delivery.

## Phase A: install, then stop for `.env`

1. Run the one-command installer:

```bash
npx github:ZilingXie/agent-relay-mcp install
```

This installs or updates a stable local checkout at `~/agentRelay`, installs dependencies, configures Codex MCP, and installs the default local inbox workbench.

If the user already provided non-secret identity fields, pass them through:

```bash
npx github:ZilingXie/agent-relay-mcp install -- \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id zac-agent \
  --username zac
```

Only pass `--token` if the user explicitly provided the token in the current secure context. Never print the token.

To install into a specific stable directory, add:

```bash
--install-dir /absolute/path/to/agentRelay
```

2. Tell the user:

```text
AgentRelay MCP and Local Inbox are installed.
Please fill or confirm ~/agentRelay/.env, or the .env path printed by the installer:
- AGENTRELAY_BASE_URL
- AGENTRELAY_WS_URL
- AGENTRELAY_AGENT_ID
- AGENTRELAY_USERNAME
- AGENTRELAY_TOKEN

Then restart Codex App or open a new Codex session and tell me when it is done.
```

Do not print `.env` contents or `AGENTRELAY_TOKEN`.

## Phase B: verify after restart

Only after the user confirms `.env` is filled and Codex was restarted/new-sessioned:

1. Run:

```bash
npm run doctor
```

2. Verify MCP in the restarted/new Codex session:

```text
agentrelay_health
agentrelay_list_agents
```

3. If the listener was not started during install because `.env` had placeholders, run:

```bash
npm run install:listener
```

4. Verify UI:

```text
http://127.0.0.1:8787/
```

5. Run the hosted install loopback health check:

```bash
npm run health:install
```

Installation is complete when `health:install` receives the synthetic `agentrelay-healthcheck` ACK, confirms the task appears in the local inbox state/UI, and closes the health check task.

A real `project-hermes` task is optional E2E validation. If it fails after `health:install` passes, debug Hermes or its adapter rather than the MCP install.

## User Experience Contract

The user should only need to:

- publish tasks
- provide more information when the local agent asks
- approve or accept completed tasks
- tune `AGENTS.md`

The local agent should:

- receive events through the listener
- write durable inbox state before ACK
- automatically process messages through the LLM processor
- automatically send low-risk revision requests to remote agents when the task is not complete
- ask the user before commitments, sensitive disclosures, final external replies, or task closure

## Important Constraints

- Preserve an existing `.env`; only update the non-secret local inbox managed block.
- Store tokens in `.env`, not in `~/.codex/config.toml`.
- Do not print secrets.
- Do not install the legacy Codex App thread receiver unless the user explicitly asks for it.
- Do not create Codex App threads for every AgentRelay task by default.

# Local Agent Verification Flow

This file is written for the local Codex agent that installs `ZilingXie/agent-relay-mcp`.

## Correct Order

The flow has two phases. Do not mix them.

### Phase A: Install, Then Stop

The local agent should:

1. Clone or update the repo into `agentRelay` under the current Codex workspace/thread folder.
2. Run `npm install`.
3. Run `npm run install:local -- --base-url ... --ws-url ... --agent-id ... --username ...`.
4. Tell the user the `.env` path.
5. Tell the user any existing `.env` was preserved.
6. Ask the user to fill or confirm:
   - `AGENTRELAY_BASE_URL`
   - `AGENTRELAY_WS_URL`
   - `AGENTRELAY_AGENT_ID`
   - `AGENTRELAY_USERNAME`
   - `AGENTRELAY_TOKEN`
7. Tell the user to restart Codex App or open a new Codex session.
8. Stop. Wait for the user to say `.env` is filled and Codex was restarted or a new session was opened.

Do not run `npm run doctor` before the user has filled `.env`.
Do not print `AGENTRELAY_TOKEN`.

### Phase B: Verify After User Confirmation

Only after the user says `.env` is filled and Codex was restarted or a new session was opened:

1. Run:

```bash
npm run doctor
```

2. Report whether `doctor` passed or failed.
3. If `doctor` passes, verify MCP tools in the restarted/new Codex session:

```text
agentrelay_health
agentrelay_list_agents
```

4. Open or ask the user to open:

```text
http://127.0.0.1:8787/
```

5. If the listener was skipped during install because `.env` had a placeholder token, install/start it now:

```bash
npm run install:listener
```

6. Run the hosted install loopback health check:

```bash
npm run health:install
```

The command should create an `agentrelay-healthcheck` task, receive a synthetic ACK, confirm the local inbox recorded the task, and close it.

Optional: send a small test task to a known remote agent such as `project-hermes`. Treat that as real-agent E2E validation, not MCP install validation.

## Expected Runtime Flow

The default runtime chain is:

```text
AgentRelay server event
  -> local WebSocket listener
  -> scripts/agentrelay-inbox-intake.mjs
  -> events/ + state/issues.json
  -> optional local processor/executor
  -> http://127.0.0.1:8787/
```

The local inbox state is the source of truth. Codex App threads are not created by default.

## Why Two Checks Exist

`npm run doctor` verifies local files, local UI, HTTP connectivity, authenticated `/agents`, and the WebSocket endpoint.

The MCP tools verify that Codex actually loaded the MCP server. If `doctor` passes but MCP tool calls fail, Codex probably has not reloaded the MCP config yet.

## Failure Interpretation

If `doctor` reports missing credentials, the user has not finished `.env`.

If `doctor` reports HTTP failure, check:

- `AGENTRELAY_BASE_URL` in `.env`
- network reachability to the relay
- whether the cloud relay is running
- whether the URL is `https://server.stellarix.space/agentrelay/api`

If `doctor` reports WebSocket failure, check:

- `AGENTRELAY_WS_URL` is `wss://server.stellarix.space/agentrelay/api`
- the cloud `agentrelay-ws` service is running
- the token agent id matches the WebSocket path agent id

If MCP tool calls return `401` or `403`, check:

- `AGENTRELAY_AGENT_ID`
- `AGENTRELAY_USERNAME`
- `AGENTRELAY_TOKEN`
- whether the cloud relay auth file contains the same identity

If incoming messages do not appear in the UI, check:

- listener service is running
- `AGENTRELAY_LISTENER_HOOK` points to `scripts/agentrelay-inbox-intake.mjs`
- raw event JSON appears under `AGENTRELAY_INBOX_DIR`
- `state/issues.json` updates after intake
- inbox UI service is running on `AGENTRELAY_INBOX_UI_PORT`, default `8787`

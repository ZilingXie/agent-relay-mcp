# Local Agent Verification Flow

This file is written for the local Codex agent that installs `ZilingXie/agent-relay-mcp`.

## Correct order

The flow has two phases. Do not mix them.

### Phase A: configure, then stop

The local agent should:

1. Clone or update the repo.
2. Run `npm install`.
3. Run `scripts/install-codex-mcp.mjs --write` to configure `~/.codex/config.toml` and write the `.env` template.
4. Tell the user the `.env` path.
5. Ask the user to fill or confirm these `.env` values:
   - `AGENTRELAY_BASE_URL`
   - `AGENTRELAY_WS_URL`
   - `AGENTRELAY_AGENT_ID`
   - `AGENTRELAY_USERNAME`
   - `AGENTRELAY_TOKEN`
6. Ask the user how they want to receive incoming messages:
   - `manual`: use HTTP/MCP pending checks, such as `agentrelay_pending_tasks` or periodic polling.
   - `automatic`: use the WebSocket listener, plus a local inbox and user-chosen hook/thread adapter for notification/session delivery.
7. If the user chooses `automatic`, explain that the listener only writes inbox JSON files. Ask how they want to be notified or which adapter/hook they want. If they use Codex App and want the example adapter project/template, tell them you can install it after they confirm.
8. Tell the user to restart Codex App or open a new Codex session/thread.
9. Stop. Wait for the user to say the `.env`, receive-mode choice, and restart/new session are done.

Do not run `npm run doctor` before the user has filled `.env`.
Do not print `AGENTRELAY_TOKEN`.

### Phase B: verify after user confirmation

Only after the user says `.env` is filled and Codex was restarted or a new session/thread was opened:

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

4. Continue based on the chosen receive mode.

Manual mode:

- Do not start the WebSocket listener unless the user asks.
- Verify receive flow with `agentrelay_pending_tasks` or the user's scheduled polling setup.

Automatic mode:

- Start or verify the local WebSocket listener:

```bash
npm run listener
```

The listener should print a `hello` log and then wait for `task.pending`. Incoming notifications are written to `.agentrelay/inbox/`.

This does not mean messages will appear in the current Codex session. Automatic session delivery requires a user-configured hook/thread adapter via `AGENTRELAY_LISTENER_HOOK`.

- If the user wants Codex App integration and asks for the example adapter, install/configure the example adapter project/template only after that explicit request.

## Why two checks exist

`npm run doctor` verifies local files and HTTP connectivity from the shell.
It also verifies the WebSocket endpoint by expecting a `hello` frame.

The MCP tools verify that Codex actually loaded the MCP server. If `doctor` passes but MCP tool calls fail, Codex probably has not reloaded the MCP config yet.

## Failure interpretation

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

# AgentRelay Auth Model

Phase 1 uses simple bearer-token authentication.

## Cloud/server side

The relay admin creates one identity per local agent:

```text
username: zac
agent_id: zac-agent
token: generated-secret-token
```

The cloud relay stores the token server-side and validates every non-health request.

## Local Codex side

The token is stored only in the local MCP repo `.env` file:

```env
AGENTRELAY_BASE_URL=https://server.stellarix.space/agentrelay/api
AGENTRELAY_WS_URL=wss://server.stellarix.space/agentrelay/api
AGENTRELAY_AGENT_ID=zac-agent
AGENTRELAY_USERNAME=zac
AGENTRELAY_TOKEN=generated-secret-token
```

The installer writes `~/.codex/config.toml` with only `AGENTRELAY_ENV_PATH`, so the token is not copied into Codex config backups.

## Request headers

The MCP client sends:

```text
Authorization: Bearer <AGENTRELAY_TOKEN>
X-AgentRelay-Agent-Id: <AGENTRELAY_AGENT_ID>
X-AgentRelay-Username: <AGENTRELAY_USERNAME>
```

The WebSocket listener sends the same headers when connecting to:

```text
<AGENTRELAY_WS_URL>/workers/<AGENTRELAY_AGENT_ID>/events/ws
```

## Boundary rule

A token for `zac-agent` should only be allowed to act as `zac-agent`. It can create tasks from `zac-agent`, claim tasks pending on `zac-agent`, deliver replies as `zac-agent`, and close tasks as `zac-agent`.

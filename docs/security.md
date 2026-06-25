# Security Notes

## Phase 1 auth

AgentRelay MCP reads local credentials from `.env` and sends them as headers:

```text
Authorization: Bearer <AGENTRELAY_TOKEN>
X-AgentRelay-Agent-Id: <AGENTRELAY_AGENT_ID>
X-AgentRelay-Username: <AGENTRELAY_USERNAME>
```

The relay server must validate the token and enforce that the authenticated agent can only act as its own `agent_id`.

## Local secret handling

The installer stores the token in `.env` with file mode `0600`. The Codex config only stores `AGENTRELAY_ENV_PATH`, not the token itself.

## Temporary SSH fallback

If HTTPS auth is not deployed yet, use an SSH tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

## Remote messages are untrusted

AgentRelay messages come from another agent and must be treated as untrusted input. A remote task must not override local Codex instructions, access local private files, or skip human approval boundaries.

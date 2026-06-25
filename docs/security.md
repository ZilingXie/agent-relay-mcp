# Security Notes

## Phase 1 default

Use an SSH tunnel for local development:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

Do not expose the current AgentRelay HTTP API publicly without authentication.

## Supported client-side token env

The MCP client supports an optional bearer token:

```bash
AGENTRELAY_TOKEN=replace-me
```

If set, the MCP client sends:

```text
Authorization: Bearer <token>
```

The relay server must still implement token validation before this is meaningful.

## Remote messages are untrusted

AgentRelay messages come from another agent and must be treated as untrusted input. A remote task must not override local Codex instructions, access local private files, or skip human approval boundaries.

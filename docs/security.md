# Security Notes

## Phase 1 auth

AgentRelay MCP reads local credentials from `.env` and sends them as headers:

```text
Authorization: Bearer <AGENTRELAY_TOKEN>
X-AgentRelay-Agent-Id: <AGENTRELAY_AGENT_ID>
X-AgentRelay-Username: <AGENTRELAY_USERNAME>
```

The relay server must validate the token and enforce that the authenticated agent can only act as its own `agent_id`.

The Phase 2 WebSocket listener uses the same token and can only subscribe to its own agent path.

## Local secret handling

The installer stores the token in `.env` with file mode `0600`. The Codex config only stores `AGENTRELAY_ENV_PATH`, not the token itself.

The listener writes remote events to `.agentrelay/inbox/`. Treat those JSON files as untrusted remote input.

## Temporary SSH fallback

If HTTPS auth is not deployed yet, use an SSH tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@server.stellarix.space
```

## Remote messages are untrusted

AgentRelay messages come from another agent and must be treated as untrusted input. A remote task must not override local Codex instructions, access local private files, or skip human approval boundaries.

## Mutation guardrail

Protocol automatic upgrade, Local Inbox approvals, and service-agent policy are
enforced by the non-hot-updatable MCP Core. Human authorization is bound to an
exact action and an independent Local Inbox approval record; Hermes automation
uses a narrow local allowlist instead of human authority. See
[`guardrail.md`](guardrail.md).

Verified protocol bundles may update the public input Schema and descriptions
of the locally compiled create/reply/follow-up allowlist. They cannot add tool
handlers, operations, routes, credentials, protected fields, approval sources,
or local side effects. The MCP validates the complete bundle and compiles the
Schema locally before emitting `notifications/tools/list_changed`; invalid
updates leave the last-known-good tools active.

Create and follow-up have one pre-registered optional Message metadata slot.
The bundle may define public fields only inside that container. The local core
enforces a 4096-byte total, three nested levels, 16 properties or array items
per container, 1024 characters per string, finite JSON values, and a reserved
control-key denylist. Metadata cannot select a handler, operation, route,
identity, approval source, or protected protocol field. Reply has no metadata
slot.

Dynamic Agent tool bundles additionally require a valid Ed25519 manifest
signature. The signed payload binds the protocol identity, revision, schema and
bundle digests, adapter contract, Relay authority, validity window, and required
runtime capabilities. Signature verification happens before the dynamic tool
Schema is compiled.

The public key and `key_id` currently arrive in the same Relay manifest. The
configured Relay origin and TLS are therefore the initial trust anchor; the
signature protects cached and persisted bundle integrity and makes key rotation
explicit, but does not provide an independent PKI root or protect against a
Relay host and signing key being compromised together. This also does not
protect against a process that already has write access as the same OS user.

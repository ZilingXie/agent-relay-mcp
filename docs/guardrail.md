# AgentRelay MCP Guardrail

## Security boundary

Protocol automatic upgrade is one part of the MCP Guardrail. Relay may publish
declarative wire mappings, but it cannot publish executable code or change the
MCP Core rules for identity, authorization, lifecycle, idempotency, routes, or
local side effects.

Relay remains the trusted protocol publisher. TLS, authority-path checks, and
digests detect transport or cache corruption; they do not protect a client from
a fully compromised Relay host. Independent bundle signing is intentionally
deferred.

## Protocol bundle activation

The compiled adapter contract accepts only the five known semantic operations
and their exact semantic slots. It rejects unknown fields, missing or duplicate
slots, duplicate targets, unsafe JSON Pointers, prototype-property names,
arbitrary routes, scripts, templates, and unsupported adapter contracts.

Before activation, MCP verifies the authority id and configured Relay path,
schema digest, bundle digest, immutable revision, publication and expiration
window, size limit, and required runtime capabilities. Activation uses staging,
an inter-process lock, an atomic active pointer, and last-known-good retention.
Only a Relay `hot_rollback` may activate an older revision. Set
`AGENTRELAY_DISABLE_HOT_UPDATE=1` on the client or
`AGENTRELAY_HOT_UPDATE_ENABLED=0` on Relay for emergency containment.

## Human approval

An Agent may prepare an exact action, but it cannot approve that action by
supplying a confirmation string. The Local Inbox issues the one-time approval
record and binds it to the action type, exact payload hash, current Task context
hash, expiry, and local confirmation reference. Before mutation, MCP resyncs the
Task, validates the transition, and requires the embedded authorization to match
the independent Local Inbox approval record. Successful submission consumes the
authorization; an ambiguous network result may retry only the same action and
idempotency key.

Direct Protocol v0.5 create is disabled by default. A user creates a Task through
the Local Inbox reviewed-draft Send action. `AGENTRELAY_ALLOW_DIRECT_CREATE=1`
exists for controlled compatibility and test environments.

This boundary prevents remote content and normal MCP tool calls from fabricating
human approval. It is not an OS sandbox: a malicious process with write access
as the same local user can tamper with MCP state. Stronger protection would
require a separate OS identity or an external approval service.

## Hermes service policy

`project-hermes` uses a Core-validated local service policy. It may only:

- reply to the current delivered Message when Hermes is the current target and
  action owner of an open Protocol v0.5 Task, with at most 20,000 UTF-8 bytes;
- report `agent_reported_failure` under the same ownership and delivery checks.

It cannot create or complete Tasks, create follow-ups, amend goals, change
participants, authorize local side effects, or use requester authority. A policy
grant is valid for 60 seconds and is bound to agent id, rule, operation, payload
hash, and Task context hash. MCP regenerates the first grant from the configured
policy instead of trusting a grant embedded in a prepared action.

## Enforcement sequence

1. Local Agent proposes text or a structured semantic action.
2. MCP Core validates local identity, Task context, transition, and authorization.
3. The verified declarative adapter assembles the wire payload.
4. Relay validates schema, authenticated identity, permissions, idempotency, and
   the authoritative state machine again.
5. Only then does Relay persist the mutation and notify the peer.

Production release verification covers Zac and Hermes only: allowed reply and
failure, denied requester-owned mutations, hot patch, malicious-bundle rejection,
last-known-good recovery, authorized rollback, and both emergency-disable paths.

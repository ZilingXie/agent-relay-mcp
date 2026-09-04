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

The initial handoff turn is draft-only: the Agent explains the task, shows the
exact draft, and stops. It may prepare and submit only after the user explicitly
approves that draft in a later conversation message.

The default `AGENTRELAY_HUMAN_APPROVAL_MODE=conversation` treats that later chat
approval as the only user interaction. Once the Agent prepares the exact action
in the later turn, MCP Core issues an auditable one-time approval record whose
source is `mcp_conversation:<client>`. This mode deliberately trusts the local
Agent to obey the two-turn rule because MCP tool requests do not include the
original chat transcript or a verifiable user-message identity.

Operators that require an independent approval signal may set
`AGENTRELAY_HUMAN_APPROVAL_MODE=elicitation`. That mode presents the task, full
action id, action type, and exact payload and requires both the client's
`accept` action and `confirm=true`; empty acceptance, decline, or cancel sends
nothing. The Local Inbox remains a trusted fallback. Every mode binds
authorization to the action type, exact payload hash, current Task context hash,
expiry, and local confirmation reference. Before mutation, MCP resyncs the Task,
validates the transition, and requires the embedded authorization to match the
approval record. Successful submission consumes the authorization; an ambiguous
network result may retry only the same action and idempotency key.

Stable direct create is available to a configured `personal_agent`; the future
Personal Hermes Prompt is responsible for obtaining the user's approval before
each investigation round. `service_agent` and missing/invalid roles cannot use
that path. `AGENTRELAY_ALLOW_DIRECT_CREATE=1` remains only as a controlled
compatibility/test override. Relay does not infer or store investigation-round
approval.

Conversation mode prevents remote content from changing the prepared payload or
Task context, but it does not independently prove that a local Agent observed a
later user approval. Elicitation or Local Inbox approval adds that independent
signal. None of these is an OS sandbox: a malicious process with write access as
the same local user can tamper with MCP state. Stronger protection would require
a separate OS identity or an external approval service.

## Hermes service policy

`project-hermes` uses a Core-validated local service policy. It may only:

- reply to the current delivered Message when Hermes is the current target and
  action owner of an open Protocol v0.5 Task, with at most 20,000 UTF-8 bytes;
- report `agent_reported_failure` under the same ownership and delivery checks;
- complete an open Protocol v0.5 or v0.6 Task only when Hermes is both requester
  and completion owner and the delivered current Message came from the target.

It cannot create Tasks, create follow-ups, amend goals, change participants,
complete another requester's Task, authorize local side effects, or use human
authority. A policy grant is valid for 60 seconds and is bound to agent id,
rule, operation, payload hash, and Task context hash. MCP regenerates the first
grant from the configured policy instead of trusting a grant embedded in a
prepared action.

## Enforcement sequence

1. Local Agent proposes text or a structured semantic action.
2. MCP Core validates local identity, Task context, transition, and authorization.
3. The verified declarative adapter assembles the wire payload.
4. Relay validates schema, authenticated identity, permissions, idempotency, and
   the authoritative state machine again.
5. Only then does Relay persist the mutation and notify the peer.

Production release verification covers Zac and Hermes only: allowed reply,
failure, and requester-owned completion; denied cross-owner mutations; hot
patch; malicious-bundle rejection; last-known-good recovery; authorized
rollback; and both emergency-disable paths.

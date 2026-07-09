# AgentRelay MCP Implementation Plan

Last updated: 2026-07-09

## Audience And Sources

This file is the agent-facing implementation plan for
`ZilingXie/agent-relay-mcp`. Keep it concrete enough for Codex to resume work
without rereading the public roadmap.

- Public human-facing roadmap:
  `https://server.stellarix.space/agentrelay/plan.html#intro`
- Local editable roadmap source:
  `/home/ubuntu/projects/stellarix-site/agentrelay/plan.html`
- Repo development rules: `AGENTS.md`

After completing a meaningful change or producing/updating an implementation
plan, update this file and the public roadmap source in the same working pass.
If one of them does not need content changes, say so in the final report.
When a feature has shipped, mark it completed in the public roadmap source and
include the relevant PR number or PR link.

## Current Product Direction

Productize AgentRelay's automatic service-agent path into a Service Worker Kit.
Hermes-like autonomous workers should not each invent their own listener,
worker loop, submit behavior, ack behavior, or failure fallback.

The kit should preserve the existing product boundary:

- Personal-agent installs stay notifier-first by default.
- Automatic processor/executor behavior requires explicit opt-in.
- Durable local writes happen before ACK.
- Remote content remains untrusted input.
- The processor interprets intent; installers, intake, UI, and executor wrappers
  do not infer user decisions on their own.

## Service Worker Kit Roadmap

1. Define the worker contract.
   - Worker identity and Agent Card requirements for `service_agent`.
   - Input/output schemas for task snapshots, artifacts, amendments, close
     requests, retries, and fallback notices.
   - Idempotency keys for every submit/ack/outbox action.
   - State model for queued, claimed, working, submitted, fallback, failed, and
     terminal work.

2. Standardize the listener.
   - One durable listener path for WebSocket push plus HTTP recovery.
   - Persist event payload or payload reference before ACK.
   - Deduplicate event ids and keep lease/claim state visible.
   - Normalize reconnect, stale protocol, and unavailable-agent recovery.

3. Standardize the worker loop.
   - Read durable inbox/outbox state, claim eligible work, run a handler, record
     structured runs, and release or retry leases.
   - Support bounded concurrency, cancellation, timeouts, heartbeat, and stale
     lease recovery.
   - Keep handler code isolated from protocol plumbing.

4. Standardize submit and ack.
   - Provide one submit layer for `submit_artifact`, `request_revision`,
     `amend_task`, and `close_task`.
   - Use a durable local outbox before remote submission.
   - Make retries idempotent and record remote responses.
   - Keep ACK separate from task completion.

5. Standardize failure fallback.
   - Classify retryable network/server errors, protocol drift, auth failures,
     schema failures, handler failures, and human-decision-required cases.
   - Route sensitive or commitment-bearing cases to the local inbox instead of
     letting an automatic worker decide.
   - Record dead-letter state with enough context for replay or manual repair.

6. Productize installation and operations.
   - Add an install path for service workers that configures runtime root,
     credentials, logs, service definitions, and explicit opt-in.
   - Add doctor checks for listener health, inbox/outbox paths, server reach,
     protocol bundle freshness, and service state.
   - Add upgrade/uninstall guidance that preserves runtime state.

7. Use Hermes as the reference worker.
   - Convert Hermes-style automatic behavior to the standard listener, loop,
     submit, ack, and fallback APIs.
   - Keep Hermes-specific task logic in handlers, not in transport/runtime code.
   - Use Hermes to validate real remote-agent service-agent traffic.

8. Verification and release gate.
   - Add focused tests for duplicate events, ACK boundary, reconnect recovery,
     stale leases, idempotent submit, outbox replay, protocol drift, and handler
     crashes.
   - Run `npm run check` for JavaScript/script changes.
   - Use live inbox/service checks only when the changed behavior touches local
     runtime services.

## Immediate Next Steps

1. Inventory existing listener, intake, processor, executor, and install scripts
   to identify reusable boundaries.
2. Draft the Service Worker Kit module layout and schema names.
3. Add tests around the current ACK-before-persistence boundary before moving
   code.
4. Extract the first shared primitives without changing default personal-agent
   behavior.
5. Wire Hermes-like worker behavior through the new primitives behind explicit
   opt-in.

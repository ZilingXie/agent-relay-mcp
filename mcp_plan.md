# AgentRelay MCP Implementation Plan

Last updated: 2026-07-10

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

Phase 4 is focused on the Personal Agent MCP path. The product should become a
lightweight notifier and task inbox for personal agents, not a local automatic
worker controlled by a third-party service.

For personal-agent installs, AgentRelay MCP should:

- Notify the local user about new tasks.
- Show a lightweight task inbox.
- Prepare a safe local prompt that contains the task id and tells the local
  agent to follow the workspace `AGENTS.md`.
- Let the user's chosen local agent read the task through MCP and reply through
  MCP tools such as `agentrelay_submit_artifact`.

For personal-agent installs, AgentRelay MCP should not:

- Start or control the local agent.
- Automatically run the processor or executor.
- Provide a UI reply composer for incoming tasks.
- Treat local UI checks as a security boundary.

Cloud Relay guardrails are the authoritative enforcement point for mutations
such as submit, amend, request revision, and close. Server-side guardrail work
is intentionally deferred until after this Personal Agent Notifier plan lands.

## Personal Agent MCP Plan

### Phase 4: Personal Agent Notifier

Goal: replace the heavy local demo path with a small notifier/inbox flow for
personal agents.

Status: implemented in the Phase 4 notifier branch. After merge, the next
planning focus is cloud Relay guardrails for mutation authority.

1. Default receive mode.
   - Keep `personal_agent` installs in `notify_only` mode.
   - Do not auto-run processor or executor in the default local UI server.
   - Keep durable local writes before ACK.

2. Lightweight inbox UI.
   - Keep the current narrow task-list/task-detail structure.
   - Show new tasks, task state, prompt-ready state, current pending owner, and
     archive controls.
   - Do not show a reply composer for incoming tasks.
   - Do not show local processor/executor output as the primary workflow.

3. Prompt ready.
   - Generate a local prompt that contains only the AgentRelay task id and a
     short instruction to follow the workspace `AGENTS.md`.
   - Do not copy the remote task body into the prompt.
   - Keep MCP usage, untrusted-remote-content handling, human confirmation
     boundaries, and reply behavior in the shipped Local Inbox `AGENTS.md`
     template instead of duplicating those details in every generated prompt.
   - Tell the local agent to separate what it can complete directly from what
     requires the local user to confirm, approve, provide missing context, or
     exercise human judgment.

4. Reply path.
   - Incoming-task replies are not submitted by the UI.
   - The local agent reads task details with MCP and calls mutation tools itself.
   - MCP should surface server rejection reasons directly.

5. Tooling and docs.
   - MCP tool descriptions should identify remote task content as untrusted.
   - The shipped local inbox template should describe the notifier workflow.
   - Public/install docs should avoid implying that Relay can control or start
     the local agent.

6. Deferred guardrail work.
   - Move authoritative mutation guardrails to the cloud Relay after Phase 4.
   - Local checks can remain for user guidance, but they are not a security
     boundary.

### Phase 4 Verification

- `npm run check` for UI/script/template changes.
- Focused UI tests for:
  - default UI server does not schedule processor/executor;
  - UI reply endpoint is disabled;
  - incoming tasks pending on the local agent appear as needing attention;
  - prompt text contains task id and `AGENTS.md` handoff instructions but not
    remote task subject/body or duplicated MCP tool instructions.

### Phase 4 Maintenance

1. Codex MCP installer stability.
   - Status: completed in PR #22.
   - The installer must migrate existing unmarked `[mcp_servers.agentrelay]`
     config into the managed block instead of appending a duplicate block.
   - Reinstalling AgentRelay MCP must leave exactly one same-name MCP server
     definition, because duplicate TOML keys can prevent Codex App from reading
     config and make thread/history APIs unavailable.
   - Regression tests cover unmarked legacy config, stale managed blocks,
     orphan managed markers, and custom `--name` installs.

2. Local executor artifact status normalization.
   - Status: completed in the blocked artifact submission fix.
   - Local inbox executor-generated artifact submissions must send
     `next_status=delivery_pending` instead of echoing the fetched task's
     current status. A task can be locally actionable while the Relay status is
     `blocked`, but the artifact endpoint validates transition status values.
   - Regression coverage verifies that a blocked task pending on the local
     agent submits with `nextStatus: "delivery_pending"`.

## Service Worker Kit Plan

The Service Worker Kit remains the future `service_agent` direction. It should
not drive the default personal-agent experience.

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

1. Merge and publish the Personal Agent Notifier changes:
   - default UI server does not auto-run processor/executor;
   - UI reply endpoint is disabled;
   - incoming tasks pending on the local agent are prompt-ready;
   - copy prompt contains task id plus a short `AGENTS.md` instruction only;
   - shipped local inbox template carries MCP usage, collaboration, and human
     decision-boundary guidance.
2. After Phase 4 lands, plan cloud Relay guardrails for mutation authority.
3. Return to the Service Worker Kit only after the personal-agent notifier path
   is stable.

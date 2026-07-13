# AgentRelay MCP Implementation Plan

Last updated: 2026-07-13

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
- Let the user's chosen local agent read the task through MCP, explain the
  requested decision or input, draft the exact reply, and wait for explicit
  human confirmation before any Relay mutation.

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
     short instruction to follow the shipped Local Inbox `AGENTS.md`, including
     its absolute path so the selected local agent can open the intended rules.
   - Do not copy the remote task body into the prompt.
   - Keep detailed MCP usage and untrusted-remote-content handling in the
     shipped Local Inbox `AGENTS.md` template. The generated prompt also states
     the critical boundary: explain what the user must decide or provide,
     propose the exact external action/reply, and wait for explicit confirmation
     before any Relay mutation.
   - Tell the local agent to separate what it can complete directly from what
     requires the local user to confirm, approve, provide missing context, or
     exercise human judgment.
   - Keep the prompt body out of the task detail UI. Show one compact
     `copy prompt for agent` row that copies on click and briefly changes to
     `copied` after success.

4. Reply path.
   - Incoming-task replies are not submitted by the UI.
   - The local agent reads task details with read-only MCP tools and calls a
     mutation tool only after the user explicitly confirms the proposed action
     or reply. Opening or handing off a task is not approval.
   - The optional local processor/executor path enforces the same boundary:
     without a durable local human-reply id it neither creates a mutation outbox
     item nor executes submit, revision, amendment, or close actions.
   - MCP should surface server rejection reasons directly.
   - Task-detail live sync accepts both direct task responses and the current
     Relay `{ data: { task } }` envelope so local pending ownership is refreshed
     after an externally executed action.

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
    remote task subject/body or duplicated MCP tool instructions;
  - prompt/template require explicit human confirmation before Relay mutations;
  - live task-detail sync handles the current Relay response envelope.

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

## Task Context Management Plan

Goal: keep Relay as the only authoritative task context source while making
personal-agent reads bounded and mutation attempts safe against context changes.
The MCP client must not build a second authoritative task history or require
model-session replay for normal task handling.

### Confirmed Context Contract

- `GET /tasks/:id` is the authoritative context entry point and returns the
  complete ordered task, messages, and artifacts.
- WebSocket and worker events are notification summaries. After receiving an
  event, claiming work, or preparing an action, the client fetches the current
  task instead of treating the event or local inbox snapshot as authoritative.
- Local inbox state and raw event files remain notification, cache, recovery,
  and diagnostics data only.

### Stage 1: Mutation Context Guard And Idempotency

1. Derive a lightweight, non-authoritative task context envelope from a fresh
   task response. Include task id, goal version, exchange epoch, status,
   pending agent, completion owner, and latest message/artifact ids.
2. Bind a proposed mutation to the observed envelope and re-fetch the task
   immediately before mutation. Stop and return a structured context-changed
   result when guarded fields differ.
3. Continue sending `expected_goal_version`, `response_to_goal_version`, and
   `closed_against_goal_version` as applicable. Treat artifact/close goal
   versions as audit fields until Relay enforces mismatches with `409 Conflict`.
4. Give each user-confirmed action a stable client action id and derive a stable
   idempotency key from the task, action type, and action id. Retries of one
   confirmed action reuse the same key; separate confirmations use separate ids.
5. Keep Relay responsible for final atomic authorization and conflict checks.
   Client preflight checks improve behavior and diagnostics but are not the
   authoritative security boundary.

### Stage 2: Bounded Task Context Working View

1. Preserve `agentrelay_get_task` as the full-fidelity authoritative read tool.
2. Add a compact `agentrelay_get_task_context` working view for routine local
   agent handling. Derive it from a fresh Relay task response; do not persist it
   as an independent source of truth.
3. The first working view is deterministic, not LLM-summarized. It contains:
   - current task state, goal, done criteria, and ownership;
   - a bounded recent-message window;
   - bounded recent artifact metadata and short text previews;
   - counts and indicators that older messages or artifacts exist;
   - guidance to use `agentrelay_get_task` when complete history is required.
4. Keep large artifact bodies out of the default working view. Add focused
   artifact retrieval only when Relay exposes a stable artifact-read contract.
5. Define explicit context budgets by item count and serialized size, with
   deterministic truncation and visible truncation metadata. Never silently
   drop current goal, done criteria, ownership, or pending state.
6. Add LLM-generated rolling summaries only as a later optional layer. A
   summary must identify the last covered message/event and remain advisory;
   it never replaces authoritative history.
7. Coordinate with the Relay server on cursor-based history and artifact
   pagination when full task payload growth becomes a transport concern. Client
   compaction controls model context size but cannot reduce the server response
   size until paginated server APIs exist.

### Task Context Verification

- Context-envelope tests cover every guarded field and structured mismatch
  results.
- Idempotency tests cover retrying one confirmed action and intentionally
  sending two separately confirmed actions with identical content.
- Compact-view tests enforce deterministic ordering, item/byte budgets,
  truncation metadata, preservation of current task invariants, and fallback to
  the full task read.
- Event and local-cache tests verify that neither notification payloads nor raw
  inbox files are used as authoritative task context.

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
   - Current MCP baseline (2026-07-13): the personal-agent listener detects
     inactive half-open sockets, reconnects after sleep/network transitions,
     reconciles server-side pending work after hello and periodically, handles
     current and legacy response envelopes, and suppresses duplicate task
     snapshots across push/recovery event ids. Listener health is exposed to
     `doctor` through an atomic local status file.

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

1. Implement the Stage 1 mutation context guard and stable client action
   idempotency for the public Personal Agent MCP mutation tools.
2. Coordinate Relay `409 Conflict` enforcement for stale artifact submissions
   and closes; keep client checks non-authoritative.
3. Implement the Stage 2 bounded task-context working view while preserving
   `agentrelay_get_task` as the full authoritative read.
4. Add server history/artifact pagination only when payload growth requires a
   Relay protocol change.
5. Return to the Service Worker Kit after the personal-agent context and
   mutation-safety path is stable.

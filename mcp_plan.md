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

Goal: maintain a durable local materialized view of each Relay task so the user
can hand it to a chosen Local Agent, work with that agent in a user-owned
conversation, and safely submit the confirmed result. Relay remains the only
authoritative task source; local files make the latest fetched task readable,
recoverable, and inspectable without creating a second protocol authority.

### Confirmed Context Contract

- `GET /tasks/:id` is the authoritative context entry point and returns the
  complete ordered task, messages, and artifacts.
- WebSocket and worker events are notification summaries. They are persisted
  before ACK and never treated as a complete task.
- The local task snapshot comes only from a successful Relay task GET. Local
  workflow files, indexes, Markdown projections, event files, and cached
  snapshots are never authoritative inputs for Relay protocol decisions.
- Personal-agent behavior remains notifier-first. The product never starts,
  wakes, resumes, or controls a Local Agent. The user explicitly hands a task or
  investigation prompt to the agent they choose.

### Target Local Task Workspace

Use one stable directory per sanitized task id. UI categories are derived views;
do not move the canonical task directory when its status changes.

```text
state/
  tasks/
    <task-id>/
      remote.json
      context.md
      working-context.md
      handoff.md
      sync.json
      workflow.json
      actions/
        <client-action-id>.json
  task-index.json
```

1. `remote.json` is the complete last successfully fetched Relay task, including
   ordered messages and artifacts. Write it atomically with mode `0600`.
2. `context.md` is a deterministic full human/agent-readable projection of
   `remote.json`. It may collapse presentation in the UI, but it must not
   silently omit text history; non-text parts must retain metadata and a stable
   local or Relay retrieval reference.
3. `working-context.md` is an optional bounded view for large tasks. It never
   replaces `remote.json` or `context.md`, and it declares all truncation.
4. `handoff.md` is the current locally synthesized user-to-Agent prompt. Its
   prompt type is normal task handling, context-sync investigation, or
   changed-context reprocessing. The UI copies this file instead of rebuilding
   a second prompt implementation.
5. `sync.json` records event delivery, ACK, fetch attempts, last successful
   sync, sanitized errors, retry state, and the latest derived context envelope.
6. `workflow.json` records local-only state: UI category inputs, attention
   reason, handoff readiness, active/stale action ids, and archive state.
7. `actions/<client-action-id>.json` stores a proposed action, the exact payload,
   its base context envelope, confirmation reference, stable idempotency key,
   submission state, and Relay response identifiers.
8. `task-index.json` is a rebuildable projection used by the UI. It contains no
   unique task facts and may be regenerated from task workspaces.
9. Task directory creation, updates, and index writes use sanitized ids,
   per-task serialization, temporary files, atomic rename, directories mode
   `0700`, and files mode `0600`.

### Receive, ACK, And Context Sync State Machine

Split notification delivery from task-context synchronization.

1. Listener receives the event summary and writes the raw event durably.
2. Intake records the event identity and delivery metadata locally.
3. Intake ACKs the event after durable event persistence. ACK does not claim
   that complete task context has already synchronized.
4. Intake enqueues a context-sync job keyed by task id and event id. The retry
   record is durable and does not rely only on the task remaining discoverable
   through the pending-task reconciliation endpoint.
5. The context synchronizer calls `GET /tasks/:id` once.
6. On a retryable failure, it performs exactly one bounded retry, using a short
   configurable backoff. It records both attempts without logging credentials or
   unsafe response bodies.
7. On success, it validates the task id, atomically updates `remote.json`,
   regenerates `context.md` and the normal `handoff.md`, updates the context
   envelope, marks `context_ready`, and rebuilds the task index entry.
8. After the second failure, it marks `context_sync_failed`, records a sanitized
   error category and both attempt timestamps, and atomically writes the
   investigation form of `handoff.md` for the user.
9. Duplicate and out-of-order events may enqueue the same task repeatedly, but
   the latest successful full task response wins. Snapshot/envelope comparison
   prevents duplicate work and never rolls a task back to an older local view.
10. ACK retry and context-sync retry are independent. A failed ACK does not
    discard a successfully synchronized task; a successful ACK does not hide a
    failed context sync.

### Context Sync Failure Investigation

1. A failed sync appears in the UI as `Need approval` with reason
   `context_sync_failed`; it is not presented as a processable task.
2. Generate and persist the investigation `handoff.md` locally from trusted
   fields only: task id,
   event id, sanitized error category, attempt times, local task directory, and
   the Local Inbox `AGENTS.md` path. Do not include remote task content or raw
   server error bodies.
3. The prompt tells the Local Agent to diagnose listener/network/auth/local
   state, use read-only Relay access to verify the task, and invoke the supported
   local resync entry point. It must not submit, amend, or close the task while
   complete context is unavailable.
4. Provide one supported resync operation shared by the UI and Local Agent,
   rather than allowing hand-edits to state files. A successful manual resync
   writes the same canonical workspace and clears the failure reason.
5. The system only exposes this prompt. The user decides whether and when to
   hand it to a Local Agent; no processor, executor, or agent session is started.

### User Handoff And Local Agent Workflow

1. A normal handoff prompt becomes available only when `context_ready` is true.
2. The prompt contains the task id, absolute stable task directory, and Local
   Inbox `AGENTS.md` path. It does not copy remote task content into the prompt.
3. The user gives the prompt to their chosen Local Agent.
4. The Local Agent reads `context.md` and `remote.json`, checks the recorded sync
   time and context envelope, and treats all remote fields as untrusted
   user-level content.
5. The agent performs local analysis or file work, explains the task and exact
   proposed external action to the user, and waits for explicit confirmation.
6. Before requesting confirmation, the agent records the proposed action through
   a supported local prepare-action operation. This creates a stable client
   action id and preserves the draft independently of the chat session.
7. User confirmation does not need to resume or bind a Codex thread. The agent
   that receives confirmation submits the prepared action by its stable id.

### Incoming Updates While Work Is In Progress

1. Every new Relay notification follows the same ACK-then-sync pipeline.
2. A successful newer fetch atomically replaces `remote.json` and regenerates
   the readable context files.
3. Never overwrite or delete an existing proposed action or local draft.
4. Compare each non-terminal proposed action's base envelope with the new
   envelope. If guarded fields differ, mark the action `stale`, set the local
   attention reason to `context_changed`, and write the changed-context form of
   `handoff.md`.
5. Do not wake, resume, message, or interrupt a Local Agent. If the original
   Agent conversation is active, it discovers the change when its tool call
   returns. If it has ended, the user later hands off the updated task.
6. Archive state is preserved across incoming updates. Completed Relay state is
   synchronized even for archived tasks without automatically unarchiving them.

### Mutation Context Guard And Idempotent Submission

1. Derive a lightweight non-authoritative envelope from the synchronized task:
   task id, goal version, exchange epoch, Relay status, pending agent,
   completion owner, latest message id, and latest artifact id.
2. Bind every prepared action to that envelope and exact proposed payload.
3. On submit, re-fetch `GET /tasks/:id`; do not validate against only the local
   snapshot. Derive the current envelope and compare all guarded fields.
4. On mismatch, do not mutate Relay. Synchronize the newly fetched task locally,
   mark the action stale, return structured `CONTEXT_CHANGED` details to the
   active Agent, and move the UI view to `Need approval`.
5. On match, derive a stable idempotency key from task id, action type, and
   client action id. Retries of the same confirmed action reuse it; separate
   confirmations use separate action ids even when their text is identical.
6. Continue sending `expected_goal_version`, `response_to_goal_version`, and
   `closed_against_goal_version` as applicable. Treat artifact/close versions as
   audit fields until Relay enforces mismatch with `409 Conflict`.
7. If submission succeeds, persist the returned task or immediately fetch the
   complete task, atomically update the local workspace, mark the action sent,
   and update the UI projection.
8. If the network result is ambiguous, mark `submission_unknown` and reuse the
   same idempotency key for explicit retry. Never create a new action id merely
   because the response was lost.
9. Relay remains responsible for final atomic authorization, ownership, status,
   and conflict enforcement. Client guards improve correctness and diagnostics
   but are not a security boundary.

### UI Classification And Prompt Rules

Derive the four user-facing groups without moving task directories:

1. `Archived`: local archive flag wins for normal list visibility; data remains
   synchronized and recoverable.
2. `Completed`: Relay task is completed or valid local close state is recorded.
3. `Need approval`: context sync failed and needs investigation handoff; a task
   is ready for initial user handoff; a prepared action awaits confirmation; or
   an action became stale after context changed.
4. `Pending`: event/context sync is in progress, an action is submitting or has
   an ambiguous result, or ownership is pending on another agent.
5. Show context state, last successful sync time, latest fetch attempt, and the
   attention reason. Never label cached or failed context as current and complete.
6. Use the persisted `handoff.md` with separate deterministic prompt types for
   normal task handling, context-sync investigation, and changed-context
   reprocessing. The UI copies that file verbatim.
7. UI refresh reads the local task workspace. An explicit refresh/resync action
   may fetch Relay, but opening task detail must not silently create another
   competing live-snapshot store.

### Bounded Context Growth

1. Always preserve the complete last successful task in `remote.json` and a
   complete readable projection in `context.md`. The user and Local Agent retain
   a local path to the complete context.
2. Generate `working-context.md` only when configured item/byte thresholds are
   exceeded. Include current state, goal, done criteria, ownership, recent
   messages, recent artifact metadata, counts, and explicit truncation markers.
3. Never silently truncate current goal, done criteria, ownership, pending
   state, synchronization status, or the envelope used by a prepared action.
4. Keep large artifact bodies out of the bounded working view. Preserve their
   metadata and stable retrieval reference; add focused artifact retrieval only
   after Relay exposes a stable artifact-read contract.
5. Use deterministic item and serialized-byte budgets. Record generated size,
   omitted counts, and full-context fallbacks so defaults can be tuned from real
   workloads.
6. Do not add LLM summaries in the first implementation. A later optional
   rolling summary must record its coverage boundary and remain advisory.
7. Coordinate cursor-based task history and artifact pagination with Relay when
   full GET payload growth becomes a transport problem. Local working views
   control model context size but cannot reduce Relay response size.

### Migration And Compatibility

1. Introduce shared task-workspace and context-envelope modules before changing
   listener, intake, UI, or MCP mutation behavior.
2. Preserve current `.agentrelay/inbox` event files and `state/issues.json`
   during migration. Initially dual-write the new workspace and existing issue
   projection so upgrades are additive.
3. Backfill task workspaces from the newest valid existing raw/live snapshot;
   when unavailable, enqueue a Relay GET. Preserve archive state and local
   action/error history.
4. Switch UI reads to `task-index.json` and task workspaces only after parity
   tests pass. Keep a rebuild command that regenerates the index without Relay
   mutations.
5. Remove implicit UI live-event persistence only after listener/context-sync
   recovery is verified in installed service mode.
6. Keep the optional processor/executor path disabled by default and outside the
   primary design. If retained, it must consume the same workspace and guard
   modules rather than invent another context store.

### Implementation Phases

1. Foundation: schemas, atomic per-task writer, context envelope, deterministic
   Markdown projection, index rebuild, permissions, and path validation.
2. Receive pipeline: summary-only listener persistence, intake ACK boundary,
   durable sync queue, one retry, success/failure state, and recovery command.
3. UI migration: category projection, sync/attention visibility, prompt types,
   manual resync, and removal of implicit detail-page snapshot authority.
4. Local Agent actions: prepare-action persistence, user-confirmed submission,
   stale-action handling, context guard, stable idempotency, and success sync.
5. Context growth: thresholds, bounded working view, artifact metadata, metrics,
   and full-context fallback.
6. Compatibility cleanup: backfill verification, installed-service validation,
   deprecate superseded issue/live-event paths, and update public/install docs.

### Task Context Verification

- Event durability precedes ACK; context GET starts after ACK; ACK and sync
  failures remain independently recoverable.
- A first fetch failure triggers exactly one retry; a second failure creates a
  sanitized `context_sync_failed` record and investigation prompt without
  invoking any Agent.
- A successful initial/manual/recovery fetch produces the same atomic workspace
  and clears only the relevant sync-failure state.
- Complete task ordering and content in `remote.json` match Relay; `context.md`
  is deterministic and does not silently omit text parts.
- Duplicate/out-of-order events do not regress the workspace or duplicate jobs.
- UI category precedence, archive preservation, prompt types, and explicit
  stale/cached indicators are covered.
- Prepared actions survive incoming task updates; guarded changes mark them
  stale and return structured `CONTEXT_CHANGED` without a Relay mutation.
- Idempotency tests cover retrying one confirmed action, ambiguous network
  results, and two separately confirmed actions with identical content.
- Bounded-view tests enforce ordering, item/byte budgets, truncation metadata,
  invariant preservation, artifact references, and full-context fallback.
- Migration tests backfill existing state, preserve archives, rebuild indexes,
  and allow rollback while dual-write remains enabled.
- Run `npm run check`, focused listener/intake/UI/MCP tests, installed launchd
  service verification, and `http://127.0.0.1:8787/api/issues` verification for
  each phase that changes the live local inbox.

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

1. Implement the task-workspace foundation and additive `issues.json` projection.
2. Refactor listener/intake into durable event, ACK, and independent context-sync
   stages with one bounded retry and investigation handoff on failure.
3. Migrate the UI to workspace-backed categories and explicit normal,
   investigation, and changed-context prompts.
4. Add prepared local actions, submission-time context guard, stable action
   idempotency, and post-submit task synchronization.
5. Add bounded working context after complete local context and mutation safety
   are verified.
6. Coordinate Relay `409 Conflict` enforcement and later history/artifact
   pagination without moving protocol authority into the MCP client.
7. Return to the Service Worker Kit after the personal-agent local-context path
   is stable.

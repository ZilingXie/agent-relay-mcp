# AgentRelay MCP Implementation Plan

Last updated: 2026-07-19

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

## Protocol v0.4 Task Lifecycle Client Plan

Status: completed baseline; implemented and production-E2E verified. The server-owned contract is
`ZilingXie/agentRelay/docs/task-lifecycle-v04.md`. Protocol v0.4 is available
through explicit tools; v0.3 remains the default compatibility path until
participant capability advertisement supports automatic selection.

Current implemented Task status snapshot (verified 2026-07-18):

- `submitted`: supported; the Listener fetches and durably persists the full
  current Message before it may ACK delivery.
- `delivered`: supported; MCP sends `message_id`, `turn_sequence`,
  `expected_status_version`, and stable idempotency context through the v0.4
  Message ACK operation.
- `completed`: supported; the requester tool completes only against the current
  delivered target response.
- `expired`: supported as Relay-authoritative terminal state; the client syncs
  and renders it without local inference.
- `failed`: supported through the reason-constrained v0.4 failure tool and
  Relay authority checks.
- `cancelled` and `archived`: not exposed as Relay lifecycle mutations. Local
  archive remains presentation-only and never changes or deletes the Task.
- Multi-turn alternation, stale-state refresh, follow-up child workspaces,
  lifecycle notifications, and preservation of terminal Task history are
  implemented. v0.4 remains an explicit non-default tool path.

Implemented client behavior:

- Explicit v0.4 create, Message, completion, reason-constrained failure,
  follow-up, lineage, and bundle-sync MCP tools; v0.3 tools remain unchanged.
- Durable local event/Message recording before the Listener sends the only ACK
  that may transition a Task to `delivered`.
- Recovery from real unacked agent events after disconnect, including exact
  Message/turn/version ACK metadata.
- v0.4 workspace context envelopes with root, Message, turn, version, and
  direction fields; stale Relay conflicts refresh context and invalidate old
  prepared actions.
- No Task delete tool or local action. Local archive remains a presentation-only
  state and never deletes the Relay Task.

Implementation dependency and merge order:

1. The Relay server ships v0.4 schemas, storage, transition enforcement,
   protocol negotiation, and conformance support first.
2. MCP/Listener adds v0.4 support without removing v0.3.
3. v0.4 creation is an explicit tool choice while capability advertisement is
   incomplete; callers use it only when both participants are known to run the
   v0.4 client. The existing create tool stays on v0.3.
4. v0.4 is not enabled by default until a two-Agent create/ACK/response/ACK/
   requester-complete/follow-up run passes. This passed on 2026-07-16; changing
   the default remains a separate capability-rollout decision.

Verification record:

- Full client suite: 161 checks plus MCP smoke passed.
- Production root Task `task_255b7b51f9364697a6e599c45ea2d496`
  reached `completed` after both durable Listener ACK boundaries.
- Follow-up Task `task_842009bd133a4a2bbe48ebde9af8e0e4`
  shared the root lineage, created a distinct local workspace, and was
  explicitly terminated after verification.
- Implementation PRs: `#37`; follow-up workspace `#38`; repeatable production
  E2E runner `#39`; auth-username compatibility `#40`.

Client responsibilities:

- Persist the current Message to the local task workspace before sending the
  v0.4 delivery ACK. The ACK includes `message_id`, `turn_sequence`,
  `expected_status_version`, and a stable `idempotency_key`.
- Keep Task status authoritative on Relay. Local workspace/UI state is a
  materialized view and never invents `submitted`, `delivered`, or a terminal
  transition.
- Enforce strict two-Agent alternation in local preparation, while treating
  Relay rejection as authoritative. Do not allow the same Agent to create two
  consecutive Messages.
- Add v0.4 MCP operations for Message submit, requester completion,
  reason-constrained failure, and follow-up creation. Do not expose any Task
  delete operation.
- At `max_turns`, prevent another local turn and guide the requester Agent to
  choose `completed` or `failed/max_turns_exhausted`; never auto-close.
- On `409 stale_task_state`, fetch the latest Task, update the local workspace,
  invalidate stale prepared actions, and require a fresh Agent decision.
- Store and display opaque `task_id` plus `root_task_id`; derive follow-up
  grouping without parsing ids or persisting `is_followup`.
- Keep notifier-first and local guardrail behavior. v0.4 removes human-specific
  Relay state, but it does not remove local confirmation requirements.
- Preserve Task workspaces even after terminal state. Local archive may hide a
  workspace, but MCP must not request or imply hard deletion of the Relay Task.

Client verification must cover:

- durable local Message write before lifecycle-changing ACK;
- duplicate ACK/Message/follow-up idempotency;
- stale message, turn, and status-version recovery;
- target response keeping the turn and requester follow-up incrementing it;
- same-Agent consecutive Message rejection;
- requester-only completion against the current delivered response;
- requester-driven `max_turns_exhausted` failure;
- `task_expires_at` and terminal state rendering without local inference;
- root/follow-up workspace grouping with opaque Task ids;
- absence of Task delete tools or actions;
- v0.3/v0.4 negotiated coexistence.

## Protocol v0.5 Two-Layer Client Plan

Status: Protocol v0.5 is active in production as of 2026-07-19. Core
MCP/Listener/workspace v2/Inbox UI support merged in Client PR #44 after Server
PR #51. Client PR #47 corrected `doctor` to verify the installed v0.5 Listener's
Relay readiness instead of opening a competing legacy WebSocket. Zac and Vivi
now run the merged Client at `e42a4dc`; both publish fresh v0.5/workspace-v2
readiness and persisted the successful production root/follow-up E2E. Hermes is
an independent deferred workstream and was not changed. The 24-hour production
observation window is still in progress.
Protocol v0.4 remains a completed historical baseline and its tools, docs,
tests, and workspaces must not be overwritten.

The Server-owned contract is
`ZilingXie/agentRelay/docs/task-lifecycle-v05.md`. v0.5 becomes the only active
write protocol during a maintenance-window cutover.

The cross-component implementation order and release gates are in
`ZilingXie/agentRelay/docs/protocol-v05-rollout-plan.md`.

Client state boundaries:

- Task lifecycle comes from Server `tasks.status` and is rendered as open,
  completed, expired, or failed.
- Per-Message delivery comes from Server `messages.delivery_status` and is
  rendered as pending, delivered, or failed.
- Event outbox state is transport metadata only.
- Workspace and UI are materialized views of the Server visibility response and
  never invent or reconcile authoritative state locally.

Planned client behavior:

- Add v0.5 protocol sync, create, send Message, complete, fail, follow-up,
  full Task fetch, lineage, and visibility tools; switch generic tools to v0.5
  at cutover.
- Reject v0.3/v0.4 mutations locally with `protocol_retired`; preserve
  historical GET, timeline, lineage, and read-only local workspaces.
- Replace `expected_status_version` with the aggregate
  `expected_task_version`; do not add a delivery version.
- Handle `message.pending` by fetching the complete Task/Message, taking the
  workspace lock, durably writing workspace v2, verifying the write, and only
  then sending the current-Message ACK.
- Expose `agentrelay_get_task_v05` for the full ordered Task/Message response;
  visibility is diagnosis-only and cannot supply Message parts.
- Route intake by protocol and Event authority before ACK. A transitionable
  v0.5 `message.pending` Event must use Message-before-ACK; the existing
  ACK-then-sync path is permitted only for read-only legacy intake and v0.5
  informational Events that cannot transition Message or Task state.
- Use stable ACK idempotency over Agent, Task, Message, turn, and task version.
- Treat task/delivery/attempt notifications as informational outbox Events whose
  ACKs cannot mutate Task or Message.
- Store Task lifecycle and each Message's delivery separately in workspace v2;
  preserve v0.3/v0.4 workspaces as read-only legacy data.
- Update Inbox UI to show separate Task and delivery badges, two-dimensional
  filters, attempt/next-retry details, visibility diagnosis, and v0.5 action
  guards.
- Treat the Server enabled-Agent registry as the cutover admission set. Every
  enabled Agent must advertise v0.5 and publish fresh ready Listener status;
  unsupported/offline Agents are disabled before writes open. Old Listener
  reconnects and v0.3/v0.4 ACKs fail clearly rather than downgrade.
- Start workspace v2 against the new v0.5 collaboration namespace. Keep all
  v0.3/v0.4 workspace roots read-only and never rewrite them as v0.5.
- Register a new v0.5 Listener process instance at startup, retain the returned
  readiness epoch, and publish every 60 seconds with both values; the Server uses
  the confirmed 300-second maximum age and rejects stale epochs. Report ready
  only after protocol, workspace, authenticated recovery, and ACK/NACK
  self-checks.
- Bind WS hello, HTTP recovery, ACK, and NACK to the current Listener instance
  and readiness epoch. Stale hello is rejected; after a new registration the
  old socket is removed from delivery routing and cannot mutate new delivery.

The fixed delivery policy is four total attempts: initial delivery plus retries
after 1, 5, and 10 minutes. The Listener does not schedule retries; it reports
durable ACK or a guarded, idempotent non-retryable persistence NACK with Event,
Message, turn, and task-version identity. Retryable local errors send neither
ACK nor NACK. Relay alone owns attempt scheduling and exhaustion.

Why these client rules exist:

- Readiness blocks admission of a Task when an enabled participant is still on
  an incompatible Listener; it is not delivery evidence or execution progress.
- Keeping legacy workspaces read-only prevents an old snapshot from being
  rewritten into a plausible but false v0.5 state. Workspace v2 contains only
  native v0.5 materialized views.
- NACK is deliberately narrower than a generic error report. Use it only when
  the Listener has positively determined that retry cannot make local durable
  persistence succeed without intervention. Transient I/O, lock contention,
  timeout, process restart, and uncertain outcomes send no ACK or NACK and let
Relay retry. This avoids both false delivery and premature Task failure.

Implemented core evidence:

- explicit v0.5 protocol sync, mutation, full Task, lineage, and visibility
  MCP tools using aggregate `task_version`;
- isolated `state/collaboration-v2` Task/Message storage with write/read
  verification and legacy roots preserved;
- epoch-bound WS/recovery plus 60-second readiness publication;
- durable Message-before-ACK, stale Event rejection, informational ACK, and
  guarded non-retryable persistence NACK;
- Inbox UI Task/delivery filters, badges, attempt/next-retry details, and
  Server diagnosis projection;
- full Client test suite, desktop/390px browser verification, and local
  cross-repository create/ACK/response/ACK/complete/follow-up E2E.
- active v0.5 mode routes generic create through the native v0.5 payload and
  locally rejects legacy mutation tools with `protocol_retired`;
- Listener readiness now requires a real workspace v2 write/read probe,
  ACK/NACK endpoint compatibility probes, and successful authenticated Event
  recovery before publishing `ready=true`.

Production rollout evidence:

- Zac's full local installation passes the v0.5 `doctor`, including Listener
  identity/readiness matching, protocol bundle sync, and Inbox UI health.
- Vivi's isolated listener-only runtime passes its Listener freshness and Relay
  readiness checks. Full Codex config and Inbox UI checks are intentionally not
  applicable to that runtime.
- Both production Tasks completed at `task_version=5`; all four Messages are
  delivered and persisted in workspace v2.
- The remaining release activity is the 24-hour observation record. Hermes and
  dispatcher work remain separately deferred and do not change current v0.5
  Task/Message truth.

Project Hermes client workstream:

1. Preserve and review the current dirty `ZilingXie/heremes-deploy` production
   baseline before editing it. The deployed runtime is
   `/home/ubuntu/projects/hermes/project-hermes-worker` under `ubuntu` user
   systemd; reconcile the tracked worker unit's obsolete path.
2. Upgrade Hermes intake to v0.5 protocol routing, complete Message fetch,
   workspace lock/persist/verify, versioned ACK, guarded NACK, and stale-state
   resync. Local execution progress remains local and is not added to Relay.
3. Upgrade Hermes reply submission to strict two-Agent alternation, aggregate
   `task_version`, stable idempotency, and workspace refresh after mutation.
4. Make the dispatcher consume only Server batch visibility diagnosis and treat
   missing/unauthorized batch items as report errors, not failed Tasks.
5. Add fixtures for Zac delivered-but-waiting, Vivi not-delivered, exhaustion,
   completed, expired, partial-batch, stale readiness, and duplicate schedule
   execution; verify dry-run output before enabling WeCom delivery.

Planned verification:

- v0.5 manifest and MCP tool contract;
- full Task/Message fetch ordering, complete parts, and workspace persistence;
- durable local Message persistence before ACK;
- stable duplicate ACK and stale-state recovery;
- guarded non-retryable NACK and retryable no-ACK behavior;
- non-recursive informational Event ACK;
- workspace v2 and read-only v0.3/v0.4 workspace preservation;
- Inbox UI Task/delivery separation and action guards;
- protocol mismatch and required-upgrade behavior;
- enabled-Agent capability/readiness admission and stale-readiness rejection;
- Hermes Listener Message-before-ACK and guarded-NACK behavior;
- Hermes dispatcher diagnosis mapping, partial-batch handling, dry-run output,
  and per-window duplicate-send prevention;
- real two-Agent create/ACK/response/ACK/complete/follow-up E2E;
- attempt-exhaustion state synchronization with Server visibility.

Implementation dependency order:

1. Complete Task 0 Server, Client, and public planning publication; keep
   production mutations closed throughout core implementation.
2. Merge the Server v0.5 implementation and archive/cutover tooling.
3. Merge MCP/Listener and workspace v2 support.
4. Merge Inbox UI changes and complete cross-repository conformance.
5. Preserve and upgrade Hermes in its independent workstream.
6. Upgrade all Listener installations during the maintenance window before
   Server writes open.

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

Status (2026-07-13): implemented legacy baseline in the MCP client. The
per-task workspace, ACK-then-sync pipeline, one-retry recovery, manual resync,
workspace-backed UI, prepared-action context guard, stable idempotency,
post-submit sync, monotonic snapshot protection, index rebuild, and legacy
opt-in executor workspace guard are covered by focused and full-suite tests.
Relay-side atomic `409 Conflict` enforcement for artifact and close
goal-version mismatches remains server-owned follow-up work. Protocol v0.5
transitionable `message.pending` intake supersedes this ordering with
Message-before-ACK.

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
3. `handoff.md` is the current locally synthesized user-to-Agent prompt. Its
   prompt type is normal task handling, context-sync investigation, or
   changed-context reprocessing. Normal and changed-context prompts identify
   only `context.md` plus the installed Local Inbox `AGENTS.md`; `remote.json`
   remains a diagnostic source rather than a repeated prompt input. The UI
   copies this file instead of rebuilding a second prompt implementation.
4. `sync.json` records event delivery, ACK, fetch attempts, last successful
   sync, sanitized errors, retry state, and the latest derived context envelope.
5. `workflow.json` records local-only state: UI category inputs, attention
   reason, handoff readiness, active/stale action ids, and archive state.
6. `actions/<client-action-id>.json` stores a proposed action, the exact payload,
   its base context envelope, confirmation reference, stable idempotency key,
   submission state, and Relay response identifiers.
7. `task-index.json` is a rebuildable projection used by the UI. It contains no
   unique task facts and may be regenerated from task workspaces.
8. Task directory creation, updates, and index writes use sanitized ids,
   per-task serialization, temporary files, atomic rename, directories mode
   `0700`, and files mode `0600`.

### Deterministic Background Infrastructure

Listener, Intake, reconciliation, and context synchronization are deterministic
programs, not LLM Agents. They may run automatically and may:

1. Receive and durably persist Relay event summaries.
2. ACK events after the local durability boundary succeeds.
3. Fetch complete tasks through authenticated Relay GET requests.
4. Retry the configured network request once and run pending reconciliation.
5. Invoke the shared local resync operation for recovery work.
6. Update `context_sync_status`, task workspace files, and UI projections.

These components do not interpret user intent, prepare or approve external
replies, invoke mutation tools, or start, wake, resume, monitor through, or
delegate work to a Local Agent.

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
6. On a retryable failure, it performs exactly one automatic retry, using a short
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

### Local Resync Operation

Provide one shared deterministic operation with the product-level contract:

```text
agentrelay_resync_local_task(taskId)
```

It performs only:

```text
GET Relay task
-> validate task id and response shape
-> atomically update local remote.json and context.md
-> regenerate handoff.md and the task index
-> update context_sync_status
```

1. It does not submit an artifact, request revision, amend, close, claim, or
   otherwise mutate the Relay task.
2. It does not interpret task intent or make a user decision. Its behavior is
   identical regardless of who triggered it.
3. Only three entry points may trigger it: deterministic Listener/Intake recovery,
   an explicit UI retry action, or a Local Agent that the user explicitly asked
   to diagnose or handle the task.
4. Concurrent triggers for one task share a per-task lock and coalesce onto one
   in-flight GET/write result. They must not race atomic workspace replacement.
5. Return structured success/failure state suitable for both UI display and an
   active Agent tool result, without exposing credentials or unsafe raw errors.
6. Implement the MCP tool or Local Inbox API as a thin adapter over this shared
   operation so multiple entry points cannot drift in behavior.

### Context Sync Failure Investigation

1. A failed sync appears in the UI as `Need approval` with reason
   `context_sync_failed`; it is not presented as a processable task.
2. Generate and persist the investigation `handoff.md` locally from trusted
   fields only: task id,
   event id, sanitized error category, attempt times, local task directory, and
   the Local Inbox `AGENTS.md` path. Do not include remote task content or raw
   server error bodies.
3. The system writes and exposes this prompt but never starts or wakes an Agent.
   The user decides whether and when to hand it to a Local Agent or to use the UI
   retry action directly.
4. Only after the user explicitly asks a Local Agent to investigate may that
   Agent read Listener status and errors, check whether local task context is
   complete, call read-only `agentrelay_get_task`, invoke
   `agentrelay_resync_local_task`, and explain findings and next steps to the
   user.
5. The investigation prompt states that the Agent must not submit an artifact,
   request revision, amend, or close while complete context is unavailable.
6. Agents and users must use the supported resync operation rather than
   hand-editing local state files. Successful resync clears the sync-failure
   reason through the same deterministic workspace writer.

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

1. Route by protocol and Event authority: v0.5 transitionable
   `message.pending` uses fetch-lock-persist-verify-ACK; informational and
   read-only legacy notifications may use the legacy ACK-then-sync pipeline.
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
5. Compatibility cleanup: backfill verification, installed-service validation,
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
- Background-boundary tests verify event delivery and reconciliation never
  invoke a Local Agent, processor, executor, or mutation tool.
- Resync tests verify background recovery, UI retry, and a user-invoked Agent
  adapter use the same GET/atomic-write implementation and per-task lock.
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

## Protocol Automatic Upgrade

Status: implementation merged in Server PR
[`agentRelay#61`](https://github.com/ZilingXie/agentRelay/pull/61) at `2a8c789`,
followed by Client PR
[`#50`](https://github.com/ZilingXie/agent-relay-mcp/pull/50) at `087bd2c`.
The Relay contract was deployed and production-verified on 2026-07-19. This
repository's active Zac Codex installation at
`/Users/xieziling/Desktop/agentRelay/agentInbox` was fast-forwarded to
`90b3a3c`, dependencies were refreshed, and `doctor` passed every config,
Listener, Relay, bundle, runtime compatibility, authentication, readiness, and
Inbox check.

- Stable semantic create/reply/complete/fail/follow-up tools sit above a
  versioned wire adapter. Local identity and current Task context supply protocol
  fields that Local Agents must not invent.
- Startup and 426 recovery negotiate with Relay. Verified bundles are isolated
  by authority/origin, staged, digest-checked, schema-checked, and atomically
  activated under an inter-process lock with last-known-good recovery.
- The adapter is restricted data mapping, never remotely programmable code.
  Identity, confirmation, authorization, idempotency, route allowlists, durable
  local state, and side effects remain in MCP core.
- New lifecycle, transport, persistence, approval, or local execution semantics
  return `client_release_required`; compatible wire changes may use hot patch.
- Runtime, sync, MCP smoke, and real Relay negotiation checks gate release.
- Verified 2026-07-19 with 190 unit tests, MCP smoke coverage for same-key
  one-time 426 retry, and real HTTP negotiation/assembly of all five v0.5
  semantic operations.
- Production Relay negotiation returned `hot_patch` for runtime `0.2.0`, bundle
  revision `1`, and an authority/origin-bound v0.5 bundle with no missing
  capabilities.
- Production Task `task_49162c5d5b3f418080f856e75a0200ad` verified Zac ->
  Hermes delivery, Hermes -> Zac response delivery, and requester completion.
  Hermes returned `HERMES_PROTOCOL_UPGRADE_ACK` and reported
  `agent-collab-v0.5`; the Task closed at version `5` with both Messages
  delivered.

## Guardrail Hardening

Status: Server PR [`agentRelay#64`](https://github.com/ZilingXie/agentRelay/pull/64)
and Client PR [`#54`](https://github.com/ZilingXie/agent-relay-mcp/pull/54)
are merged. Relay and Zac are deployed on adapter v2 revision `2`; Hermes policy
integration merged in [`heremes-deploy#4`](https://github.com/ZilingXie/heremes-deploy/pull/4),
with process-level enforcement coverage in
[`#5`](https://github.com/ZilingXie/heremes-deploy/pull/5) and
[`#6`](https://github.com/ZilingXie/heremes-deploy/pull/6). Relay, Zac, and
Hermes are deployed and verified. Protocol automatic upgrade is part of this
Guardrail.

1. Adapter sandbox and activation.
   - Require adapter v2's exact operation and semantic-slot contracts.
   - Reject scripts, unknown fields, protected-slot rebinding, duplicate or
     missing slots, duplicate targets, unsafe JSON Pointers, oversized bundles,
     authority-path mismatch, digest mismatch, future publication, expiry,
     unauthorized downgrade, and same-revision digest replacement.
   - Preserve staging, atomic activation, last-known-good, authorized rollback,
     and local/Server emergency-disable switches.
2. Trusted local human approval.
   - Ignore confirmation refs supplied while preparing an action.
   - Let only the Local Inbox issue the approval record, bound to exact action,
     payload hash, Task context hash, expiry, and confirmation ref.
   - Resync context and require the embedded authorization to match the
     independent approval record before mutation; consume it after success and
     reuse it only for an ambiguous same-idempotency retry.
   - Keep direct v0.5 create disabled by default; reviewed-draft Send is the
     normal create authority.
3. Hermes service policy.
   - Allow only a bounded reply or `agent_reported_failure` for an open v0.5
     Task whose current delivered Message is owned by `project-hermes`.
   - Deny create, complete, follow-up, goal or participant changes, requester
     authority, non-delivered Messages, changed context, oversized replies,
     unknown reasons, and local side effects.
   - MCP service-policy grants are bound for 60 seconds to
     policy/rule/agent/action/payload/context. The standalone Hermes worker
     enforces the same maximum permission directly before first send and outbox
     replay, including actor, Message, turn, Task version, idempotency, payload
     shape, and text-size binding.
4. Accepted trust model.
   - Relay remains the trusted protocol publisher. TLS, path binding, digests,
     and validity windows do not protect against total Relay-host compromise.
     Independent bundle signing and KMS are deferred.
   - Local approval protects against remote content and normal MCP calls, not a
     malicious process with write access as the same OS user. Stronger isolation
     requires a separate OS identity or external approval service.
5. Release gate.
   - **Complete.** Client full tests passed 204/204 plus MCP smoke; Server full
     tests passed; the real cross-repo HTTP E2E applied `hot_patch`, activated
     revision `2`, assembled protected reply fields, then returned `up_to_date`.
   - **Complete.** Server merged before Client. Relay and Zac were upgraded;
     Zac `doctor` passed bundle activation, runtime compatibility,
     authentication, Listener readiness, and Inbox checks.
   - **Complete.** Hermes was built and deployed from an isolated clean worktree;
     the dirty canonical Agent overlay baseline was not pulled, committed, or
     modified. Runtime worker/policy hashes match merged source.
   - **Complete.** The deployed worker returned
     `HERMES_GUARDRAIL_ACK_20260719` in production Task
     `task_da25ff6e44ca41d981a7182afd4b0e06`; both Messages were delivered and
     Zac completed the Task through prepare, one-time Local Inbox approval, and
     same-idempotency MCP submission at Task version `5`.
   - **Complete.** Exact worker-process E2E proves bounded reply and
     `agent_reported_failure` each send one permitted POST, while `close_task`,
     legacy complete replay, and actor-tampered replay send zero POSTs and
     persist `policy_denied`. Adapter malicious-bundle, last-known-good,
     rollback, and both emergency-disable paths remain covered by deterministic
     Server/Client tests. Vivi is not in this gate.

The detailed boundary is [`docs/guardrail.md`](docs/guardrail.md).

## Structured Message Subject And Dynamic Agent Tools

Status: implemented on task branch; pending Server/Client PRs, staged rollout,
installation upgrades, activation, and production verification.

- New Task and follow-up tools use structured `message.subject + message.parts`;
  reply exposes only Agent-supplied `taskId + parts`.
- Create/follow-up pre-register a bounded `/message/metadata` slot. Signed
  bundles may hot-add optional public fields inside it; the local core fixes its
  destination, limits, reserved keys, and non-authoritative semantics.
- The local MCP supports adapter contracts v1 and v2. A verified v2 bundle may
  hot-update the fixed semantic tool Schemas through SDK tool-list change
  notifications.
- Agent tool definitions are constrained by a compiled tool/operation/field
  allowlist. Identity, approval, routes, handlers, protected slots, LKG, and
  rollback remain non-hot-updatable MCP Core behavior.
- Reply/follow-up resolve a unique prepared action by Task, action type, and
  payload hash; human approval and Hermes service-policy validation remain
  mandatory.
- Inbox title priority is structured first-Message subject, legacy `Subject:`
  line for historical Tasks, then truncated done criteria.
- Full Client tests (214/214 plus MCP smoke), full Server tests, malicious-
  bundle tests, hot patch E2E, and create/delivery/reply/complete/follow-up E2E
  passed before PR creation.

## Immediate Next Steps

1. Coordinate Relay `409 Conflict` enforcement without moving protocol authority
   into the MCP client.
2. Return to the Service Worker Kit after the personal-agent local-context path
   is stable.

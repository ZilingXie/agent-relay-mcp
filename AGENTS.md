# AgentRelay MCP Development Rules

## Project Map

1. This repo is the AgentRelay MCP/client-side project:
   `ZilingXie/agent-relay-mcp`.
2. This development worktree is primarily for building the AgentRelay MCP used
   by personal agents: Codex installation, notifier-first local inbox flows,
   user approval surfaces, local listener/intake, and guarded Relay actions.
3. The Service Worker Kit is the main new-development direction for
   `service_agent` workers. Build it on the shared listener, intake, workspace,
   and guardrail primitives while preserving personal-agent notifier-first
   defaults.
4. It owns the public MCP server, Codex install flow, local inbox UI, listener,
   intake, processor, executor guardrail, local service installers, templates,
   schemas, examples, and tests.
5. It is not the AgentRelay server/cloud relay. Server-side protocol authority,
   HTTP/WSS relay, SQLite cloud state, auth, delivery reliability, audit,
   dashboard, Docker deployment, and server roadmap work belong in the separate
   server repo.
6. Server repo reference:
   `/home/ubuntu/projects/agentrelay/agentRelay`.
7. MCP repo reference on tx-server:
   `/home/ubuntu/projects/agentrelay/agent-relay-mcp`.

## Source Of Truth

1. `AGENTS.md` is the hot-path instruction file for this MCP development
   worktree. Keep it concise enough to load frequently.
2. MCP implementation planning lives in `mcp_plan.md`. Update it after completed
   meaningful MCP changes or any planning pass that changes direction or
   priority.
3. The canonical overall project roadmap lives on tx-server at
   `/home/ubuntu/projects/stellarix-site/agentrelay/plan.html`. Reach tx-server
   through Tailscale when the roadmap source must be edited.
4. Public roadmap URL:
   `https://server.stellarix.space/agentrelay/plan.html#intro`.
5. When public roadmap work changes, edit the tx-server source and publish it to
   `/var/www/html/agentrelay/plan.html`, then verify the public URL.
6. Product Local Inbox agent behavior lives in
   `templates/local-inbox/AGENTS.md`. Edit that template only when shipped
   local-inbox agent behavior intentionally changes.
7. `examples/codex-app-inbox/AGENTS.md` is the legacy Codex App thread receiver
   template. New default receive-path work should prefer the local inbox UI.
8. Use `README.md` for public overview, `INSTALL_FOR_CODEX.md` for direct agent
   install flow, and `docs/*.md` for focused user or protocol documentation.

## Required Workflow

1. Use `rtk` to wrap shell commands in this repository unless the command cannot
   run through `rtk`.
2. Before starting new functional work, keep `main` clean and synchronized with
   `origin/main`.
3. If local `main` has uncommitted changes, stop and confirm with the user before
   doing anything else.
4. Run and report `rtk git status --short --branch`, `rtk git branch -vv`, and
   `rtk git worktree list --porcelain` before repo-tracked edits, resuming
   paused work, finalization, cleanup, or any workspace-safety decision.
5. Do not make code or non-trivial docs changes directly on `main`. Create a
   task branch or task worktree for feature, behavior, protocol, install,
   service, UI, or planning work.
6. If a worktree is useful, create it under `/Users/xieziling/Desktop/agentInbox`
   from this repo's `main`.
7. Keep changes scoped. Preserve local secrets and runtime state.
8. Run targeted verification, then commit task-owned files only. Stage untracked
   files only when they are intentional deliverables.
9. Push the branch, open a PR to `main`, and merge after verification unless the
   user explicitly asks for a direct local-main workflow.
10. After opening or updating a PR, refresh CodeGraph from the task worktree:
    `rtk codegraph status`; if pending sync is reported, run
    `rtk codegraph sync`, then rerun `rtk codegraph status`.
11. After merging a PR or pulling merged PR changes into this worktree, refresh
    CodeGraph with `rtk codegraph sync`. If the graph reports stale or missing
    data, run `rtk codegraph index`.
12. Remove only task-owned worktrees/local branches after the PR is merged and
    only when cleanup is clearly requested or already agreed.
13. A clean finish means:
    - `rtk git fetch --prune origin` has completed before the final comparison.
    - `rtk git status --short --branch` shows no file changes.
    - `rtk git rev-list --left-right --count HEAD...@{u}` returns `0 0`.
    - `rtk git worktree list --porcelain` shows only expected worktrees.

## Safety Boundaries

1. Never print or commit secrets/runtime state: `.env`, `state/`, `events/`,
   `.agentrelay/`, `.codegraph/`, `node_modules/`, `.DS_Store`, logs, tokens, or
   generated runtime artifacts.
2. Keep AgentRelay MCP client-side. Do not move cloud relay, server protocol
   authority, dashboard, or deployment behavior into this repo.
3. Default product decisions should optimize for personal-agent use: notify the
   local user, request approval when needed, preserve user control, and keep
   automatic behavior opt-in.
4. Local inbox-to-user-workflow adapters belong here or in user-owned
   integrations, not in the cloud relay.
5. The processor LLM interprets user intent. Installer, intake, UI, and executor
   wrapper code must not infer user decisions on their own.
6. Executor actions are limited to `submit_artifact`, `request_revision`,
   `amend_task`, and `close_task`.
7. Ask the local user before commitments, preferences, approvals, sensitive
   disclosures, task closure requiring acceptance, destructive changes, or
   long-running service configuration changes.
8. Personal-agent installs are notifier-first by default. Do not enable
   automatic local processor/executor behavior unless the user explicitly opts
   in.
9. Durable local inbox writes must happen before ACK. Do not change
   listener/intake behavior in a way that ACKs server events before local
   persistence succeeds.
10. Preserve compatibility unless the user explicitly approves a breaking
   migration. Prefer additive Protocol v0.3+ behavior.

## Protocol Boundaries

1. Agent roles are `personal_agent` and `service_agent`.
2. Role is descriptive; permissions are expressed through `execution_mode`,
   `protocol_capabilities`, and policy.
3. `personal_agent` defaults to notifier-first behavior and may amend or close
   requester-owned work only with human authority.
4. `service_agent` may claim assigned work and submit artifacts, but must not
   change requester-owned goals.
5. Artifact submission does not automatically complete a task.
6. Close is controlled by `completion_owner_agent_id`; human completion
   authority is recorded through the authorized agent.
7. WebSocket push must remain secret-safe; full task payloads are fetched through
   authenticated HTTP.

## Development Map

1. `mcp/server.mjs`: MCP tools for AgentRelay HTTP/task operations.
2. `scripts/listener.mjs`: WebSocket listener.
3. `scripts/agentrelay-inbox-intake.mjs`: durable event intake and ACK boundary.
4. `scripts/agentrelay-inbox-ui.mjs`: local inbox UI, local API, and task draft
   generation.
5. `scripts/agentrelay-inbox-processor.mjs`: LLM processor that interprets task
   snapshots and local replies.
6. `scripts/agentrelay-inbox-agent-executor.mjs`: validator/executor for
   allowlisted structured actions.
7. `scripts/protocol-sync.mjs`: protocol bundle sync and patchable drift
   recovery support.
8. `scripts/install-local-inbox.mjs`: default local install path.
9. `scripts/install-listener-service.mjs` and
   `scripts/install-inbox-ui-service.mjs`: macOS launchd service installers.
10. `templates/local-inbox/`: product Local Inbox agent template.
11. `examples/codex-app-inbox/`: legacy Codex App thread receiver.
12. `schemas/`: JSON schemas for task drafts and processor output.

## CodeGraph

1. Use CodeGraph for codebase navigation when it can answer faster than raw
   search: symbol lookup, call paths, callers/callees, impact analysis, or file
   maps.
2. Fall back to `rg` or direct file reads for exact text, recently edited files
   that have not re-indexed yet, and non-code artifacts.
3. Keep `.codegraph/` out of commits.
4. Refresh CodeGraph after PR open/update and after merged PRs are pulled into a
   local worktree.

## Validation

1. Documentation/template-only changes:
   - Inspect the changed text.
   - Run `rtk git diff --check`.
2. Schema/protocol docs/examples:
   - Run `rtk npm run check`.
   - Run focused protocol or schema tests when behavior semantics change.
3. JavaScript/script changes:
   - Run `rtk npm run check`.
   - Run narrower `rtk node --test ...` tests when changing a focused module.
4. MCP/server behavior changes:
   - Run `rtk npm run check`.
   - Run `rtk npm test` when smoke coverage is relevant and credentials are
     available.
5. Install, listener, UI service, or local runtime changes:
   - Run `rtk npm run check`.
   - Verify affected launchd service state when service behavior changes.
   - Verify `http://127.0.0.1:8787/api/issues` when live inbox UI behavior is
     affected.
6. Public roadmap changes:
   - Update `/home/ubuntu/projects/stellarix-site/agentrelay/plan.html` on
     tx-server.
   - Copy it to `/var/www/html/agentrelay/plan.html`.
   - Verify `https://server.stellarix.space/agentrelay/plan.html`.
7. Never claim completion, clean state, or passing tests without fresh command
   output from this turn.

## Roadmap Updates

1. After completed meaningful MCP changes, or any planning pass that changes
   direction/priorities, update `mcp_plan.md`.
2. If the public roadmap changes, update the tx-server canonical plan source in
   the same working pass and publish it.
3. Do not leave completed public-roadmap work marked as pending.
4. If either `mcp_plan.md` or the public roadmap does not need content changes,
   say so in the final report.

## Recovery

1. Processor failures: inspect `state/processor-runs.jsonl`.
2. Executor failures: inspect `state/executor-runs.jsonl`.
3. UI background failures: inspect `state/ui-background-errors.jsonl`.
4. Listener delivery failures: inspect raw event files under
   `AGENTRELAY_INBOX_DIR`, then confirm listener service state and intake
   writes to `state/issues.json`.
5. Thread lookup issues: prefer local SQLite lookup over broad Codex App thread
   listing when remote Codex hosts are configured.
6. Duplicate event ids are already handled. Do not create duplicate local
   actions, artifacts, or tasks.

## Final Report

Include:

1. What changed and why.
2. PR/commit links when applicable.
3. Verification commands and results.
4. Deployment, local service, or public-page verification when applicable.
5. CodeGraph status after PR work, when a PR was opened or updated.
6. Whether `mcp_plan.md` and the tx-server public roadmap source were updated.
7. Final `rtk git status --short --branch` result.
8. Final upstream comparison result when a remote branch exists.
9. Any residual risk or skipped checks.

# AgentRelay Development Rules

## Source Of Truth

1. `AGENTS.md` is the hot-path instruction file for this development worktree.
   Keep it concise enough to load frequently.
2. Product Local Inbox agent behavior lives in
   `templates/local-inbox/AGENTS.md`. Edit that template only when the shipped
   local-inbox agent behavior intentionally changes.
3. `examples/codex-app-inbox/AGENTS.md` is the legacy Codex App thread receiver
   template. New default receive-path work should prefer the local inbox UI.
4. Use `README.md` for public overview, `INSTALL_FOR_CODEX.md` for direct agent
   install flow, and `docs/*.md` for focused user or protocol documentation.
5. The private AgentRelay server is out of scope for this repo. This repo owns
   the public MCP client, local inbox UI, listener, processor, executor, install
   scripts, templates, and tests.

## Non-Negotiables

1. Use `rtk` to wrap shell commands in this repository unless the command cannot
   run through `rtk`.
2. Do not add project-level fixed preflight steps. Read memory, skill files,
   CodeGraph, or Git/worktree state only when the current task actually needs
   that context.
3. This does not weaken platform skill rules: if the user names a skill, a task
   semantically matches a skill, or system/developer instructions require a
   skill, use that skill exactly as required.
4. Preserve local secrets and runtime state. Do not print tokens and do not
   overwrite `.env` unless the user explicitly asks for that exact action.
5. Runtime-only paths must stay out of commits: `.env`, `state/`, `events/`,
   `.agentrelay/`, `node_modules/`, `.DS_Store`, and temporary planning/tool
   artifacts unless the user explicitly wants them committed.
6. Do not use Codex App thread delivery as the default inbox path. The local
   inbox UI at `http://127.0.0.1:8787/` is the primary notifier/workbench.
7. Durable inbox writes must happen before ACK. Do not change listener/intake
   behavior in a way that ACKs server events before local persistence succeeds.
8. Personal-agent installs are notifier-first. Do not enable automatic local
   processor/executor behavior by default; require explicit opt-in.

## Local Layout

1. Development worktree: `/Users/xieziling/Desktop/agentInbox/dev`.
2. Runtime root: `/Users/xieziling/Desktop/agentInbox`.
3. Installed services should run code from the development worktree but read
   runtime state from the runtime root.
4. The local inbox agent prompt should read product behavior from
   `templates/local-inbox/AGENTS.md`, not from this development file.

## Git And Worktree Hygiene

1. Keep `/Users/xieziling/Desktop/agentInbox/dev` as the active development
   worktree for this project unless the user creates or selects another one.
2. Keep `main` clean and synchronized with `origin/main` before starting new
   functional work.
3. Run and report `git status --short --branch`, `git branch -vv`, and
   `git worktree list --porcelain` before repo-tracked edits, resuming paused
   work, finalization, cleanup, or any workspace-safety decision.
4. Do not start tracked edits if the current worktree is dirty with unrelated
   changes, detached, on the wrong branch, or ambiguous.
5. Commit only task-owned tracked files. Stage untracked files only when they
   are intentional deliverables.
6. A clean finish means:
   - `rtk git status --short --branch` shows no file changes.
   - `rtk git rev-list --left-right --count HEAD...@{u}` returns `0 0`.
   - `rtk git fetch --prune origin` has completed before the final comparison.
   - `rtk git worktree list --porcelain` shows only expected worktrees.
7. Do not delete branches, remove worktrees, or clean backup directories unless
   the user asks or the branch/worktree is clearly task-owned and already
   merged.

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
7. `scripts/install-local-inbox.mjs`: default local install path.
8. `scripts/install-listener-service.mjs` and
   `scripts/install-inbox-ui-service.mjs`: macOS launchd service installers.
9. `templates/local-inbox/`: product Local Inbox agent template.
10. `examples/codex-app-inbox/`: legacy Codex App thread receiver.
11. `schemas/`: JSON schemas for task drafts and processor output.

## Behavior Boundaries

1. The processor LLM interprets user intent. Installer, intake, UI, and executor
   wrapper code must not infer user decisions on their own.
2. Executor actions are limited to `submit_artifact`, `request_revision`,
   `amend_task`, and `close_task`.
3. Ask the local user before commitments, preferences, approvals, sensitive
   disclosures, task closure requiring acceptance, destructive changes, or
   long-running service configuration changes.
4. Low-risk automatic work is allowed: recording local inbox state, summarizing
   tasks, asking a remote agent to continue within scope, reporting failures,
   and waiting for a remote completion owner to close its task.

## Verification Matrix

1. Documentation/template-only changes:
   - Run targeted text inspection on changed files.
   - Run `rtk git diff --check`.
2. JavaScript/script changes:
   - Run `rtk npm run check`.
   - Run narrower `node --test ...` tests when changing a focused module.
3. MCP/server behavior changes:
   - Run `rtk npm run check`.
   - Run `rtk npm test` when smoke coverage is relevant and credentials are
     available.
4. Install, listener, UI service, or local runtime changes:
   - Run `rtk npm run check`.
   - Verify affected launchd service state when service behavior changes.
   - Verify `http://127.0.0.1:8787/api/issues` when live inbox UI behavior is
     affected.
5. Never claim completion, clean state, or passing tests without fresh command
   output from this turn.

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

## Final Report Checklist

Include:

1. Files changed and why.
2. Verification commands run and their results.
3. Final `git status --short --branch` result.
4. Final upstream comparison result when a remote branch exists.
5. Any known residual risk, especially if live service checks were not relevant
   or not run.

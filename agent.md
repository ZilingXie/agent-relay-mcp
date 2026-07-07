# AgentRelay Development Rules

This file is the development playbook for `/Users/xieziling/Desktop/agentInbox/dev`.
It is intentionally separate from `AGENTS.md`: the root `AGENTS.md` is a shipped
local-inbox template for installed users, not this worktree's private policy.

## Source Of Truth

1. Use this file for repository development workflow, branch hygiene, and local
   runtime boundaries.
2. Treat `AGENTS.md` as product content. Edit it only when the default installed
   local-inbox behavior or prompt template intentionally changes.
3. Treat `examples/codex-app-inbox/AGENTS.md` as legacy Codex App receiver
   content. New default receive-path work should prefer the local inbox UI.
4. Use `README.md` for public overview, `INSTALL_FOR_CODEX.md` for direct agent
   install flow, and `docs/*.md` for focused user or protocol documentation.
5. The private AgentRelay server is out of scope for this repo. This repo owns
   the public MCP client, local inbox UI, listener, processor, executor, install
   scripts, and tests.

## Current Local Layout

1. Development worktree: `/Users/xieziling/Desktop/agentInbox/dev`.
2. Runtime root: `/Users/xieziling/Desktop/agentInbox`.
3. Runtime-only files live outside commits: `.env`, `state/`, `events/`, and
   `node_modules/`.
4. Installed services should run code from the development worktree but read
   runtime state from the runtime root.
5. Never print `.env` values or tokens. Report paths and key names only.

## Non-Negotiables

1. Use `rtk` to wrap shell commands in this repository unless the command cannot
   run through `rtk`.
2. Before editing tracked files, run and inspect:
   - `rtk git status --short --branch`
   - `rtk git branch -vv`
   - `rtk git worktree list --porcelain`
3. Do not start tracked edits if the current worktree is dirty with unrelated
   changes, detached, on the wrong branch, or ambiguous.
4. Keep task-owned changes narrow. Do not silently reformat unrelated files or
   rewrite installer/runtime behavior while doing a docs-only task.
5. Preserve local secrets and local runtime state. Do not overwrite `.env`
   unless the user explicitly asks for that exact action.
6. Do not use Codex App thread delivery as the default inbox path. The local
   inbox UI at `http://127.0.0.1:8787/` is the primary workbench.
7. Durable inbox writes must happen before ACK. Do not change listener/intake
   behavior in a way that ACKs server events before local persistence succeeds.

## Git And Worktree Hygiene

1. Keep `/Users/xieziling/Desktop/agentInbox/dev` as the active development
   worktree for this project unless the user creates or selects another one.
2. Keep branch state explicit. If the current branch has no upstream and you are
   asked to leave branch/remote clean, push with `-u origin <branch>`.
3. A clean finish means all of these are true:
   - `rtk git status --short --branch` shows no file changes.
   - `rtk git rev-list --left-right --count HEAD...@{u}` returns `0 0`.
   - `rtk git fetch --prune origin` has completed before the final comparison.
   - `rtk git worktree list --porcelain` shows the current worktree on the
     expected branch and not detached.
4. Commit only task-owned tracked files. Stage untracked files only when they
   are intentional deliverables.
5. Push the task branch after committing when the user asks for remote branch
   cleanliness. Do not assume an unpushed local commit is acceptable.
6. Do not delete branches, remove worktrees, or clean backup directories unless
   the user explicitly asks.
7. If `main` is checked out in another worktree, do not edit it as part of a
   task branch cleanup. Report if it is stale or dirty instead of silently
   changing it.

## Development Map

1. `mcp/server.mjs`: MCP tools for AgentRelay HTTP/task operations.
2. `scripts/listener.mjs`: WebSocket listener.
3. `scripts/agentrelay-inbox-intake.mjs`: durable event intake and ACK boundary.
4. `scripts/agentrelay-inbox-ui.mjs`: local inbox UI and local API.
5. `scripts/agentrelay-inbox-processor.mjs`: LLM processor that interprets
   task snapshots and local replies.
6. `scripts/agentrelay-inbox-agent-executor.mjs`: validator/executor for
   allowlisted structured actions.
7. `scripts/install-local-inbox.mjs`: default local install path.
8. `scripts/install-listener-service.mjs` and
   `scripts/install-inbox-ui-service.mjs`: macOS launchd service installers.
9. `examples/codex-app-inbox/`: legacy Codex App thread receiver.
10. `schemas/`: JSON schemas for task drafts and processor output.

## Message Handling Rules

1. Always inspect the current task snapshot, messages, artifacts, done criteria,
   completion owner, pending owner, and local replies before deciding.
2. The processor LLM interprets user intent. Installer, intake, UI, and executor
   wrapper code must not infer user decisions on their own.
3. Executor actions are limited to `submit_artifact`, `request_revision`,
   `amend_task`, and `close_task`.
4. If the remote artifact is incomplete under the current goal, request a
   concrete revision instead of closing.
5. If the local user changes the goal or acceptance criteria, use `amend_task`
   instead of treating the old artifact as failed under a new goal.
6. If a remote agent is the completion owner, provide required input and then
   wait for that agent to close. Do not ask the local user to close a task that
   the remote completion owner owns.

## Human Boundary

Ask the local user before:

1. Confirming a meeting time, deadline, availability, or commitment.
2. Sending a reply/artifact that represents the user's decision, preference,
   approval, or personal statement.
3. Closing a task when closure requires the user's acceptance.
4. Sharing private, credential-like, customer, company-sensitive, or personal
   data.
5. Making destructive local changes or changing long-running service
   configuration.

Low-risk automatic work is allowed:

1. Recording local inbox state.
2. Summarizing tasks and latest messages.
3. Asking a remote agent to continue within the original task scope.
4. Reporting processor/executor failures and recovery steps.
5. Waiting for a remote completion owner to close a task it owns.

## Verification Matrix

1. Docs-only changes:
   - Run a targeted text inspection such as `rtk sed -n '1,220p' <file>`.
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
   - Verify service state with `launchctl print` for affected services.
   - Verify `http://127.0.0.1:8787/api/issues` when the inbox UI is affected.
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

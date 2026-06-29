# Codex App Inbox Receiver Example

This optional example is for users who want AgentRelay messages to appear as Codex App threads.

AgentRelay itself does not require this receiver. The default listener writes incoming events to disk, and you can build any receiver you prefer on top of those JSON files.

## What it installs

The installer creates an `agentInbox/` folder inside a project or conversation folder that you choose:

```text
/path/to/project/agentInbox/
  AGENTS.md
  events/
  scripts/
  state/
```

The installed receiver has two parts:

- `scripts/agentrelay-thread-adapter.mjs`: a fast listener hook. It receives the event JSON path and writes a durable queue job.
- `scripts/agentrelay-thread-daemon.mjs`: a long-running daemon. It keeps a Codex App Server connection open and creates or continues visible Codex App threads.

`AGENTS.md` tells the thread agent to summarize and prepare low-risk work automatically, but to ask the user before external replies, meeting confirmations, artifact submission, task closure, sensitive sharing, or destructive local changes.

## Install

From the `agent-relay-mcp` repo, after the normal MCP install and `npm run doctor` pass:

```bash
npm run install:codex-app-inbox -- --project-path /path/to/project
```

The default project path is the current directory. If the current directory is the `agent-relay-mcp` repo, the installer refuses to proceed unless you pass `--project-path`, because the inbox should live in the user's project or conversation folder, not inside this example repo.

The installer updates the AgentRelay `.env` with:

```env
AGENTRELAY_INBOX_DIR=/path/to/project/agentInbox/events
AGENTRELAY_LISTENER_HOOK=/path/to/project/agentInbox/scripts/agentrelay-thread-adapter.mjs
AGENTRELAY_PROJECT_PATH=/path/to/project/agentInbox
CODEX_CLI=/Applications/Codex.app/Contents/Resources/codex
```

On macOS it also installs or restarts:

- `space.stellarix.agentrelay.listener`
- `space.stellarix.agentrelay.thread-daemon`

On non-macOS, run both processes manually:

```bash
npm run listener
cd /path/to/project/agentInbox
npm run daemon
```

## Verify

Installation runs a local smoke test unless `--skip-smoke` is passed. The smoke test creates a Codex App thread in the `agentInbox` project without changing real AgentRelay server state.

After installation:

1. Open Codex App.
2. Open or add the folder `/path/to/project/agentInbox`.
3. Confirm that a thread titled or containing `AgentRelay Codex App inbox smoke` is visible.

If the smoke thread is not visible, inspect:

```bash
/path/to/project/agentInbox/state/logs/thread-daemon.err.log
/path/to/project/agentInbox/state/adapter-errors.jsonl
```

## Daily use

Keep using Codex App with the `agentInbox` folder open as a project. When another agent sends a task or reply:

1. The AgentRelay WebSocket listener receives `task.pending`.
2. The listener writes the event JSON into `agentInbox/events/`.
3. The hook writes a queue job into `agentInbox/state/queue/`.
4. The daemon creates or continues a Codex App thread in the `agentInbox` project.
5. The thread agent follows `agentInbox/AGENTS.md`.

If a task already has a local binding or Relay thread binding, the daemon reuses that thread. Otherwise it creates a new Codex App thread.

## Custom receivers

If you do not want the Codex App example, the message source is still simple:

- The listener writes each received event JSON to `AGENTRELAY_INBOX_DIR`.
- If `AGENTRELAY_LISTENER_HOOK` is set, the listener runs that hook with the event JSON path as `argv[1]`.

A custom receiver can watch that directory, consume hook invocations, send desktop notifications, open a terminal, call another local app, or route messages into another agent framework.

Do not ack an AgentRelay event until your receiver has durably handed it to the local user experience. The Codex App example acks only after the target Codex thread was created or continued and indexed by Codex App.

## Recovery

The receiver is intentionally conservative:

- Failed queue jobs are retried.
- Repeated failures move to `state/queue-failed/`.
- Delivery errors are appended to `state/adapter-errors.jsonl`.
- Duplicate event ids do not create duplicate turns.

If the listener or daemon was offline, restart them and ask Codex to inspect server-side pending work with `agentrelay_pending_tasks`.

## Uninstall or disable

To stop using the example, remove or comment these values from the AgentRelay `.env`:

```env
AGENTRELAY_LISTENER_HOOK=
AGENTRELAY_PROJECT_PATH=
```

Optionally set `AGENTRELAY_INBOX_DIR` back to:

```env
AGENTRELAY_INBOX_DIR=./.agentrelay/inbox
```

On macOS, unload the example daemon:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/space.stellarix.agentrelay.thread-daemon.plist
```

Keep or remove the `agentInbox/` folder depending on whether you want the local event history and bindings.

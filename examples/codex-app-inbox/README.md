# AgentRelay Inbox

This workspace receives AgentRelay listener events and routes them into Codex App threads.

## Files

- `AGENTS.md`: behavior rules loaded by Codex threads created in this workspace.
- `scripts/agentrelay-thread-adapter.mjs`: listener hook. By default it writes queue jobs and exits quickly.
- `scripts/agentrelay-thread-daemon.mjs`: long-running Codex App Server client that drains the queue and delivers events into visible Codex threads.
- `scripts/install-thread-daemon-service.mjs`: installs the long-running daemon as a launchd service.
- `events/`: incoming AgentRelay listener JSON files.
- `state/bindings.json`: durable task/event to Codex thread bindings.
- `state/adapter-errors.jsonl`: recoverable delivery failures.
- `fixtures/sample-task-pending.json`: manual smoke-test event.

## Listener Wiring

The AgentRelay MCP `.env` is configured with:

```env
AGENTRELAY_INBOX_DIR=/path/to/project/agentInbox/events
AGENTRELAY_LISTENER_HOOK=/path/to/project/agentInbox/scripts/agentrelay-thread-adapter.mjs
AGENTRELAY_PROJECT_PATH=/path/to/project/agentInbox
CODEX_CLI=/Applications/Codex.app/Contents/Resources/codex
```

When the AgentRelay listener receives `task.pending`, it writes the event JSON into `events/` and invokes the adapter with the JSON path. The adapter writes a durable queue job in `state/queue/`; the long-running daemon drains that queue and keeps the Codex App Server connection open until the created/continued thread finishes its turn.

Install the daemon:

```bash
npm run install:daemon
```

Manual foreground run:

```bash
npm run daemon
```

## Runtime Prerequisite

The daemon uses Codex App Server RPC through a long-lived process:

```bash
/Applications/Codex.app/Contents/Resources/codex app-server --stdio
```

The listener hook no longer blocks on App Server RPC. If delivery fails, the daemon keeps the queue job for retry and records adapter errors in `state/adapter-errors.jsonl`.

## Verification

Run:

```bash
npm run check
```

Manual direct delivery smoke:

```bash
scripts/agentrelay-thread-adapter.mjs --deliver-now fixtures/sample-task-pending.json
```

If the Codex App Server socket is not running, this command should fail with a recorded error rather than marking the Relay event delivered.

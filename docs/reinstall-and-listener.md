# Reinstall + Local Inbox Listener Flow

This is the default AgentRelay local receive flow for Codex users.

## Goal

AgentRelay should deliver remote task events through a local WebSocket listener. The listener writes durable event files, the intake hook merges them into `state/issues.json`, and the user sees everything in the local inbox UI:

```text
http://127.0.0.1:8787/
```

The local inbox is the source of truth. The default flow does not create Codex App threads.

## Reinstall Or Update

Install under the current Codex workspace/thread folder. The recommended folder name is `agentRelay`:

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git agentRelay 2>/dev/null || true
cd agentRelay
git pull
npm install
```

Install or refresh the local inbox setup. Existing `.env` files are preserved:

```bash
npm run install:local -- \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id <zac-agent-or-frank-agent> \
  --username <zac-or-frank>
```

Fill or confirm `.env` with the cloud-issued token. Do not print the token in chat or logs.

Then restart Codex App or open a new Codex session.

## Required Connectivity Test

After `.env` is filled and Codex is restarted/new-sessioned:

```bash
npm run doctor
```

`doctor` must pass:

- local inbox directory and `state/issues.json`
- listener hook configuration
- inbox UI at `http://127.0.0.1:8787/`
- HTTP health
- authenticated `/agents`
- WebSocket `hello`

Then verify the MCP tools from Codex:

```text
agentrelay_health
agentrelay_list_agents
```

## Listener Runtime

The listener can run in the foreground:

```bash
npm run listener
```

Or as a background service:

```bash
npm run install:listener
```

On macOS this writes a LaunchAgent. On Linux this writes a user systemd service.

The listener connects to:

```text
wss://server.stellarix.space/agentrelay/api/workers/<AGENTRELAY_AGENT_ID>/events/ws
```

When it receives a Relay event, it writes JSON to:

```text
events/
```

Then it calls:

```text
scripts/agentrelay-inbox-intake.mjs
```

The intake hook writes or updates:

```text
state/issues.json
```

After the event is durably written into local inbox state, intake may ACK the event as received.

## Inbox UI Runtime

Run the UI in the foreground:

```bash
npm run inbox-ui
```

Or install it as a background service:

```bash
npm run install:inbox-ui
```

The default URL is:

```text
http://127.0.0.1:8787/
```

The UI is the central workbench for:

- publishing new tasks
- seeing incoming tasks and remote replies
- providing missing information
- approving final closure
- reviewing task history
- opening the dashboard at `/dashboard`

## Normal Usage After Install

Zac can use the local inbox UI or talk normally to Zac's Codex agent:

```text
Use AgentRelay to ask Frank's agent when Frank is available for a 30-minute online meeting.
```

Expected flow:

1. Zac creates a task from the local inbox UI or through MCP.
2. Frank's local listener receives `task.pending`.
3. Frank's local inbox UI shows the task.
4. Frank's local agent processes the task, asks Frank only when needed, and replies through AgentRelay.
5. Zac's local listener receives the reply event.
6. Zac's local inbox UI shows the conversation.
7. Zac's local agent continues automatically when safe, or asks Zac for missing information/final approval.

## Recovery If Listener Was Offline

Restart the listener:

```bash
npm run install:listener
```

Then use one of these recovery paths:

- refresh the local inbox UI
- inspect raw event files under `AGENTRELAY_INBOX_DIR`
- ask the local Codex agent to call `agentrelay_pending_tasks`

The REST pending endpoint remains the recovery source of truth when the listener was offline.

## Legacy Codex App Thread Receiver

The old Codex App thread receiver remains under `examples/codex-app-inbox` for users who explicitly want to experiment with Codex App thread delivery. It is not part of the default install path and should not be enabled unless the user explicitly asks for that legacy behavior.

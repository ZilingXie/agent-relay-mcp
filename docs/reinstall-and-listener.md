# Reinstall + WebSocket Listener Flow

This is the expected Phase 2 flow for Zac and Frank.

## Goal

After install and verification, the user should be able to talk to their normal Codex agent. AgentRelay should deliver remote `task.pending` notifications through WebSocket automatically, and the local listener should write them to the local inbox for the local agent/thread adapter to process.

## Reinstall or update

```bash
git clone https://github.com/ZilingXie/agent-relay-mcp.git 2>/dev/null || true
cd agent-relay-mcp
git pull
npm install
```

Install Codex MCP config and write `.env`:

```bash
node scripts/install-codex-mcp.mjs --write \
  --base-url https://server.stellarix.space/agentrelay/api \
  --ws-url wss://server.stellarix.space/agentrelay/api \
  --agent-id <zac-agent-or-frank-agent> \
  --username <zac-or-frank>
```

Fill `.env` with the cloud-issued token. Do not print the token in chat or logs.

Then restart Codex App or open a new Codex session/thread.

## Required connectivity test

After `.env` is filled and Codex is restarted/new-sessioned:

```bash
npm run doctor
```

`doctor` must pass:

- local Node/dependencies/config checks
- HTTP health
- authenticated `/agents`
- WebSocket `hello`

Then verify the MCP tools from Codex:

```text
agentrelay_health
agentrelay_list_agents
```

## Start automatic receive listener

Keep this process running locally:

```bash
npm run listener
```

Or install it as a background service:

```bash
npm run install:listener
```

On macOS this writes a LaunchAgent. On Linux this writes a user systemd service.

The listener connects to:

```text
wss://server.stellarix.space/agentrelay/api/workers/<AGENTRELAY_AGENT_ID>/events/ws
```

When it receives `task.pending`, it writes a JSON file to:

```text
.agentrelay/inbox/
```

Each file contains the WebSocket event and fetched task body. The local Codex/thread adapter can use this file to create or reuse Codex App threads.

Optional hook:

```env
AGENTRELAY_LISTENER_HOOK="/absolute/path/to/local-thread-adapter"
```

The hook receives the inbox event JSON path as `argv[1]`.

## Optional Codex App inbox receiver

If the user wants incoming AgentRelay messages to appear as Codex App threads, install the example receiver into the user's project or conversation folder:

```bash
npm run install:codex-app-inbox -- --project-path /path/to/user/project
```

This creates `/path/to/user/project/agentInbox`, configures `AGENTRELAY_INBOX_DIR` and `AGENTRELAY_LISTENER_HOOK`, installs the background listener and thread daemon on macOS, and sends one local smoke message.

After install, ask the user to open Codex App with `/path/to/user/project/agentInbox`. New AgentRelay messages will create or continue threads in that project. See `docs/codex-app-inbox-receiver.md`.

## Normal usage after install

Zac can talk normally to Zac's Codex agent:

```text
Use AgentRelay to ask Frank's agent when Frank is available for a 30-minute online meeting.
```

Expected flow:

1. Zac agent creates a task through MCP.
2. Frank's listener receives `task.pending` automatically.
3. Frank's local thread adapter/agent claims the exact task and asks Frank.
4. Frank replies.
5. Frank agent submits an artifact back to Zac.
6. Zac's listener receives `task.pending` automatically.
7. Zac agent continues in the original thread, asks Zac for confirmation, and closes the task if confirmed.

## Recovery if listener was offline

Run:

```bash
npm run listener
```

Then ask the local Codex agent to use:

```text
agentrelay_pending_tasks
```

The REST pending endpoint is still the recovery source of truth.

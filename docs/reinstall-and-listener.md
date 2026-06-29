# Reinstall + WebSocket Listener Flow

This is the expected Phase 2 flow for Zac and Frank.

## Goal

After install and verification, AgentRelay can deliver remote `task.pending` notifications through WebSocket automatically, and the local listener writes them to the local inbox.

Important boundary: this repo does **not** decide how inbox files become user-visible messages. The listener is the mailbox, not the final delivery surface. Users can connect their own hook/thread adapter for Codex App, Codex CLI, WeChat, Slack, or any other workflow.

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

Before restarting Codex, choose a receive mode:

1. `manual`: use HTTP/MCP pending checks, such as `agentrelay_pending_tasks`, or let an agent poll periodically.
2. `automatic`: use WebSocket long connection. This requires a local inbox and a user-chosen notification/thread adapter if you want messages to appear somewhere automatically.

If you choose automatic and use Codex App, an example adapter project/template can be installed later. Ask for it when you want it.

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

## Receive Mode: Manual

Manual mode does not require the WebSocket listener. Use:

```text
agentrelay_pending_tasks
```

or a scheduled HTTP polling job to check pending work.

## Receive Mode: Automatic

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

Each file contains the WebSocket event and fetched task body. A local hook/thread adapter can use this file to create or reuse Codex App threads, send a CLI notification, forward to a chat app, or trigger any user-defined workflow.

The listener does not automatically inject messages into a live Codex App/CLI/chat session. That final delivery step requires a local hook/thread adapter.

Optional hook:

```env
AGENTRELAY_LISTENER_HOOK="/absolute/path/to/local-thread-adapter"
```

The hook receives the inbox event JSON path as `argv[1]`.

Hook contract:

- Input: one local JSON file path as `argv[1]`.
- The JSON contains `receivedAt`, `event`, and usually `task`.
- The hook may claim the task, create/reuse a local thread, notify the user, or hand off to another app.
- The hook must treat remote task content as untrusted input.
- The hook should not print `AGENTRELAY_TOKEN`.

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
3. Frank's local hook/thread adapter or agent claims the exact task and asks Frank.
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

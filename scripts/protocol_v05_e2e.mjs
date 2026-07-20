#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { processInboxEvent } from "./agentrelay-inbox-intake.mjs";

const serverRoot = [
  process.env.AGENTRELAY_SERVER_REPO,
  "../protocol-v05-server",
  "../agentRelay"
].filter(Boolean).map((candidate) => resolve(candidate)).find((candidate) => (
  existsSync(join(candidate, "server", "app.py"))
));
if (!serverRoot) throw new Error("Set AGENTRELAY_SERVER_REPO to the Protocol v0.5 Server checkout");
const root = await mkdtemp(join(tmpdir(), "agentrelay-v05-e2e-"));
const dbPath = join(root, "v05.sqlite3");
const legacyDbPath = join(root, "legacy.sqlite3");
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}/agentrelay/api`;
const agents = {
  "zac-agent": { username: "zac", token: "zac-token" },
  "frank-agent": { username: "frank", token: "frank-token" }
};

seedServer();
const server = spawn("python3", ["-m", "server.app"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    AGENTRELAY_HOST: "127.0.0.1",
    AGENTRELAY_PORT: String(port),
    AGENTRELAY_DB_PATH: legacyDbPath,
    AGENTRELAY_V05_DB_PATH: dbPath,
    AGENTRELAY_MUTATION_MODE: "v05",
    AGENTRELAY_TOKENS: "zac:zac-agent:zac-token,frank:frank-agent:frank-token"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForHealth();
  const listeners = {
    "zac-agent": await registerListener("zac-agent"),
    "frank-agent": await registerListener("frank-agent")
  };
  const created = await request("zac-agent", "POST", "/tasks", {
    protocol_version: "agent-collab-v0.5",
    idempotency_key: "client-e2e-create",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    done_criteria: "pong accepted",
    max_turns: 2,
    message: {
      subject: "Initial ping",
      metadata: { category: "e2e", display: { priority: 2 } },
      parts: [{ kind: "text", text: "ping" }]
    }
  });
  let task = created.task;
  const taskId = task.task_id;

  await intakeRecovered("frank-agent", listeners["frank-agent"]);
  let detail = await request("frank-agent", "GET", `/tasks/${taskId}`);
  task = detail.task;
  assert.equal(detail.messages[0].delivery_status, "delivered");
  assert.equal(detail.messages[0].subject, "Initial ping");
  assert.deepEqual(detail.messages[0].metadata, { category: "e2e", display: { priority: 2 } });

  detail = await request("frank-agent", "POST", `/tasks/${taskId}/messages`, {
    actor_agent_id: "frank-agent",
    message_id: task.current_message_id,
    turn_sequence: task.turn_sequence,
    expected_task_version: task.task_version,
    idempotency_key: "client-e2e-response",
    parts: [{ kind: "text", text: "pong" }]
  });
  await intakeRecovered("zac-agent", listeners["zac-agent"]);
  detail = await request("zac-agent", "GET", `/tasks/${taskId}`);
  task = detail.task;
  assert.equal(detail.messages.at(-1).delivery_status, "delivered");
  assert.equal(detail.messages.at(-1).metadata, null);

  const completed = await request("zac-agent", "POST", `/tasks/${taskId}/complete`, {
    actor_agent_id: "zac-agent",
    message_id: task.current_message_id,
    turn_sequence: task.turn_sequence,
    expected_task_version: task.task_version,
    idempotency_key: "client-e2e-complete",
    completed_against_message_id: task.current_message_id
  });
  assert.equal(completed.task.status, "completed");

  const followup = await request("zac-agent", "POST", `/tasks/${taskId}/followups`, {
    idempotency_key: "client-e2e-followup",
    done_criteria: "second pong accepted",
    message: {
      subject: "Follow-up ping",
      metadata: { category: "followup" },
      parts: [{ kind: "text", text: "ping again" }]
    }
  });
  assert.equal(followup.task.root_task_id, taskId);
  assert.equal(followup.messages[0].subject, "Follow-up ping");
  assert.deepEqual(followup.messages[0].metadata, { category: "followup" });
  const lineage = await request("zac-agent", "GET", `/tasks/${taskId}/lineage`);
  assert.deepEqual(new Set(lineage.tasks.map((item) => item.task_id)), new Set([taskId, followup.task.task_id]));
  console.log(JSON.stringify({ ok: true, taskId, followupTaskId: followup.task.task_id }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
}

async function intakeRecovered(agentId, listener) {
  const query = new URLSearchParams({
    listener_instance_id: listener.instanceId,
    readiness_epoch: String(listener.epoch)
  });
  const recovered = await request(agentId, "GET", `/workers/${agentId}/events?${query}`);
  assert.equal(recovered.events.length, 1);
  const event = recovered.events[0];
  assert.equal(event.can_transition_message, true);
  const eventPath = join(root, `${event.event_id}.json`);
  await writeFile(eventPath, JSON.stringify({ event: {
    ...event,
    eventId: event.event_id,
    type: event.event_type,
    protocolVersion: "agent-collab-v0.5",
    taskId: event.task_id,
    messageId: event.message_id,
    canTransitionMessage: event.can_transition_message
  } }));
  const result = await processInboxEvent({
    eventPath,
    stateRoot: join(root, `state-${agentId}`),
    projectPath: root,
    agentId,
    listenerInstanceId: listener.instanceId,
    readinessEpoch: listener.epoch,
    ackReceived: true,
    relayClient: relayClient(agentId)
  });
  assert.equal(result.acked, true);
}

function relayClient(agentId) {
  return {
    getTask: (taskId) => request(agentId, "GET", `/tasks/${taskId}`),
    ackMessage: ({ messageId, payload }) => request(
      agentId, "POST", `/workers/${agentId}/messages/${messageId}/ack`, payload
    ),
    ackInformationalEvent: ({ eventId, payload }) => request(
      agentId, "POST", `/workers/${agentId}/events/${eventId}/ack`, payload
    ),
    failMessageDelivery: ({ messageId, payload }) => request(
      agentId, "POST", `/workers/${agentId}/messages/${messageId}/delivery-fail`, payload
    )
  };
}

async function registerListener(agentId) {
  const instanceId = `client-e2e-${agentId}`;
  const registered = await request(agentId, "POST", `/workers/${agentId}/readiness/register`, {
    listener_instance_id: instanceId,
    client_version: "0.5.0",
    workspace_version: "2",
    transport: "websocket"
  });
  const epoch = registered.readiness.readiness_epoch;
  await request(agentId, "POST", `/workers/${agentId}/readiness`, {
    listener_instance_id: instanceId,
    readiness_epoch: epoch,
    ready: true
  });
  return { instanceId, epoch };
}

async function request(agentId, method, path, payload) {
  const identity = agents[agentId];
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${identity.token}`,
      "X-AgentRelay-Agent-Id": agentId,
      "X-AgentRelay-Username": identity.username
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = JSON.parse(await response.text());
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

function seedServer() {
  const code = [
    "import sys",
    "from server.store_v05 import V05Store",
    "s=V05Store(sys.argv[1])",
    "[s.upsert_agent(a,name=a,owner=a,enabled=True,protocol_capabilities=['agent-collab-v0.5']) for a in ('zac-agent','frank-agent')]"
  ].join(";");
  const seeded = spawnSync("python3", ["-c", code, dbPath], { cwd: serverRoot, encoding: "utf8" });
  if (seeded.status !== 0) throw new Error(`Failed to seed v0.5 Server: ${seeded.error?.message || seeded.stderr || "unknown error"}`);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("v0.5 Server did not become healthy");
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const socket = net.createServer();
    socket.once("error", rejectPort);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

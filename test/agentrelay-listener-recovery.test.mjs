import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("v0.5 Listener recovers a stale WebSocket epoch without changing process identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-listener-recovery-"));
  const registrations = [];
  const readiness = [];
  let currentEpoch = 0;

  const api = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const body = await readRequestJson(request);
    if (request.method === "GET" && url.pathname.endsWith("/protocols/agent-collab/v0.5/manifest")) {
      return sendJson(response, 200, { version: "agent-collab-v0.5" });
    }
    if (request.method === "POST" && url.pathname.endsWith("/readiness/register")) {
      registrations.push(body);
      if (body.recover_if_stale === true && registrations.length === 2) {
        return sendJson(response, 409, {
          error: "listener_recovery_not_allowed",
          code: "listener_recovery_not_allowed"
        });
      }
      currentEpoch += 1;
      return sendJson(response, 201, {
        readiness: {
          listener_instance_id: body.listener_instance_id,
          readiness_epoch: currentEpoch
        }
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/readiness")) {
      readiness.push(body);
      return sendJson(response, 200, { readiness: body });
    }
    if (request.method === "POST" && (url.pathname.endsWith("/ack") || url.pathname.endsWith("/delivery-fail"))) {
      return sendJson(response, 404, { code: "task_not_found" });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      assert.equal(url.searchParams.get("readiness_epoch"), "2");
      return sendJson(response, 200, { events: [] });
    }
    sendJson(response, 404, { code: "not_found" });
  });
  await listen(api);
  t.after(() => api.close());

  let websocketAttempts = 0;
  const sockets = new Set();
  const websocket = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      const headerEnd = request.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.removeAllListeners("data");
      websocketAttempts += 1;
      const header = request.subarray(0, headerEnd).toString("utf8");
      if (websocketAttempts === 1) {
        const body = JSON.stringify({
          error: "stale_readiness_epoch",
          code: "stale_readiness_epoch"
        });
        socket.end([
          "HTTP/1.1 409 Conflict",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body
        ].join("\r\n"));
        return;
      }
      const key = header.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
      assert.ok(key);
      const accept = crypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n"));
      socket.write(textFrame({
        type: "hello",
        protocolVersion: "agent-collab-v0.5",
        agentId: "vivi-agent",
        listenerInstanceId: registrations.at(-1).listener_instance_id,
        readinessEpoch: 2,
        serverTime: 1
      }));
    });
  });
  await listen(websocket);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    websocket.close();
  });

  const apiPort = api.address().port;
  const websocketPort = websocket.address().port;
  const statusPath = join(root, "listener-status.json");
  const child = spawn(process.execPath, [resolve(repoRoot, "scripts/listener.mjs"), "--env", join(root, "missing.env")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: `http://127.0.0.1:${apiPort}/agentrelay/api`,
      AGENTRELAY_WS_URL: `ws://127.0.0.1:${websocketPort}/agentrelay/api`,
      AGENTRELAY_AGENT_ID: "vivi-agent",
      AGENTRELAY_USERNAME: "vivi",
      AGENTRELAY_TOKEN: "test-token",
      AGENTRELAY_PROTOCOL_VERSION: "agent-collab-v0.5",
      AGENTRELAY_INBOX_DIR: join(root, "inbox"),
      AGENTRELAY_STATE_DIR: join(root, "state"),
      AGENTRELAY_LISTENER_STATUS_PATH: statusPath,
      AGENTRELAY_LISTENER_HOOK: process.execPath,
      AGENTRELAY_ACK_ON_INBOX_RECEIVED: "1",
      AGENTRELAY_LISTENER_RECONNECT_MS: "10",
      AGENTRELAY_LISTENER_INACTIVITY_MS: "5000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill("SIGKILL"));

  await waitFor(async () => {
    if (!readiness.some((item) => item.readiness_epoch === 2 && item.ready === true)) return false;
    try {
      return JSON.parse(await readFile(statusPath, "utf8")).state === "connected";
    } catch {
      return false;
    }
  }, 5000, () => stderr);
  const status = JSON.parse(await readFile(statusPath, "utf8"));

  assert.equal(registrations.length, 3);
  assert.equal(registrations[0].recover_if_stale, undefined);
  assert.equal(registrations[1].recover_if_stale, true);
  assert.equal(registrations[2].recover_if_stale, true);
  assert.equal(new Set(registrations.map((item) => item.listener_instance_id)).size, 1);
  assert.equal(registrations[2].client_version, "0.5.1");
  assert.equal(websocketAttempts, 2);
  assert.equal(status.state, "connected");
  assert.equal(status.readinessEpoch, 2);
  assert.equal(status.ready, true);
});

test("v0.6 Listener drains Message and expired Events before publishing ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-listener-v06-"));
  const statusPath = join(root, "listener-status.json");
  const acked = new Set();
  const readiness = [];
  const events = [
    {
      event_id: "evt_v06_message",
      event_type: "message.pending",
      task_id: "task_v06_message",
      message_id: "msg_v06",
      can_transition_message: true,
      payload: {}
    },
    {
      event_id: "evt_v06_expired",
      event_type: "task.status_changed",
      task_id: "task_v06_expired",
      can_transition_message: false,
      payload: { status: "expired" }
    }
  ];

  const api = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const body = await readRequestJson(request);
    if (request.method === "GET" && url.pathname.endsWith("/protocols/agent-collab/v0.6/manifest")) {
      return sendJson(response, 200, { version: "agent-collab-v0.6" });
    }
    if (request.method === "POST" && url.pathname.endsWith("/readiness/register")) {
      return sendJson(response, 201, { readiness: { listener_instance_id: body.listener_instance_id, readiness_epoch: 1 } });
    }
    if (request.method === "POST" && url.pathname.endsWith("/readiness")) {
      readiness.push(body);
      return sendJson(response, 200, { readiness: body });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      assert.equal(url.searchParams.get("readiness_epoch"), "1");
      const event = events.find((item) => !acked.has(item.event_id));
      return sendJson(response, 200, { events: event ? [event] : [] });
    }
    if (request.method === "GET" && url.pathname.endsWith("/tasks/task_v06_message")) {
      return sendJson(response, 200, v06TaskDetail("task_v06_message", "open", "pending", 1));
    }
    if (request.method === "GET" && url.pathname.endsWith("/tasks/task_v06_expired")) {
      return sendJson(response, 200, v06TaskDetail("task_v06_expired", "expired", "pending", 2));
    }
    if (request.method === "POST" && url.pathname.endsWith("/messages/msg_v06/ack")) {
      assert.equal(body.listener_instance_id.startsWith("listener-vivi-agent-"), true);
      assert.equal(body.readiness_epoch, 1);
      acked.add(body.event_id);
      return sendJson(response, 200, v06TaskDetail("task_v06_message", "open", "delivered", 2));
    }
    if (request.method === "POST" && url.pathname.endsWith("/events/evt_v06_expired/ack")) {
      assert.equal(body.readiness_epoch, 1);
      acked.add("evt_v06_expired");
      return sendJson(response, 200, {});
    }
    if (request.method === "POST" && (url.pathname.endsWith("/ack") || url.pathname.endsWith("/delivery-fail"))) {
      return sendJson(response, 404, { code: "task_not_found" });
    }
    sendJson(response, 404, { code: "not_found" });
  });
  await listen(api);
  t.after(() => api.close());

  const sockets = new Set();
  const websocket = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      const headerEnd = request.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.removeAllListeners("data");
      const header = request.subarray(0, headerEnd).toString("utf8");
      const key = header.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
      const accept = crypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n"));
      const parsed = new URL(`ws://localhost${header.match(/^GET\s+(\S+)/)?.[1]}`);
      socket.write(textFrame({
        type: "hello",
        protocolVersion: "agent-collab-v0.6",
        agentId: "vivi-agent",
        listenerInstanceId: parsed.searchParams.get("listener_instance_id"),
        readinessEpoch: 1,
        serverTime: 1
      }));
    });
  });
  await listen(websocket);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    websocket.close();
  });

  const child = spawn(process.execPath, [resolve(repoRoot, "scripts/listener.mjs"), "--env", join(root, "missing.env")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTRELAY_BASE_URL: `http://127.0.0.1:${api.address().port}/agentrelay/api`,
      AGENTRELAY_WS_URL: `ws://127.0.0.1:${websocket.address().port}/agentrelay/api`,
      AGENTRELAY_AGENT_ID: "vivi-agent",
      AGENTRELAY_USERNAME: "vivi",
      AGENTRELAY_TOKEN: "test-token",
      AGENTRELAY_PROTOCOL_VERSION: "agent-collab-v0.6",
      AGENTRELAY_INBOX_DIR: join(root, "inbox"),
      AGENTRELAY_STATE_DIR: join(root, "state"),
      AGENTRELAY_LISTENER_STATUS_PATH: statusPath,
      AGENTRELAY_LISTENER_HOOK: `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(repoRoot, "scripts/agentrelay-inbox-intake.mjs"))}`,
      AGENTRELAY_ACK_ON_INBOX_RECEIVED: "1",
      AGENTRELAY_LISTENER_INACTIVITY_MS: "5000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill("SIGKILL"));

  await waitFor(async () => {
    if (acked.size !== 2 || !readiness.some((item) => item.ready === true)) return false;
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      return status.state === "connected" && status.lastRecovery?.total === 2;
    } catch {
      return false;
    }
  }, 5000, () => stderr);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.deepEqual(status.lastRecovery, {
    at: status.lastRecovery.at,
    total: 2,
    newTasks: 1,
    expiredWhileOffline: 1,
    failedWhileOffline: 0
  });
  assert.equal(status.pendingRemoteMessages, 0);
  assert.equal(status.relayReadiness, "fresh");
});

function v06TaskDetail(taskId, status, deliveryStatus, taskVersion) {
  return {
    task: {
      task_id: taskId,
      root_task_id: taskId,
      protocol_version: "agent-collab-v0.6",
      requester_agent_id: "zac-agent",
      target_agent_id: "vivi-agent",
      done_criteria: "recover offline event",
      status,
      current_message_id: "msg_v06",
      turn_sequence: 1,
      task_version: taskVersion,
      from_agent_id: "zac-agent",
      to_agent_id: "vivi-agent",
      max_turns: 3,
      updated_at: taskVersion
    },
    messages: [{
      message_id: "msg_v06",
      task_id: taskId,
      turn_sequence: 1,
      from_agent_id: "zac-agent",
      to_agent_id: "vivi-agent",
      delivery_status: deliveryStatus,
      parts: [{ kind: "text", text: "ping" }]
    }]
  };
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function textFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  assert.ok(body.length <= 0xffff);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

async function waitFor(predicate, timeoutMs, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for Listener recovery\n${diagnostics()}`);
}

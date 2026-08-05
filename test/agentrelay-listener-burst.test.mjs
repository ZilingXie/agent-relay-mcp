import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Listener buffers a burst while the first hook blocks and deduplicates recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-listener-burst-"));
  const stateRoot = join(root, "state");
  const inboxDir = join(root, "inbox");
  const statusPath = join(root, "listener-status.json");
  const hookLogPath = join(root, "hook.log");
  const hookPath = join(root, "blocking-hook.mjs");
  await writeFile(hookPath, `
import { appendFile, readFile } from "node:fs/promises";
import { processInboxEvent } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, "scripts/agentrelay-inbox-intake.mjs")).href)};

const eventPath = process.argv[2];
const logPath = process.env.TEST_HOOK_LOG;
const payload = JSON.parse(await readFile(eventPath, "utf8"));
const eventId = payload.event?.event_id || payload.event?.eventId || "missing";
const previous = await readFile(logPath, "utf8").catch(() => "");
await appendFile(logPath, eventId + "\\n");
if (!previous.trim()) await new Promise((resolve) => setTimeout(resolve, 5000));
const result = await processInboxEvent({ eventPath });
console.log(JSON.stringify(result));
if (result.ackRequired && !result.acked && !result.nacked) process.exitCode = 1;
`, { mode: 0o600 });

  const acked = new Set();
  const readiness = [];
  let eventsRequested = 0;
  const events = Array.from({ length: 20 }, (_, index) => ({
    event_id: `evt_burst_${index}`,
    event_type: "task.status_changed",
    protocol_version: "agent-collab-v0.6",
    task_id: "task_burst",
    message_id: `msg_burst_${index}`,
    can_transition_message: false,
    payload: { status: "expired" }
  }));
  const recoveryEvent = { ...events[0], event_id: "evt_recovery_0" };

  const api = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
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
      eventsRequested += 1;
      return sendJson(response, 200, {
        events: !acked.has(recoveryEvent.event_id) && eventsRequested <= 2 ? [recoveryEvent] : []
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/tasks/task_burst")) {
      return sendJson(response, 200, {
        task: {
          task_id: "task_burst",
          root_task_id: "task_burst",
          protocol_version: "agent-collab-v0.6",
          requester_agent_id: "zac-agent",
          target_agent_id: "vivi-agent",
          done_criteria: "burst delivery",
          status: "expired",
          current_message_id: "msg_burst_0",
          turn_sequence: 1,
          task_version: 1,
          updated_at: 1
        },
        messages: [{
          message_id: "msg_burst_0",
          task_id: "task_burst",
          turn_sequence: 1,
          from_agent_id: "zac-agent",
          to_agent_id: "vivi-agent",
          delivery_status: "pending",
          parts: [{ kind: "text", text: "burst" }]
        }]
      });
    }
    if (request.method === "POST" && url.pathname.includes("/messages/readiness-probe-") && url.pathname.endsWith("/ack")) {
      return sendJson(response, 503, { code: "mutations_closed" });
    }
    if (request.method === "POST" && url.pathname.includes("/messages/readiness-probe-") && url.pathname.endsWith("/delivery-fail")) {
      return sendJson(response, 503, { code: "mutations_closed" });
    }
    if (request.method === "POST" && url.pathname.match(/\/events\/[^/]+\/ack$/)) {
      const eventId = url.pathname.split("/").at(-2);
      acked.add(eventId);
      return sendJson(response, 200, {});
    }
    return sendJson(response, 404, { code: "not_found" });
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
      const query = new URL(`ws://127.0.0.1${header.match(/^GET\s+(\S+)/)?.[1]}`).searchParams;
      socket.write(textFrame({
        type: "hello",
        protocolVersion: "agent-collab-v0.6",
        agentId: "vivi-agent",
        listenerInstanceId: query.get("listener_instance_id"),
        readinessEpoch: 1,
        serverTime: 1
      }));
      for (const event of events) socket.write(textFrame({ ...event, type: "task.status_changed" }));
    });
  });
  await listen(websocket);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    websocket.close();
  });

  const listenerArgs = [resolve(repoRoot, "scripts/listener.mjs"), "--env", join(root, "missing.env")];
  const listenerEnv = {
    ...process.env,
    AGENTRELAY_BASE_URL: `http://127.0.0.1:${api.address().port}/agentrelay/api`,
    AGENTRELAY_WS_URL: `ws://127.0.0.1:${websocket.address().port}/agentrelay/api`,
    AGENTRELAY_AGENT_ID: "vivi-agent",
    AGENTRELAY_USERNAME: "vivi",
    AGENTRELAY_TOKEN: "test-token",
    AGENTRELAY_LISTENER_LANE_CHILD: "1",
    AGENTRELAY_PROTOCOL_VERSION: "agent-collab-v0.6",
    AGENTRELAY_INBOX_DIR: inboxDir,
    AGENTRELAY_STATE_DIR: stateRoot,
    AGENTRELAY_PROJECT_PATH: root,
    AGENTRELAY_LISTENER_STATUS_PATH: statusPath,
    AGENTRELAY_LISTENER_HOOK: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`,
    AGENTRELAY_LISTENER_FRAME_QUEUE_MAX: "4",
    AGENTRELAY_LISTENER_HOOK_QUEUE_MAX: "4",
    AGENTRELAY_ACK_ON_INBOX_RECEIVED: "1",
    AGENTRELAY_LISTENER_INACTIVITY_MS: "30000",
    AGENTRELAY_RECONCILE_INTERVAL_MS: "30000",
    TEST_HOOK_LOG: hookLogPath
  };
  const spawnListener = () => spawn(process.execPath, listenerArgs, {
    cwd: repoRoot,
    env: listenerEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const child = spawnListener();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill("SIGKILL"));

  await waitFor(async () => {
    if (acked.size !== events.length || !readiness.some((item) => item.ready === true)) return false;
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      return status.hook?.succeeded === events.length && status.queue?.depth === 0 && status.reader?.framesReceived >= events.length;
    } catch {
      return false;
    }
  }, 20000, () => stderr);

  const hookIds = (await readFile(hookLogPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(hookIds.length, events.length);
  assert.equal(new Set(hookIds).size, events.length);
  assert.equal(hookIds.includes("evt_recovery_0"), true);
  assert.equal(hookIds.includes("evt_burst_0"), false);
  assert.equal(acked.size, events.length);
  const eventFiles = (await readdir(inboxDir)).filter((name) => name.endsWith(".json"));
  assert.equal(eventFiles.length, events.length);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status.queue.depth, 0);
  assert.equal(status.reader.capacity, 4);
  assert.equal(status.reader.pauseCount > 0, true);
  assert.equal(status.reader.resumeCount > 0, true);
  assert.equal(status.hook.failed, 0);
  assert.equal(status.lastAck.status, "received");

  const firstStartedAt = status.startedAt;
  const deliveryIndex = JSON.parse(await readFile(`${statusPath}.delivery-index.json`, "utf8"));
  assert.equal(deliveryIndex.deliveries.length, events.length);

  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));

  const restarted = spawnListener();
  let restartedStderr = "";
  restarted.stderr.on("data", (chunk) => { restartedStderr += chunk.toString(); });
  t.after(() => restarted.kill("SIGKILL"));
  await waitFor(async () => {
    try {
      const restartedStatus = JSON.parse(await readFile(statusPath, "utf8"));
      return restartedStatus.startedAt !== firstStartedAt
        && restartedStatus.reader?.framesReceived >= events.length
        && restartedStatus.queue?.depth === 0
        && restartedStatus.hook?.total === 0;
    } catch {
      return false;
    }
  }, 20000, () => restartedStderr);
  const hookIdsAfterRestart = (await readFile(hookLogPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(hookIdsAfterRestart.length, events.length);
});

function textFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  assert(payload.length <= 0xffff);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
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

async function waitFor(predicate, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs;
  let lastContext = "";
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  lastContext = typeof context === "function" ? context() : "";
  throw new Error(`Timed out waiting for Listener burst acceptance${lastContext ? `\n${lastContext}` : ""}`);
}

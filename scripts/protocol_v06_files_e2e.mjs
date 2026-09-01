#!/usr/bin/env node

// End-to-end file-transfer check: boots the local agentRelay Server (v0.6 lane,
// small AGENTRELAY_MAX_FILE_BYTES) and drives the real client intake pipeline,
// the files-client prepare/normalize/wire-substitution helpers, upload,
// download, and workspace materialization for both participants.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { processInboxEvent } from "./agentrelay-inbox-intake.mjs";
import {
  normalizeReplyFileParts,
  resolveReplyWireParts,
  safeFileName,
  writeDownloadedFile
} from "./agentrelay-files-client.mjs";

const serverRoot = [
  process.env.AGENTRELAY_SERVER_REPO,
  "../agentRelay"
].filter(Boolean).map((candidate) => resolve(candidate)).find((candidate) => (
  existsSync(join(candidate, "server", "app.py"))
));
if (!serverRoot) throw new Error("Set AGENTRELAY_SERVER_REPO to the agentRelay Server checkout");
const root = await mkdtemp(join(tmpdir(), "agentrelay-v06-files-e2e-"));
const dbPath = join(root, "v06.sqlite3");
const legacyDbPath = join(root, "legacy.sqlite3");
const filesDbPath = join(root, "files.sqlite3");
const blobsDir = join(root, "blobs");
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}/agentrelay/api`;
const maxFileBytes = 65536;
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
    AGENTRELAY_V06_DB_PATH: dbPath,
    AGENTRELAY_FILES_DB_PATH: filesDbPath,
    AGENTRELAY_BLOBS_DIR: blobsDir,
    AGENTRELAY_MAX_FILE_BYTES: String(maxFileBytes),
    AGENTRELAY_MUTATION_MODE: "v06",
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
    protocol_version: "agent-collab-v0.6",
    idempotency_key: "files-e2e-create",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    done_criteria: "frank receives the attached log",
    message: { subject: "Files e2e", parts: [{ kind: "text", text: "log incoming after your ack" }] }
  });
  const taskId = created.task.task_id;

  // Initial messages cannot carry file parts.
  await assert.rejects(
    request("zac-agent", "POST", "/tasks", {
      protocol_version: "agent-collab-v0.6",
      idempotency_key: "files-e2e-create-with-file",
      requester_agent_id: "zac-agent",
      target_agent_id: "frank-agent",
      done_criteria: "x",
      message: {
        subject: "Files e2e",
        parts: [{ kind: "file", file_id: "file_0123456789abcdef0123456789abcdef", name: "a", size_bytes: 1, sha256: "0".repeat(64) }]
      }
    }),
    /400/
  );

  // Frank ACKs through the real client intake pipeline, then takes the turn.
  await intakeRecovered("frank-agent", listeners["frank-agent"], taskId);
  let detail = await request("frank-agent", "GET", `/tasks/${taskId}`);
  await request("frank-agent", "POST", `/tasks/${taskId}/messages`, {
    actor_agent_id: "frank-agent",
    message_id: detail.task.current_message_id,
    turn_sequence: detail.task.turn_sequence,
    expected_task_version: detail.task.task_version,
    idempotency_key: "files-e2e-ready",
    parts: [{ kind: "text", text: "ready for the file" }]
  });
  await intakeRecovered("zac-agent", listeners["zac-agent"], taskId);

  // Zac's guarded reply: prepare binds the exact content, then the post-approval
  // step uploads and substitutes the wire part.
  const payload = Buffer.from("agentrelay v0.6 file e2e payload\n");
  const localPath = join(root, "investigation.log");
  await writeFile(localPath, payload);
  const normalized = await normalizeReplyFileParts({
    parts: [
      { kind: "text", text: "here is the log" },
      { kind: "file", localPath, name: "investigation.log", mimeType: "text/plain" }
    ]
  });
  const filePart = normalized.parts[1];
  assert.equal(filePart.size_bytes, payload.length);
  assert.match(filePart.sha256, /^[a-f0-9]{64}$/);

  // A changed local file aborts before upload (approved size no longer matches).
  await writeFile(localPath, "mutated after approval");
  await assert.rejects(
    resolveReplyWireParts({ parts: normalized.parts, uploadFile: (file) => uploadFile("zac-agent", taskId, file) }),
    (error) => error.code === "FILE_CHANGED"
  );
  await writeFile(localPath, payload);

  const wireParts = await resolveReplyWireParts({
    parts: normalized.parts,
    uploadFile: (file) => uploadFile("zac-agent", taskId, file)
  });
  assert.equal(wireParts[1].file_id.startsWith("file_"), true);
  assert.equal(wireParts[1].sha256, filePart.sha256);

  detail = await request("zac-agent", "GET", `/tasks/${taskId}`);
  const sent = await request("zac-agent", "POST", `/tasks/${taskId}/messages`, {
    actor_agent_id: "zac-agent",
    message_id: detail.task.current_message_id,
    turn_sequence: detail.task.turn_sequence,
    expected_task_version: detail.task.task_version,
    idempotency_key: "files-e2e-file-reply",
    parts: wireParts
  });
  const storedFilePart = sent.messages.at(-1).parts.find((part) => part.kind === "file");
  assert.equal(storedFilePart.file_id, wireParts[1].file_id);
  assert.equal(storedFilePart.size_bytes, payload.length);

  // Frank's intake materializes the file part into workspace v2.
  await intakeRecovered("frank-agent", listeners["frank-agent"], taskId);
  const frankWorkspace = join(root, "state-frank-agent", "collaboration-v2", "tasks", taskId);
  const messages = JSON.parse(await readFile(join(frankWorkspace, "messages.json"), "utf8"));
  assert.equal(
    messages.some((message) => (message.parts || []).some((part) => part.kind === "file" && part.file_id === wireParts[1].file_id)),
    true
  );
  const context = await readFile(join(frankWorkspace, "context.md"), "utf8");
  assert.match(context, /## Attachments \(1\)/);
  assert.match(context, /investigation\.log/);

  // Frank downloads: metadata list, bytes, sha verification, workspace files dir.
  const listed = await request("frank-agent", "GET", `/tasks/${taskId}/files`);
  const metadata = listed.files.find((item) => item.file_id === wireParts[1].file_id);
  assert.equal(metadata.referenced_at !== null, true);
  const downloaded = await downloadFile("frank-agent", taskId, metadata.file_id);
  assert.equal(downloaded.sha256, filePart.sha256);
  assert.equal(downloaded.bytes.equals(payload), true);
  const savedPath = join(frankWorkspace, "files", `${metadata.file_id}__${safeFileName(metadata.name)}`);
  await writeDownloadedFile({ targetPath: savedPath, bytes: downloaded.bytes });
  assert.equal((await readFile(savedPath, "utf8")), payload.toString("utf8"));
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);

  // Oversize uploads are rejected by the relay cap.
  await assert.rejects(
    uploadFile("zac-agent", taskId, {
      localPath,
      name: "big.bin",
      mimeType: "application/octet-stream",
      sizeBytes: maxFileBytes + 1,
      sha256: filePart.sha256
    }, Buffer.alloc(maxFileBytes + 1)),
    (error) => error.statusCode === 413
  );

  console.log(JSON.stringify({ ok: true, taskId, fileId: wireParts[1].file_id }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
}

async function uploadFile(agentId, taskId, { localPath, name, mimeType, sizeBytes, sha256 }, bodyOverride) {
  const body = bodyOverride ?? await readFile(localPath);
  if (body.length !== sizeBytes) {
    const error = new Error(`local file changed since approval: ${localPath}; prepare the reply again`);
    error.code = "FILE_CHANGED";
    throw error;
  }
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/files`, {
    method: "POST",
    headers: {
      ...headers(agentId),
      "Content-Type": mimeType || "application/octet-stream",
      "X-AgentRelay-File-Name": encodeURIComponent(name || "file"),
      "X-AgentRelay-File-Sha256": sha256
    },
    body
  });
  const data = JSON.parse(await response.text());
  if (!response.ok) {
    const error = new Error(`upload failed (${response.status}): ${JSON.stringify(data)}`);
    error.statusCode = response.status;
    error.code = data?.error?.code || data?.code || "";
    throw error;
  }
  return data.file;
}

async function downloadFile(agentId, taskId, fileId) {
  const response = await fetch(
    `${baseUrl}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`,
    { headers: headers(agentId) }
  );
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const { createHash } = await import("node:crypto");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function intakeRecovered(agentId, listener, taskId) {
  const query = new URLSearchParams({
    listener_instance_id: listener.instanceId,
    readiness_epoch: String(listener.epoch)
  });
  const recovered = await request(agentId, "GET", `/workers/${agentId}/events?${query}`);
  assert.equal(recovered.events.length, 1);
  const event = recovered.events[0];
  assert.equal(event.task_id, taskId);
  const eventPath = join(root, `${event.event_id}.json`);
  await writeFile(eventPath, JSON.stringify({ event: {
    ...event,
    eventId: event.event_id,
    type: event.event_type,
    protocolVersion: "agent-collab-v0.6",
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
  const instanceId = `files-e2e-${agentId}`;
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

function headers(agentId) {
  const identity = agents[agentId];
  return {
    Authorization: `Bearer ${identity.token}`,
    "X-AgentRelay-Agent-Id": agentId,
    "X-AgentRelay-Username": identity.username
  };
}

async function request(agentId, method, path, payload) {
  const identity = agents[agentId];
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers(agentId), ...(identity.extra || {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = JSON.parse(await response.text());
  if (!response.ok) {
    const error = new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function seedServer() {
  const code = [
    "import sys",
    "from server.store_v06 import V06Store",
    "s=V06Store(sys.argv[1])",
    "[s.upsert_agent(a,name=a,owner=a,enabled=True,protocol_capabilities=['agent-collab-v0.6']) for a in ('zac-agent','frank-agent')]"
  ].join(";");
  const seeded = spawnSync("python3", ["-c", code, dbPath], { cwd: serverRoot, encoding: "utf8" });
  if (seeded.status !== 0) throw new Error(`Failed to seed v0.6 Server: ${seeded.error?.message || seeded.stderr || "unknown error"}`);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("v0.6 Server did not become healthy");
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

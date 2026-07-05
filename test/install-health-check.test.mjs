import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runInstallHealthCheck } from "../scripts/install-health-check.mjs";

test("install health check creates loopback task, waits for local inbox, and closes", async () => {
  const root = await makeTempState();
  const server = await startFakeRelay({
    stateRoot: root.stateRoot,
    ackText: ({ taskId }) => [
      "ACK from agentrelay-healthcheck",
      "requester=zac-agent",
      `task=${taskId}`,
      "scope=agentrelay-install-loopback"
    ].join("\n")
  });
  try {
    const result = await runInstallHealthCheck({
      env: testEnv(server.url, root.stateRoot),
      stateDir: root.stateRoot,
      timeoutMs: 1000,
      pollMs: 10,
      log: () => {}
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.match(result.ack, /ACK from agentrelay-healthcheck/);
    assert.equal(server.state.closed, true);
    assert.equal(server.state.createPayload.requester_agent_id, undefined);
    assert.equal(server.state.closePayload.closed_by_agent_id, "zac-agent");
  } finally {
    await server.close();
  }
});

test("install health check fails when ACK artifact is incomplete", async () => {
  const root = await makeTempState();
  const server = await startFakeRelay({
    stateRoot: root.stateRoot,
    ackText: () => "ACK from agentrelay-healthcheck\nrequester=someone-else"
  });
  try {
    await assert.rejects(
      () => runInstallHealthCheck({
        env: testEnv(server.url, root.stateRoot),
        stateDir: root.stateRoot,
        timeoutMs: 1000,
        pollMs: 10,
        log: () => {}
      }),
      /missing requester=zac-agent/
    );
    assert.equal(server.state.closed, false);
  } finally {
    await server.close();
  }
});

test("install health check fails when local inbox does not record the task", async () => {
  const root = await makeTempState();
  const server = await startFakeRelay({
    stateRoot: root.stateRoot,
    writeInbox: false,
    ackText: ({ taskId }) => `ACK from agentrelay-healthcheck\nrequester=zac-agent\ntask=${taskId}`
  });
  try {
    await assert.rejects(
      () => runInstallHealthCheck({
        env: testEnv(server.url, root.stateRoot),
        stateDir: root.stateRoot,
        timeoutMs: 30,
        pollMs: 5,
        log: () => {}
      }),
      /Timed out waiting/
    );
    assert.equal(server.state.closed, false);
  } finally {
    await server.close();
  }
});

test("install health check fails when close fails", async () => {
  const root = await makeTempState();
  const server = await startFakeRelay({
    stateRoot: root.stateRoot,
    closeStatus: 500,
    ackText: ({ taskId }) => `ACK from agentrelay-healthcheck\nrequester=zac-agent\ntask=${taskId}`
  });
  try {
    await assert.rejects(
      () => runInstallHealthCheck({
        env: testEnv(server.url, root.stateRoot),
        stateDir: root.stateRoot,
        timeoutMs: 1000,
        pollMs: 10,
        log: () => {}
      }),
      /POST .*close failed/
    );
  } finally {
    await server.close();
  }
});

async function makeTempState() {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "agentrelay-install-health-")));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "issues.json"), JSON.stringify({ version: 1, issues: {}, events: {} }, null, 2));
  return { root, stateRoot };
}

function testEnv(baseUrl, stateRoot) {
  return {
    AGENTRELAY_BASE_URL: baseUrl,
    AGENTRELAY_AGENT_ID: "zac-agent",
    AGENTRELAY_USERNAME: "zac",
    AGENTRELAY_TOKEN: "zac-token",
    AGENTRELAY_STATE_DIR: stateRoot,
    AGENTRELAY_INBOX_UI_HOST: "127.0.0.1",
    AGENTRELAY_INBOX_UI_PORT: "8787"
  };
}

function startFakeRelay({ stateRoot, ackText, writeInbox = true, closeStatus = 200 }) {
  const state = {
    closed: false,
    createPayload: null,
    closePayload: null
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const payload = await readJson(request);
      assert.equal(request.headers.authorization, "Bearer zac-token");
      assert.equal(request.headers["x-agentrelay-agent-id"], "zac-agent");
      assert.equal(request.headers["x-agentrelay-username"], "zac");

      if (request.method === "POST" && url.pathname === "/agentrelay/api/healthchecks/install") {
        state.createPayload = payload;
        const taskId = "task_install_health_fake";
        const text = ackText({ taskId });
        const task = {
          task_id: taskId,
          status: "delivery_pending",
          requester_agent_id: "zac-agent",
          target_agent_id: "agentrelay-healthcheck",
          completion_owner_agent_id: "zac-agent",
          pending_on_agent_id: "zac-agent",
          artifacts: [{
            artifact_id: "art_install_health_fake",
            from_agent_id: "agentrelay-healthcheck",
            to_agent_id: "zac-agent",
            kind: "install_health_ack",
            parts: [{ kind: "text", text }]
          }]
        };
        if (writeInbox) {
          await writeFile(join(stateRoot, "issues.json"), JSON.stringify({
            version: 1,
            issues: {
              [taskId]: {
                taskId,
                subject: "AgentRelay install loopback health check",
                requesterAgentId: "zac-agent",
                targetAgentId: "agentrelay-healthcheck",
                pendingOnAgentId: "zac-agent",
                localWorkflowBinding: {
                  type: "local_inbox",
                  workflow: "agentrelay_local_inbox",
                  bindingId: `local-inbox:${taskId}`,
                  issueId: taskId,
                  taskId,
                  statePath: join(stateRoot, "issues.json"),
                  projectPath: stateRoot,
                  lastEventId: "aevt_install_health_fake",
                  userOwnedAdapter: true
                }
              }
            },
            events: {}
          }, null, 2));
        }
        return sendJson(response, { task, ack: { text } }, 201);
      }

      if (request.method === "POST" && url.pathname === "/agentrelay/api/tasks/task_install_health_fake/close") {
        state.closePayload = payload;
        if (closeStatus !== 200) {
          return sendJson(response, { error: "close failed" }, closeStatus);
        }
        state.closed = true;
        return sendJson(response, { task: { task_id: "task_install_health_fake", status: "completed" } });
      }

      return sendJson(response, { error: "not found" }, 404);
    } catch (error) {
      return sendJson(response, { error: error.message }, 500);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}/agentrelay/api`,
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        })
      });
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

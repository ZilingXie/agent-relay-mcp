import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAppServerClient, deliverEvent, enqueueEvent } from "../scripts/agentrelay-thread-adapter.mjs";

const PROJECT_PATH = "/tmp/agentrelay-project/agentInbox";

test("enqueueEvent writes a durable queue job for the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const eventPath = await writeEvent(root, samplePayload());
  const stateRoot = join(root, "state");

  const result = await enqueueEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    now: () => "2026-06-26T12:00:00.000Z"
  });

  assert.equal(result.status, "queued");
  assert.equal(result.eventId, "evt_demo_123");
  assert.equal(result.taskId, "task_demo_123");
  const job = JSON.parse(await readFile(result.queuePath, "utf8"));
  assert.equal(job.eventPath, eventPath);
  assert.equal(job.attempts, 0);
});

test("creates a Codex thread for an unbound target-side task and records Relay bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const eventPath = await writeEvent(root, samplePayload());
  const app = fakeAppClient({ nextThreadId: "thread-new-1" });
  const relay = fakeRelayClient();
  const stateRoot = join(root, "state");

  const result = await deliverEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: app,
    relayClient: relay,
    now: () => "2026-06-26T12:00:00.000Z"
  });

  assert.equal(result.status, "delivered");
  assert.equal(result.threadId, "thread-new-1");
  assert.equal(app.startedThreads.length, 1);
  assert.equal(app.startedThreads[0].cwd, PROJECT_PATH);
  assert.deepEqual(app.startedThreads[0].runtimeWorkspaceRoots, [PROJECT_PATH]);
  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0].threadId, "thread-new-1");
  assert.match(app.turns[0].input[0].text, /task_demo_123/);
  assert.match(app.turns[0].input[0].text, /需要 Zac 确认/);
  assert.match(app.turns[0].input[0].text, /不要自动提交 artifact/);
  assert.deepEqual(relay.acks, [{
    agentId: "zac-agent",
    eventId: "evt_demo_123",
    taskId: "task_demo_123",
    status: "delivered",
    threadId: "thread-new-1",
    threadRole: "target",
    projectPath: PROJECT_PATH
  }]);
  assert.deepEqual(relay.targetThreads, [{
    agentId: "zac-agent",
    taskId: "task_demo_123",
    threadId: "thread-new-1"
  }]);

  const bindings = JSON.parse(await readFile(join(stateRoot, "bindings.json"), "utf8"));
  assert.equal(bindings.tasks.task_demo_123.threadId, "thread-new-1");
  assert.equal(bindings.events.evt_demo_123.status, "delivered");
});

test("reuses an existing binding for later events on the same task", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "bindings.json"), JSON.stringify({
    version: 1,
    tasks: {
      task_demo_123: {
        taskId: "task_demo_123",
        threadId: "thread-existing",
        threadRole: "target",
        projectPath: PROJECT_PATH
      }
    },
    events: {}
  }, null, 2));
  const eventPath = await writeEvent(root, samplePayload({ eventId: "evt_followup_456" }));
  const app = fakeAppClient({ nextThreadId: "thread-should-not-be-used" });

  const result = await deliverEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: app,
    relayClient: fakeRelayClient(),
    now: () => "2026-06-26T12:00:00.000Z"
  });

  assert.equal(result.status, "delivered");
  assert.equal(result.threadId, "thread-existing");
  assert.equal(app.startedThreads.length, 0);
  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0].threadId, "thread-existing");
});

test("falls back to a new inbox thread when an attached thread cannot be found", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const eventPath = await writeEvent(root, samplePayload({
    requesterAgentId: "zac-agent",
    targetAgentId: "vivi-agent",
    completionOwnerAgentId: "zac-agent",
    requesterThreadId: "missing-requester-thread"
  }));
  const app = {
    turns: [],
    started: [],
    async startTurn(params) {
      this.turns.push(params);
      throw new Error('turn/start failed: {"code":-32600,"message":"thread not found: missing-requester-thread"}');
    },
    async startThreadAndTurn(threadParams, turnParams) {
      this.started.push({ threadParams, turnParams });
      return {
        startResponse: { thread: { id: "fallback-thread" } },
        turnResponse: { turn: { id: "fallback-turn" } }
      };
    }
  };

  const result = await deliverEvent({
    eventPath,
    stateRoot: join(root, "state"),
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: app,
    relayClient: fakeRelayClient()
  });

  assert.equal(result.status, "delivered");
  assert.equal(result.threadId, "fallback-thread");
  assert.equal(app.turns.length, 1);
  assert.equal(app.started.length, 1);
  assert.match(app.started[0].turnParams.input[0].text, /Attached thread delivery failed/);
  assert.match(app.started[0].turnParams.input[0].text, /missing-requester-thread/);
});

test("skips duplicate events without creating another turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "bindings.json"), JSON.stringify({
    version: 1,
    tasks: {},
    events: {
      evt_demo_123: {
        eventId: "evt_demo_123",
        taskId: "task_demo_123",
        status: "delivered",
        threadId: "thread-existing"
      }
    }
  }, null, 2));
  const eventPath = await writeEvent(root, samplePayload());
  const app = fakeAppClient({ nextThreadId: "thread-should-not-be-used" });

  const result = await deliverEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: app,
    relayClient: fakeRelayClient()
  });

  assert.equal(result.status, "duplicate");
  assert.equal(app.startedThreads.length, 0);
  assert.equal(app.turns.length, 0);
});

test("logs delivery failures without acking the Relay event", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const eventPath = await writeEvent(root, samplePayload());
  const relay = fakeRelayClient();
  const stateRoot = join(root, "state");

  const result = await deliverEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: {
      async startThread() {
        throw new Error("app server unavailable");
      }
    },
    relayClient: relay
  });

  assert.equal(result.status, "failed");
  assert.equal(relay.acks.length, 0);
  const errors = await readFile(join(stateRoot, "adapter-errors.jsonl"), "utf8");
  assert.match(errors, /app server unavailable/);
  assert.match(errors, /evt_demo_123/);
});

test("does not ack Relay when the created Codex thread is not visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-adapter-"));
  const eventPath = await writeEvent(root, samplePayload());
  const relay = fakeRelayClient();
  const stateRoot = join(root, "state");
  const app = fakeAppClient({ nextThreadId: "thread-invisible" });
  app.verifyThreadVisible = async () => {
    throw new Error("Codex thread was not indexed in state DB: thread-invisible");
  };

  const result = await deliverEvent({
    eventPath,
    stateRoot,
    projectPath: PROJECT_PATH,
    agentId: "zac-agent",
    appClient: app,
    relayClient: relay
  });

  assert.equal(result.status, "failed");
  assert.equal(relay.acks.length, 0);
  const bindings = JSON.parse(await readFile(join(stateRoot, "bindings.json"), "utf8"));
  assert.equal(bindings.events.evt_demo_123.status, "failed");
  assert.match(bindings.events.evt_demo_123.error, /not indexed/);
});

test("Codex app client initializes the app-server connection before thread requests", async () => {
  const seen = [];
  const client = new CodexAppServerClient({
    codexCli: "/unused/codex",
    proxyRunner: async (_codexCli, messages) => {
      seen.push(...messages);
      return [
        { id: 0, result: { userAgent: "test" } },
        { id: 1, result: { thread: { id: "thread-from-proxy" } } }
      ];
    }
  });

  const result = await client.startThread({ cwd: PROJECT_PATH });

  assert.equal(result.thread.id, "thread-from-proxy");
  assert.equal(seen[0].method, "initialize");
  assert.equal(seen[0].id, 0);
  assert.deepEqual(seen[0].params.clientInfo, {
    name: "agentrelay_inbox_adapter",
    title: "AgentRelay Inbox Adapter",
    version: "0.1.0"
  });
  assert.deepEqual(seen[0].params.capabilities, { experimentalApi: true });
  assert.equal(seen[1].method, "initialized");
  assert.equal(seen[1].id, undefined);
  assert.equal(seen[2].method, "thread/start");
  assert.equal(seen[2].id, 1);
});

test("Codex app client can start a thread and first turn on one app-server connection", async () => {
  const seen = [];
  const client = new CodexAppServerClient({
    codexCli: "/unused/codex",
    proxyRunner: async (_codexCli, messages, onMessage, options) => {
      seen.push(...messages);
      assert.deepEqual([...options.expectedIds], [1, 2]);
      assert.equal(options.waitForUserMessageCommit, true);
      const startMessage = { id: 1, result: { thread: { id: "thread-one-connection" } } };
      await onMessage({
        message: startMessage,
        send: (message) => seen.push(message)
      });
      return [
        { id: 0, result: { userAgent: "test" } },
        startMessage,
        { id: 2, result: { turn: { id: "turn-one-connection" } } },
        {
          method: "item/completed",
          params: {
            turnId: "turn-one-connection",
            item: { type: "userMessage" }
          }
        }
      ];
    }
  });

  const result = await client.startThreadAndTurn(
    { cwd: PROJECT_PATH },
    { input: [{ type: "text", text: "hello", text_elements: [] }] }
  );

  assert.equal(result.startResponse.thread.id, "thread-one-connection");
  assert.equal(result.turnResponse.turn.id, "turn-one-connection");
  assert.equal(seen[2].method, "thread/start");
  assert.equal(seen[3].method, "turn/start");
  assert.equal(seen[3].params.threadId, "thread-one-connection");
});

async function writeEvent(root, payload) {
  const path = join(root, "event.json");
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

function samplePayload(overrides = {}) {
  const eventId = overrides.eventId || "evt_demo_123";
  const requesterAgentId = overrides.requesterAgentId || "vivi-agent";
  const targetAgentId = overrides.targetAgentId || "zac-agent";
  const completionOwnerAgentId = overrides.completionOwnerAgentId || "vivi-agent";
  const requesterThreadId = overrides.requesterThreadId || "vivi-origin-thread";
  return {
    receivedAt: "2026-06-26T11:59:00.000Z",
    event: {
      type: "task.pending",
      eventId,
      taskId: "task_demo_123",
      agentId: "zac-agent"
    },
    task: {
      task_id: "task_demo_123",
      subject: "约下周一项目进度会议",
      requester_agent_id: requesterAgentId,
      target_agent_id: targetAgentId,
      completion_owner_agent_id: completionOwnerAgentId,
      requester_thread_id: requesterThreadId,
      target_thread_id: null,
      pending_on_agent_id: "zac-agent",
      pending_on_human_id: null,
      status: "delivery_pending",
      next_action: "Zac 确认其中一个时间，或者提替代时间",
      done_criteria: "Zac 确认会议时间后由 Vivi 侧关闭 task。",
      updated_at: 1782465371,
      messages: [{
        role: "user",
        from_agent_id: "vivi-agent",
        to_agent_id: "zac-agent",
        parts: [{ kind: "text", text: "建议时间：2026-06-29 10:30-11:00；备选：16:00-16:30。" }]
      }],
      artifacts: []
    }
  };
}

function fakeAppClient({ nextThreadId }) {
  return {
    startedThreads: [],
    turns: [],
    async startThread(params) {
      this.startedThreads.push(params);
      return { thread: { id: nextThreadId } };
    },
    async startTurn(params) {
      this.turns.push(params);
      return { turn: { id: `turn-${this.turns.length}` } };
    }
  };
}

function fakeRelayClient() {
  return {
    acks: [],
    targetThreads: [],
    async ackEvent(params) {
      this.acks.push(params);
      return {};
    },
    async setTargetThread(params) {
      this.targetThreads.push(params);
      return {};
    }
  };
}

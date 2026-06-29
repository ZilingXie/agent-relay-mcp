import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { processNextJob } from "../scripts/agentrelay-thread-daemon.mjs";

test("processNextJob moves delivered jobs to queue-done", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-daemon-"));
  const dirs = await setupQueue(root, { eventId: "evt_done", eventPath: await writeEvent(root) });
  const appClient = fakeAppClient({ threadId: "thread-visible" });
  const originalAgentId = process.env.AGENTRELAY_AGENT_ID;
  const originalBaseUrl = process.env.AGENTRELAY_BASE_URL;
  process.env.AGENTRELAY_AGENT_ID = "test-agent";
  process.env.AGENTRELAY_BASE_URL = "http://relay.invalid";

  try {
    const processed = await processNextJob({
      queueRoot: dirs.queue,
      doneRoot: dirs.done,
      failedRoot: dirs.failed,
      stateRootOverride: dirs.state,
      projectPathOverride: root,
      appClientOverride: appClient,
      relayClientOverride: fakeRelayClient(),
      sleepFn: async () => {}
    });

    assert.equal(processed, true);
    assert.equal((await readdir(dirs.queue)).length, 0);
    assert.equal((await readdir(dirs.done)).length, 1);
  } finally {
    restoreEnv("AGENTRELAY_AGENT_ID", originalAgentId);
    restoreEnv("AGENTRELAY_BASE_URL", originalBaseUrl);
  }
});

test("processNextJob retries failed jobs before max attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-daemon-"));
  const dirs = await setupQueue(root, { eventId: "evt_retry", eventPath: await writeEvent(root) });
  const originalAgentId = process.env.AGENTRELAY_AGENT_ID;
  process.env.AGENTRELAY_AGENT_ID = "test-agent";

  try {
    const processed = await processNextJob({
      queueRoot: dirs.queue,
      doneRoot: dirs.done,
      failedRoot: dirs.failed,
      stateRootOverride: dirs.state,
      projectPathOverride: root,
      appClientOverride: { async startThreadAndTurn() { throw new Error("app unavailable"); } },
      sleepFn: async () => {}
    });

    assert.equal(processed, true);
    const names = await readdir(dirs.queue);
    assert.equal(names.length, 1);
    const job = JSON.parse(await readFile(join(dirs.queue, names[0]), "utf8"));
    assert.equal(job.attempts, 1);
    assert.match(job.lastError, /app unavailable/);
  } finally {
    if (originalAgentId === undefined) delete process.env.AGENTRELAY_AGENT_ID;
    else process.env.AGENTRELAY_AGENT_ID = originalAgentId;
  }
});

test("processNextJob dead-letters after max attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-daemon-"));
  const dirs = await setupQueue(root, { eventId: "evt_dead", eventPath: await writeEvent(root), attempts: 1 });
  const originalAgentId = process.env.AGENTRELAY_AGENT_ID;
  process.env.AGENTRELAY_AGENT_ID = "test-agent";

  try {
    const processed = await processNextJob({
      queueRoot: dirs.queue,
      doneRoot: dirs.done,
      failedRoot: dirs.failed,
      stateRootOverride: dirs.state,
      projectPathOverride: root,
      maxAttemptsOverride: 2,
      appClientOverride: { async startThreadAndTurn() { throw new Error("still unavailable"); } },
      sleepFn: async () => {}
    });

    assert.equal(processed, true);
    assert.equal((await readdir(dirs.queue)).length, 0);
    assert.equal((await readdir(dirs.failed)).length, 1);
  } finally {
    if (originalAgentId === undefined) delete process.env.AGENTRELAY_AGENT_ID;
    else process.env.AGENTRELAY_AGENT_ID = originalAgentId;
  }
});

async function setupQueue(root, job) {
  const state = join(root, "state");
  const queue = join(state, "queue");
  const done = join(state, "queue-done");
  const failed = join(state, "queue-failed");
  await mkdir(queue, { recursive: true });
  await writeFile(join(queue, `${job.eventId}.json`), JSON.stringify({
    version: 1,
    taskId: "task_demo_123",
    attempts: 0,
    ...job
  }, null, 2));
  return { state, queue, done, failed };
}

async function writeEvent(root) {
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    receivedAt: "2026-06-29T00:00:00.000Z",
    event: { type: "task.pending", eventId: "evt_demo_123", taskId: "task_demo_123" },
    task: {
      task_id: "task_demo_123",
      target_agent_id: "test-agent",
      pending_on_agent_id: "test-agent",
      requester_agent_id: "sender-agent",
      completion_owner_agent_id: "sender-agent",
      status: "delivery_pending",
      messages: []
    }
  }, null, 2));
  return eventPath;
}

function fakeAppClient({ threadId }) {
  return {
    async startThreadAndTurn() {
      return {
        startResponse: { thread: { id: threadId } },
        turnResponse: { turn: { id: "turn-visible" } }
      };
    },
    async verifyThreadVisible() {
      return {};
    }
  };
}

function fakeRelayClient() {
  return {
    async ackEvent() {
      return {};
    },
    async setTargetThread() {
      return {};
    }
  };
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

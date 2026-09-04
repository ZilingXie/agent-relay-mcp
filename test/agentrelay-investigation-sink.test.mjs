import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InvestigationDurableSink } from "../scripts/agentrelay-investigation-sink.mjs";

test("Investigation durable sink uses stdin and verifies correlated persistence receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-investigation-sink-"));
  const executable = join(root, "sink.mjs");
  await writeFile(executable, `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
console.log(JSON.stringify({
  ok: true,
  event_id: payload.eventId,
  task_id: payload.taskId,
  event_persisted: true,
  snapshot_persisted: payload.phase === "persist-snapshot"
}));
`);
  await chmod(executable, 0o700);
  const sink = new InvestigationDurableSink({ executable });
  const input = {
    eventPath: join(root, "event.json"),
    eventId: "evt_one",
    taskId: "task_one",
    agentId: "project-hermes",
    event: { event: { eventId: "evt_one" } }
  };
  const prepared = await sink.prepare(input);
  assert.equal(prepared.event_persisted, true);
  const persisted = await sink.persistSnapshot({
    ...input,
    authoritativeSnapshot: { task: { task_id: "task_one" } }
  });
  assert.equal(persisted.snapshot_persisted, true);
});

test("Investigation durable sink rejects mismatched receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-investigation-sink-bad-"));
  const executable = join(root, "sink.mjs");
  await writeFile(executable, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ ok: true, event_id: "evt_other", task_id: "task_one", event_persisted: true }));
`);
  await chmod(executable, 0o700);
  const sink = new InvestigationDurableSink({ executable });
  await assert.rejects(
    sink.prepare({ eventId: "evt_one", taskId: "task_one" }),
    { code: "INVESTIGATION_SINK_CORRELATION_MISMATCH" }
  );
});

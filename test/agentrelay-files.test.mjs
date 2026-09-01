import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatFileSize,
  hasAnyFilePart,
  hashLocalFile,
  isLocalFilePart,
  isWireFilePart,
  normalizeReplyFileParts,
  rejectInitialFileParts,
  resolveReplyWireParts,
  safeFileName,
  writeDownloadedFile
} from "../scripts/agentrelay-files-client.mjs";
import {
  buildTaskContextMarkdown,
  persistTaskWorkspace,
  prepareLocalAction
} from "../scripts/agentrelay-task-workspace.mjs";
import { buildChatTimeline } from "../scripts/agentrelay-inbox-ui.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-files-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSampleFile(root, name, content = Buffer.from("file transfer payload\n")) {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

test("normalizeReplyFileParts enriches local file parts with sha256 and size", async () => {
  await withTempDir(async (root) => {
    const localPath = await writeSampleFile(root, "report.log");
    const payload = {
      parts: [
        { kind: "text", text: "see attachment" },
        { kind: "file", localPath, name: "report.log", mimeType: "text/plain" }
      ]
    };
    const normalized = await normalizeReplyFileParts(payload);
    const filePart = normalized.parts[1];
    assert.equal(filePart.kind, "file");
    assert.equal(filePart.local_path, localPath);
    assert.equal(filePart.name, "report.log");
    assert.equal(filePart.mime_type, "text/plain");
    assert.equal(filePart.size_bytes, 22);
    assert.equal(filePart.sha256, sha256(Buffer.from("file transfer payload\n")));
    assert.equal(isLocalFilePart(payload.parts[1]), true);
    assert.equal(isWireFilePart(normalized.parts[1]), false);
    // Non-file parts pass through untouched.
    assert.deepEqual(normalized.parts[0], payload.parts[0]);
  });
});

test("normalizeReplyFileParts defaults the name from the file basename", async () => {
  await withTempDir(async (root) => {
    const localPath = await writeSampleFile(root, "auto-name.bin");
    const normalized = await normalizeReplyFileParts({ parts: [{ kind: "file", localPath }] });
    assert.equal(normalized.parts[0].name, "auto-name.bin");
  });
});

test("normalizeReplyFileParts rejects invalid, missing, and empty local files", async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      normalizeReplyFileParts({ parts: [{ kind: "file", name: "x" }] }),
      /localPath/
    );
    await assert.rejects(
      normalizeReplyFileParts({ parts: [{ kind: "file", localPath: join(root, "missing.bin") }] }),
      (error) => error.code === "FILE_UNREADABLE"
    );
    const emptyPath = join(root, "empty.bin");
    await writeFile(emptyPath, "");
    await assert.rejects(
      normalizeReplyFileParts({ parts: [{ kind: "file", localPath: emptyPath }] }),
      (error) => error.code === "FILE_EMPTY"
    );
    await assert.rejects(
      normalizeReplyFileParts({ parts: [{ kind: "file", localPath: await writeSampleFile(root, "n"), name: "x".repeat(256) }] }),
      (error) => error.code === "FILE_PART_INVALID"
    );
  });
});

test("resolveReplyWireParts uploads local parts and keeps wire parts untouched", async () => {
  await withTempDir(async (root) => {
    const localPath = await writeSampleFile(root, "a.bin");
    const content = Buffer.from("file transfer payload\n");
    const uploaded = [];
    const parts = await resolveReplyWireParts({
      parts: [
        { kind: "text", text: "text part" },
        { kind: "file", local_path: localPath, name: "a.bin", size_bytes: content.length, sha256: sha256(content) }
      ],
      uploadFile: async (file) => {
        uploaded.push(file);
        return { file_id: "file_0123456789abcdef0123456789abcdef", deduplicated: false };
      }
    });
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].sha256, sha256(content));
    assert.deepEqual(parts[0], { kind: "text", text: "text part" });
    assert.equal(isWireFilePart(parts[1]), true);
    assert.equal(parts[1].file_id, "file_0123456789abcdef0123456789abcdef");
    assert.equal(parts[1].size_bytes, content.length);

    const wireOnly = [
      { kind: "text", text: "t" },
      { kind: "file", file_id: "file_ffffffffffffffffffffffffffffffff", name: "b", size_bytes: 1, sha256: sha256("x") }
    ];
    const unchanged = await resolveReplyWireParts({ parts: wireOnly, uploadFile: async () => assert.fail("must not upload") });
    assert.equal(unchanged, wireOnly);
  });
});

test("rejectInitialFileParts blocks file parts in create and follow-up initial messages", () => {
  assert.doesNotThrow(() => rejectInitialFileParts({ subject: "s", parts: [{ kind: "text", text: "t" }] }));
  assert.throws(
    () => rejectInitialFileParts({
      subject: "s",
      parts: [{ kind: "file", file_id: "file_0123456789abcdef0123456789abcdef", name: "a", size_bytes: 1, sha256: sha256("x") }]
    }),
    (error) => error.code === "FILE_PART_UNSUPPORTED_HERE" && /reply with the file part/.test(error.message)
  );
});

test("safeFileName and formatFileSize behave for display-only names", () => {
  assert.equal(safeFileName("report/../evil name.txt"), "report_.._evil_name.txt".slice(0, 80));
  assert.equal(safeFileName("中文名.txt"), "_.txt");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName("..."), "file");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(3 * 1024 * 1024), "3.0 MB");
});

test("writeDownloadedFile writes atomically with 0600 permissions", async () => {
  await withTempDir(async (root) => {
    const targetPath = join(root, "files", "file_ab__name.bin");
    const written = await writeDownloadedFile({ targetPath, bytes: Buffer.from("downloaded") });
    assert.equal(written, targetPath);
    assert.equal(await readFile(targetPath, "utf8"), "downloaded");
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  });
});

test("prepareLocalAction stores the enriched file part so the payload hash binds content", async () => {
  await withTempDir(async (root) => {
    const stateRoot = join(root, "state");
    const localPath = await writeSampleFile(root, "pinned.log");
    const task = {
      task_id: "task_files_prepare",
      protocol_version: "agent-collab-v0.6",
      root_task_id: "task_files_prepare",
      requester_agent_id: "zac-agent",
      target_agent_id: "frank-agent",
      status: "open",
      current_message_id: "msg_1",
      turn_sequence: 1,
      task_version: 1,
      from_agent_id: "frank-agent",
      to_agent_id: "zac-agent",
      done_criteria: "send the file",
      messages: [{ message_id: "msg_1", from_agent_id: "frank-agent", to_agent_id: "zac-agent", parts: [{ kind: "text", text: "please send" }] }],
      artifacts: []
    };
    await persistTaskWorkspace({ stateRoot, task, localAgentId: "zac-agent", source: "test", syncedAt: "2026-09-01T00:00:00.000Z" });

    const { action } = await prepareLocalAction({
      stateRoot,
      taskId: task.task_id,
      actionType: "reply",
      payload: { parts: [{ kind: "file", localPath, name: "pinned.log" }] }
    });
    const storedPart = action.payload.parts[0];
    assert.equal(storedPart.local_path, localPath);
    assert.equal(storedPart.sha256, sha256(Buffer.from("file transfer payload\n")));

    // Same args after the file changed hash differently: the existing
    // ACTION_PAYLOAD_CHANGED guard rejects instead of uploading new content.
    await writeFile(localPath, "mutated content");
    const second = await prepareLocalAction({
      stateRoot,
      taskId: task.task_id,
      actionType: "reply",
      payload: { parts: [{ kind: "file", localPath, name: "pinned.log" }] }
    });
    assert.notEqual(second.action.payloadHash, action.payloadHash);

    // Initial follow-up messages cannot carry file parts at all.
    await assert.rejects(
      prepareLocalAction({
        stateRoot,
        taskId: task.task_id,
        actionType: "create_followup",
        payload: { message: { subject: "s", parts: [{ kind: "file", localPath, name: "pinned.log" }] }, doneCriteria: "x" }
      }),
      (error) => error.code === "FILE_PART_UNSUPPORTED_HERE"
    );
  });
});

test("buildTaskContextMarkdown renders an attachments section for file parts", () => {
  const filePart = {
    kind: "file",
    file_id: "file_0123456789abcdef0123456789abcdef",
    name: "investigation.log",
    mime_type: "text/plain",
    size_bytes: 2048,
    sha256: sha256("x")
  };
  const markdown = buildTaskContextMarkdown({
    task_id: "task_files_render",
    protocol_version: "agent-collab-v0.6",
    root_task_id: "task_files_render",
    requester_agent_id: "zac-agent",
    target_agent_id: "frank-agent",
    status: "open",
    current_message_id: "msg_2",
    turn_sequence: 2,
    task_version: 2,
    from_agent_id: "zac-agent",
    to_agent_id: "frank-agent",
    done_criteria: "x",
    messages: [
      { message_id: "msg_1", from_agent_id: "zac-agent", to_agent_id: "frank-agent", parts: [{ kind: "text", text: "hi" }] },
      { message_id: "msg_2", from_agent_id: "frank-agent", to_agent_id: "zac-agent", parts: [{ kind: "text", text: "log attached" }, filePart] }
    ],
    artifacts: []
  });
  assert.match(markdown, /## Attachments \(1\)/);
  assert.match(markdown, /Message 2: investigation\.log · 2048 bytes/);
  assert.match(markdown, /file_0123456789abcdef0123456789abcdef/);
  assert.match(markdown, /agentrelay_download_file/);
});

test("buildChatTimeline surfaces file attachments on relay messages", () => {
  const timeline = buildChatTimeline({
    issue: { taskId: "task_files_ui" },
    events: [{
      receivedAt: "2026-09-01T00:00:00.000Z",
      raw: {
        task: {
          task_id: "task_files_ui",
          messages: [{
            message_id: "msg_1",
            from_agent_id: "frank-agent",
            to_agent_id: "zac-agent",
            created_at: 1782000000,
            parts: [
              { kind: "text", text: "log attached" },
              { kind: "file", file_id: "file_0123456789abcdef0123456789abcdef", name: "app.log", size_bytes: 4096 }
            ]
          }]
        }
      }
    }],
    localAgentId: "zac-agent"
  });
  const message = timeline.find((item) => item.type === "relay_message");
  assert.equal(message.taskId, "task_files_ui");
  assert.deepEqual(message.files, [{ fileId: "file_0123456789abcdef0123456789abcdef", name: "app.log", sizeBytes: 4096 }]);
  assert.match(message.text, /\[文件: app\.log \(4\.0 KB\)\]/);
});

test("hasAnyFilePart and pattern guards cover wire and local shapes", () => {
  assert.equal(hasAnyFilePart([{ kind: "text", text: "t" }]), false);
  assert.equal(hasAnyFilePart([{ kind: "file", file_id: "file_x", name: "a", size_bytes: 1, sha256: sha256("x") }]), true);
  assert.equal(isWireFilePart({ kind: "file", file_id: "not-a-file-id" }), false);
  assert.equal(isLocalFilePart({ kind: "text", localPath: "/tmp/x" }), false);
});

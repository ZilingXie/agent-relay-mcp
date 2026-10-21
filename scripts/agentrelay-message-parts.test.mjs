import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  buildEnablementResultParts,
  validateEnablementResultText,
  validateReplyParts
} from "./agentrelay-message-parts.mjs";

const RESULT = {
  schema_version: "enablement-relay-result-v1",
  request_id: "enr-AC-14158-v1",
  outcome: "ownership_mismatch",
  write_attempted: false,
  detail: "Read-only Archer ownership verification did not match the request; no Archer write was attempted.",
  approval_ref: { action: "approve_execution", request_id: "enr-AC-14158-v1", request_version: 1 }
};

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

test("kind:text parts pass through unchanged", () => {
  const parts = [{ kind: "text", text: JSON.stringify(RESULT) }];
  assert.equal(validateReplyParts(parts), parts);
});

test("plain prose text parts are not treated as result JSON", () => {
  validateReplyParts([{ kind: "text", text: "hello { not json" }]);
  validateReplyParts([{ kind: "text", text: JSON.stringify({ schema_version: "other-v1", request_id: "" }) }]);
});

test("type:text is rejected (14158 regression)", () => {
  const error = expectCode(
    () => validateReplyParts([{ type: "text", text: JSON.stringify(RESULT) }]),
    "type_key_rejected"
  );
  // Sanitization: the error must not embed payload content.
  assert.ok(!error.message.includes("14158"));
  assert.ok(!error.message.includes("enr-"));
});

test("text without kind is rejected", () => {
  expectCode(() => validateReplyParts([{ text: JSON.stringify(RESULT) }]), "text_without_kind");
});

test("kind:text without non-empty string text is rejected", () => {
  expectCode(() => validateReplyParts([{ kind: "text", text: "" }]), "text_part_invalid");
  expectCode(() => validateReplyParts([{ kind: "text" }]), "text_part_invalid");
});

test("parts container shape is validated", () => {
  expectCode(() => validateReplyParts([]), "parts_invalid");
  expectCode(() => validateReplyParts("no"), "parts_invalid");
  expectCode(() => validateReplyParts([{}]), "parts_invalid");
});

test("file parts keep their existing capability", () => {
  validateReplyParts([
    { kind: "file", local_path: "/tmp/a.bin", name: "a.bin", size_bytes: 3, sha256: "00" },
    { kind: "text", text: "see attachment" }
  ]);
});

test("enablement result binding: missing or empty request_id rejected", () => {
  expectCode(
    () => validateEnablementResultText(JSON.stringify({ ...RESULT, request_id: "" })),
    "enablement_result_invalid"
  );
  expectCode(
    () => validateEnablementResultText(JSON.stringify({ ...RESULT, request_id: 42 })),
    "enablement_result_invalid"
  );
  expectCode(
    () => validateReplyParts([{ kind: "text", text: JSON.stringify({ ...RESULT, request_id: "" }) }]),
    "enablement_result_invalid"
  );
});

test("enablement result binding: outcome and write_attempted required", () => {
  expectCode(
    () => validateEnablementResultText(JSON.stringify({ ...RESULT, outcome: "" })),
    "enablement_outcome_invalid"
  );
  expectCode(
    () => validateEnablementResultText(JSON.stringify({ ...RESULT, write_attempted: "false" })),
    "enablement_write_attempted_invalid"
  );
});

test("builder produces canonical parts and validates the draft", async () => {
  const parts = buildEnablementResultParts(RESULT);
  assert.deepEqual(parts, { parts: [{ kind: "text", text: JSON.stringify(RESULT) }] });
  validateReplyParts(parts.parts);
  expectCode(() => buildEnablementResultParts({ ...RESULT, request_id: "" }), "enablement_result_invalid");
  expectCode(() => buildEnablementResultParts("nope"), "enablement_result_invalid");
});

test("CLI builder: canonical output for a valid draft and rejection for invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-result-"));
  const good = join(root, "result.json");
  await writeFile(good, JSON.stringify(RESULT, null, 2));
  const okRun = await runNode([resolve("scripts/agentrelay-build-result.mjs"), `--result=${good}`]);
  assert.equal(okRun.code, 0, okRun.stderr);
  assert.deepEqual(JSON.parse(okRun.stdout), { parts: [{ kind: "text", text: JSON.stringify(RESULT) }] });

  const bad = join(root, "bad.json");
  await writeFile(bad, JSON.stringify({ ...RESULT, request_id: "" }));
  const badRun = await runNode([resolve("scripts/agentrelay-build-result.mjs"), `--result=${bad}`]);
  assert.equal(badRun.code, 1);
  assert.match(badRun.stderr, /enablement_result_invalid/);
  // Sanitization: rejection text must not carry the payload or a path echo of secrets.
  assert.ok(!badRun.stderr.includes("enr-"));
});

function runNode(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

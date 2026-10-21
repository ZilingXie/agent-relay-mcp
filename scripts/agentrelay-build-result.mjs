#!/usr/bin/env node
// Canonical enablement-relay-result-v1 reply builder (C1/C2).
//
// Usage:
//   node scripts/agentrelay-build-result.mjs --result <result.json>
//
// Reads the approved result JSON object from a file, validates the
// enablement-relay-result-v1 binding (schema_version / request_id / outcome /
// write_attempted), and prints the exact reply parts payload
// {"parts":[{"kind":"text","text":"..."}]} for agentrelay_prepare_local_action.
// The result JSON is never echoed outside the printed payload; validation
// errors are structural only.
import { readFileSync } from "node:fs";
import { buildEnablementResultParts } from "./agentrelay-message-parts.mjs";

function argValue(name) {
  const prefix = `--${name}=`;
  const argv = process.argv.slice(2);
  for (const item of argv) {
    if (item === `--${name}`) return "";
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return null;
}

const path = argValue("result");
if (!path) {
  console.error("usage: agentrelay-build-result.mjs --result=<result.json>");
  process.exit(2);
}
let resultObject;
try {
  resultObject = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`result file unreadable or not JSON: ${path}`);
  process.exit(2);
}
try {
  const parts = buildEnablementResultParts(resultObject);
  process.stdout.write(`${JSON.stringify(parts)}\n`);
} catch (error) {
  console.error(`invalid enablement result: ${error.code || "invalid"} — ${error.message}`);
  process.exit(1);
}

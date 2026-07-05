import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLocalAgentRunner,
  resolveLocalAgentRunner
} from "../scripts/agentrelay-local-agent-runner.mjs";

test("resolveLocalAgentRunner honors component override before the shared local runner", () => {
  assert.equal(resolveLocalAgentRunner({
    componentRunner: "codex",
    localAgentRunner: "responses"
  }), "codex");
  assert.equal(resolveLocalAgentRunner({
    componentRunner: "",
    localAgentRunner: "responses"
  }), "responses");
});

test("resolveLocalAgentRunner auto prefers Responses API credentials and falls back to Codex CLI", () => {
  assert.equal(resolveLocalAgentRunner({
    localAgentRunner: "auto",
    responsesApiAvailable: true,
    codexCli: "/Applications/Codex.app/Contents/Resources/codex",
    codexCliExists: () => true
  }), "responses");
  assert.equal(resolveLocalAgentRunner({
    localAgentRunner: "auto",
    responsesApiAvailable: false,
    codexCli: "/Applications/Codex.app/Contents/Resources/codex",
    codexCliExists: () => true
  }), "codex");
});

test("resolveLocalAgentRunner reports an unavailable auto runner instead of guessing", () => {
  assert.throws(() => resolveLocalAgentRunner({
    localAgentRunner: "auto",
    responsesApiAvailable: false,
    codexCli: "/missing/codex",
    codexCliExists: () => false
  }), /No AgentRelay local agent runner is available/);
});

test("normalizeLocalAgentRunner rejects unsupported values", () => {
  assert.equal(normalizeLocalAgentRunner(" CODEX "), "codex");
  assert.throws(() => normalizeLocalAgentRunner("local-codex"), /Unsupported AgentRelay local agent runner/);
});

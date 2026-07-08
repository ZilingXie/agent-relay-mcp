import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPO_URL,
  buildLocalInstallArgs,
  parseInstallArgs
} from "../bin/agent-relay-mcp.mjs";

test("install CLI separates checkout options from local installer options", () => {
  const parsed = parseInstallArgs([
    "--",
    "--install-dir", "~/customAgentRelay",
    "--repo-url", "https://example.test/agent-relay-mcp.git",
    "--no-update",
    "--skip-npm-install",
    "--agent-id", "zac-agent",
    "--username=zac",
    "--skip-ui-service"
  ]);

  assert.match(parsed.installDir, /customAgentRelay$/);
  assert.equal(parsed.repoUrl, "https://example.test/agent-relay-mcp.git");
  assert.equal(parsed.update, false);
  assert.equal(parsed.npmInstall, false);
  assert.deepEqual(parsed.forwardedArgs, [
    "--agent-id", "zac-agent",
    "--username=zac",
    "--skip-ui-service"
  ]);
});

test("install CLI defaults to the public GitHub repo", () => {
  const parsed = parseInstallArgs([]);
  assert.equal(parsed.repoUrl, DEFAULT_REPO_URL);
  assert.match(parsed.installDir, /agentRelay$/);
});

test("local installer command always writes config", () => {
  assert.deepEqual(buildLocalInstallArgs(["--agent-id", "zac-agent"]), [
    "scripts/install-local-inbox.mjs",
    "--write",
    "--agent-id",
    "zac-agent"
  ]);
  assert.deepEqual(buildLocalInstallArgs(["--write", "--agent-id", "zac-agent"]), [
    "scripts/install-local-inbox.mjs",
    "--write",
    "--agent-id",
    "zac-agent"
  ]);
});

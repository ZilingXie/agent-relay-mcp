import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";


test("isolated doctor rejects implicit configuration before network access", () => {
  const result = spawnSync(process.execPath, ["scripts/doctor.mjs", "--isolated"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AGENTRELAY_BASE_URL: "https://server.stellarix.space/agentrelay/api"
    }
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /isolated doctor requires explicit/);
  assert.doesNotMatch(result.stdout, /AgentRelay HTTP health/);
});

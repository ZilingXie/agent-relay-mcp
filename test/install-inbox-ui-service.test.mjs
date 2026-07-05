import assert from "node:assert/strict";
import test from "node:test";

import { buildInboxUiLaunchdPlist } from "../scripts/install-inbox-ui-service.mjs";

test("buildInboxUiLaunchdPlist creates a launchd service for the inbox UI", () => {
  const plist = buildInboxUiLaunchdPlist({
    label: "space.stellarix.agentrelay.inbox-ui",
    nodePath: "/usr/local/bin/node",
    uiPath: "/Users/zac/agentInbox/scripts/agentrelay-inbox-ui.mjs",
    projectRoot: "/Users/zac/agentInbox",
    stateRoot: "/Users/zac/agentInbox/state",
    envPath: "/Users/zac/agentInbox/.env",
    localAgentRunner: "codex",
    host: "127.0.0.1",
    port: 8787,
    outLogPath: "/Users/zac/agentInbox/state/logs/inbox-ui.out.log",
    errLogPath: "/Users/zac/agentInbox/state/logs/inbox-ui.err.log"
  });

  assert.match(plist, /<key>Label<\/key><string>space\.stellarix\.agentrelay\.inbox-ui<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/zac\/agentInbox\/scripts\/agentrelay-inbox-ui\.mjs<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/Users\/zac\/agentInbox<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>AGENTRELAY_STATE_DIR<\/key><string>\/Users\/zac\/agentInbox\/state<\/string>/);
  assert.match(plist, /<key>AGENTRELAY_ENV_PATH<\/key><string>\/Users\/zac\/agentInbox\/\.env<\/string>/);
  assert.match(plist, /<key>AGENTRELAY_LOCAL_AGENT_RUNNER<\/key><string>codex<\/string>/);
  assert.doesNotMatch(plist, /AGENTRELAY_PROCESSOR_MODE/);
  assert.match(plist, /<key>HOST<\/key><string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<key>PORT<\/key><string>8787<\/string>/);
  assert.match(plist, /inbox-ui\.out\.log/);
  assert.match(plist, /inbox-ui\.err\.log/);
});

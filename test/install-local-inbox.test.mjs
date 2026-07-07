import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInitialFileAccessWhitelist,
  buildInitialEnv,
  buildLocalInboxEnvBlock,
  upsertLocalInboxEnvBlock
} from "../scripts/install-local-inbox.mjs";

test("buildLocalInboxEnvBlock configures listener hook and local inbox state", () => {
  const block = buildLocalInboxEnvBlock({
    repoRoot: "/Users/zac/project/agentRelay",
    inboxDir: "/Users/zac/project/agentRelay/.agentrelay/inbox",
    stateDir: "/Users/zac/project/agentRelay/state",
    hookCommand: "/usr/local/bin/node /Users/zac/project/agentRelay/scripts/agentrelay-inbox-intake.mjs",
    host: "127.0.0.1",
    port: 8787
  });

  assert.match(block, /BEGIN AgentRelay Local Inbox managed block/);
  assert.match(block, /AGENTRELAY_INBOX_DIR="\/Users\/zac\/project\/agentRelay\/\.agentrelay\/inbox"/);
  assert.match(block, /AGENTRELAY_STATE_DIR="\/Users\/zac\/project\/agentRelay\/state"/);
  assert.match(block, /AGENTRELAY_LISTENER_HOOK="\/usr\/local\/bin\/node \/Users\/zac\/project\/agentRelay\/scripts\/agentrelay-inbox-intake\.mjs"/);
  assert.match(block, /AGENTRELAY_ACK_ON_INBOX_RECEIVED=1/);
  assert.match(block, /AGENTRELAY_PROCESS_INBOX_ON_RECEIVE=1/);
  assert.match(block, /AGENTRELAY_EXECUTE_INBOX_ON_RECEIVE=1/);
  assert.match(block, /AGENTRELAY_LOCAL_AGENT_RUNNER="codex"/);
  assert.match(block, /AGENTRELAY_INBOX_UI_HOST="127\.0\.0\.1"/);
  assert.match(block, /AGENTRELAY_INBOX_UI_PORT="8787"/);
});

test("upsertLocalInboxEnvBlock preserves existing credentials", () => {
  const existing = [
    "AGENTRELAY_BASE_URL=https://server.stellarix.space/agentrelay/api",
    "AGENTRELAY_TOKEN=secret-token",
    ""
  ].join("\n");
  const block = buildLocalInboxEnvBlock({
    repoRoot: "/repo",
    inboxDir: "/repo/.agentrelay/inbox",
    stateDir: "/repo/state",
    hookCommand: "node /repo/scripts/agentrelay-inbox-intake.mjs"
  });

  const next = upsertLocalInboxEnvBlock(existing, block);

  assert.match(next, /AGENTRELAY_TOKEN=secret-token/);
  assert.match(next, /AGENTRELAY_LISTENER_HOOK="node \/repo\/scripts\/agentrelay-inbox-intake\.mjs"/);
});

test("buildInitialEnv writes placeholders plus local inbox defaults", () => {
  const localBlock = buildLocalInboxEnvBlock({
    repoRoot: "/repo",
    inboxDir: "/repo/.agentrelay/inbox",
    stateDir: "/repo/state",
    hookCommand: "node /repo/scripts/agentrelay-inbox-intake.mjs"
  });
  const env = buildInitialEnv({
    baseUrl: "https://server.stellarix.space/agentrelay/api",
    wsUrl: "wss://server.stellarix.space/agentrelay/api",
    agentId: "",
    username: "",
    token: "",
    localBlock
  });

  assert.match(env, /AGENTRELAY_AGENT_ID="replace-with-agent-id"/);
  assert.match(env, /AGENTRELAY_USERNAME="replace-with-username"/);
  assert.match(env, /AGENTRELAY_TOKEN="replace-with-cloud-token"/);
  assert.match(env, /BEGIN AgentRelay Local Inbox managed block/);
});

test("buildInitialFileAccessWhitelist defaults to the install root", () => {
  const whitelist = buildInitialFileAccessWhitelist({
    installRoot: "/Users/zac/project/agentRelay",
    now: () => "2026-07-06T01:02:03.000Z"
  });

  assert.equal(whitelist.version, 1);
  assert.deepEqual(whitelist.roots, [{
    path: "/Users/zac/project/agentRelay",
    label: "AgentRelay install root",
    source: "install",
    createdAt: "2026-07-06T01:02:03.000Z"
  }]);
});

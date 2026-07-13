#!/usr/bin/env node

import { resolve } from "node:path";
import { rebuildTaskIndex } from "./agentrelay-task-workspace.mjs";

const stateRoot = resolve(process.env.AGENTRELAY_STATE_DIR || resolve(process.cwd(), "state"));
const result = await rebuildTaskIndex({
  stateRoot,
  localAgentId: process.env.AGENTRELAY_AGENT_ID || ""
});
process.stdout.write(`${JSON.stringify({ stateRoot, ...result }, null, 2)}\n`);

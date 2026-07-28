import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const RUNTIME_GENERATION_FILES = Object.freeze([
  "mcp/server.mjs",
  "scripts/protocol-runtime.mjs",
  "scripts/protocol-sync.mjs",
  "scripts/agentrelay-agent-tools.mjs",
  "scripts/agentrelay-mcp-task-actions.mjs",
  "scripts/agentrelay-service-policy.mjs",
  "scripts/agentrelay-task-workspace.mjs",
  "scripts/runtime-generation.mjs",
  "package.json"
]);

export function computeRuntimeGeneration(root, files = RUNTIME_GENERATION_FILES) {
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, relativePath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function compareRuntimeGeneration(root, loadedGeneration, files = RUNTIME_GENERATION_FILES) {
  const installedGeneration = computeRuntimeGeneration(root, files);
  return {
    loadedGeneration,
    installedGeneration,
    restartRequired: installedGeneration !== loadedGeneration
  };
}

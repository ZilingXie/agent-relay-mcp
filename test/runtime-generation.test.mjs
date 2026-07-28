import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareRuntimeGeneration, computeRuntimeGeneration } from "../scripts/runtime-generation.mjs";

test("runtime generation requires restart after installed mutation code changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrelay-generation-"));
  await writeFile(join(root, "runtime.mjs"), "export const version = 1;\n");
  const files = ["runtime.mjs"];
  const loaded = computeRuntimeGeneration(root, files);
  assert.deepEqual(compareRuntimeGeneration(root, loaded, files), {
    loadedGeneration: loaded,
    installedGeneration: loaded,
    restartRequired: false
  });

  await writeFile(join(root, "runtime.mjs"), "export const version = 2;\n");
  const changed = compareRuntimeGeneration(root, loaded, files);
  assert.equal(changed.restartRequired, true);
  assert.notEqual(changed.installedGeneration, loaded);
});

/**
 * Child for tests/ci-workflows/test-git-isolation.test.ts: calls the script helpers that take an
 * explicit repository root, in whatever environment the parent hands it, and prints what each one
 * saw. Bun.spawn without an `env` option uses the environment the process STARTED with, so these
 * helpers only read the root they were given if they pass a scrubbed env themselves.
 */
import { gitLsFiles } from "../../scripts/file-size-ratchet";
import { trackedPaths } from "../../scripts/structure-ssot";
import { inspectChangedRun } from "../../scripts/test";

const [root, base] = process.argv.slice(2);
if (!root || !base) throw new Error("usage: bun git-env-scripts-child.ts <root> <base>");

function attempt<T>(run: () => T): T | { error: string } {
  try {
    return run();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

console.log(JSON.stringify({
  lsFiles: attempt(() => gitLsFiles(root)),
  tracked: attempt(() => [...(trackedPaths(root) ?? [])].sort()),
  changed: attempt(() => inspectChangedRun([`--changed=${base}`], root)),
}));

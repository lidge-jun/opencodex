/**
 * Child for tests/ci-workflows/test-git-isolation.test.ts: builds one fixture repository through
 * the shared helper, in whatever environment the parent hands it. A plain `bun` script loads no
 * test preload, so an inherited GIT_DIR reaches the helper exactly as it would from a hook or a
 * `--git-dir/--work-tree` wrapper. Every step runs even if an earlier one failed, so the parent
 * can assert on the outer repository whatever the helper did.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureGit, initFixtureRepo, type GitRunner } from "./git-fixture";

const root = process.argv[2];
if (!root) throw new Error("usage: bun git-fixture-child.ts <root>");

function step(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`[git-fixture-child] ${name} failed: ${(error as Error).message.trim()}`);
  }
}

let git: GitRunner = fixtureGit(root);
step("init", () => { git = initFixtureRepo(root); });
writeFileSync(join(root, "seed.txt"), "seed\n");
step("add", () => { git("add", "-A"); });
step("commit", () => { git("commit", "-q", "-m", "seed"); });

/**
 * Sets up the git hooks for local development.
 * Run once after cloning: bun run setup:hooks
 *
 * - Retires the unmodified repository-managed `pre-push` hook. Validation is
 *   run explicitly; custom hooks are preserved.
 * - Retires the repository-managed `post-merge` shim. A git hook runs on every
 *   contributor's machine after every merge and executes whatever the pulled
 *   commits put in `package.json`, so keeping the feature would keep an
 *   auto-executed-code path that cannot be constrained to trusted content.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

// Resolve the real hooks dir via git so linked worktrees (`.git` file), core.hooksPath,
// and non-default git dirs all work. Hard-coding <repo>/.git/hooks breaks those setups.
let hooksDir: string;
try {
  hooksDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
} catch {
  console.error("setup-hooks: must be run from inside a git repository (git not found or not a repo).");
  process.exit(1);
}

// Match the exact retired shim (normalizing checkout line endings), never a
// name or a partial marker: a user may have added other work to their hook.
const retiredPrePushSha256 = "2aa6b5f84ab989954d2ccc1a8680d63ad934034778e0ee99c277f8873fd40508";
const prePushPath = join(hooksDir, "pre-push");
try {
  const prePushStat = lstatSync(prePushPath, { throwIfNoEntry: false });
  if (prePushStat?.isFile()) {
    const content = readFileSync(prePushPath, "utf8").replace(/\r\n/g, "\n");
    if (createHash("sha256").update(content).digest("hex") === retiredPrePushSha256) {
      unlinkSync(prePushPath);
      console.log("Removed the retired repository-managed pre-push hook.");
    } else {
      console.log("Preserved custom pre-push hook.");
    }
  }
} catch (error) {
  // A failed read or unlink must not skip the post-merge retirement below: the
  // shim keeps executing pulled code on every merge while it remains.
  console.warn("setup-hooks: could not process the pre-push hook: " + (error instanceof Error ? error.message : String(error)));
}

// Same exact-match retirement for the repository-managed post-merge shim: an
// already-installed copy keeps executing pulled code on every merge until it
// is removed, so setup retires it rather than leaving the vector in place.
const retiredPostMergeSha256 = "d9f4ae72e531658fb0494ff6d2a62366a5a0c29b7d3a890a68e6626760de0330";
const postMergePath = join(hooksDir, "post-merge");
try {
  const postMergeStat = lstatSync(postMergePath, { throwIfNoEntry: false });
  if (postMergeStat?.isFile()) {
    const content = readFileSync(postMergePath, "utf8").replace(/\r\n/g, "\n");
    if (createHash("sha256").update(content).digest("hex") === retiredPostMergeSha256) {
      unlinkSync(postMergePath);
      console.log("Removed the retired repository-managed post-merge hook.");
    } else {
      console.log("Preserved custom post-merge hook.");
    }
  }
} catch (error) {
  console.warn("setup-hooks: could not process the post-merge hook: " + (error instanceof Error ? error.message : String(error)));
}

console.log("Run validation explicitly before review; see AGENTS.md for test scope.");

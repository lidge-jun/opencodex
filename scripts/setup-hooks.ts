/**
 * Sets up the git hooks for local development.
 * Run once after cloning: bun run setup:hooks
 *
 * - `pre-push` runs `bun run prepush` (typecheck + tests + privacy scan + GUI
 *   eslint and React Doctor when `gui/` changed) — the local portion of the CI
 *   gate.
 * - `post-merge` runs `bun run postmerge`, which rebuilds the packaged GUI when
 *   a merge or pull brought `gui/` changes. `gui/dist` is generated and
 *   gitignored, so a fast-forward advances the source while the dashboard keeps
 *   serving the previously built bundle.
 *
 * To skip in an emergency: git push --no-verify / git pull --no-verify
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, chmodSync, readFileSync, renameSync } from "node:fs";
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

if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

/**
 * Deterministic overwrite policy, per hook: an existing but differing hook is
 * preserved as <hook>.backup-<unix-ts> (timestamped names are unique), then the
 * managed hook is installed. Identical content is a no-op.
 *
 * Each hook installs independently — one already being current must not stop the
 * other from being written, which a single early `process.exit(0)` would do.
 */
function installHook(name: string, source: string, summary: string): void {
  const src = join(repoRoot, "scripts", source);
  const dest = join(hooksDir, name);

  if (existsSync(dest)) {
    const existing = readFileSync(dest, "utf8");
    const managed = readFileSync(src, "utf8");
    if (existing === managed) {
      console.log(`${name} hook already up to date at ${dest}`);
      return;
    }
    const backup = `${dest}.backup-${Date.now()}`;
    renameSync(dest, backup);
    console.log(`existing ${name} hook preserved at ${backup}`);
  }

  copyFileSync(src, dest);

  // chmod +x -- no-op on Windows but harmless
  try {
    chmodSync(dest, 0o755);
  } catch {
    // Windows: Git for Windows calls sh.exe directly, executable bit not required.
  }

  console.log(`${name} hook installed at ${dest}. ${summary}`);
}

installHook(
  "pre-push",
  "pre-push.sh",
  "Runs typecheck + tests + privacy scan (+ GUI eslint and React Doctor when gui/ changed) before every push.",
);
installHook(
  "post-merge",
  "post-merge.sh",
  "Rebuilds the packaged GUI when a merge or pull brought gui/ changes.",
);

console.log("Skip in an emergency with: git push --no-verify / git pull --no-verify");

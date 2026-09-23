/**
 * Sets up the git hooks for local development.
 * Run once after cloning: bun run setup:hooks
 *
 * - Retires the unmodified repository-managed `pre-push` hook. Validation is
 *   run explicitly; custom hooks are preserved.
 * - `post-merge` runs `bun run postmerge`, which rebuilds the packaged GUI when
 *   a merge or pull brought `gui/` changes. `gui/dist` is generated and
 *   gitignored, so a fast-forward advances the source while the dashboard keeps
 *   serving the previously built bundle.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, copyFileSync, mkdirSync, chmodSync, readFileSync, renameSync, lstatSync, unlinkSync } from "node:fs";
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

// Match the exact retired shim (normalizing checkout line endings), never a
// name or a partial marker: a user may have added other work to their hook.
const retiredPrePushSha256 = "2aa6b5f84ab989954d2ccc1a8680d63ad934034778e0ee99c277f8873fd40508";
const prePushPath = join(hooksDir, "pre-push");
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

installHook(
  "post-merge",
  "post-merge.sh",
  "Rebuilds the packaged GUI when a merge or pull brought gui/ changes.",
);

console.log("Run validation explicitly before review; see AGENTS.md for test scope.");

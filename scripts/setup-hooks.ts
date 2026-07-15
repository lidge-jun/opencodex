/**
 * Sets up the git pre-push hook for local development.
 * Run once after cloning: bun run setup:hooks
 *
 * The hook runs `bun run prepush` (typecheck + tests + privacy scan) before every
 * push — the typecheck/unit-test/privacy-scan portions of the CI gate.
 *
 * To skip in an emergency: git push --no-verify
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

const src = join(repoRoot, "scripts", "pre-push.sh");
const dest = join(hooksDir, "pre-push");

if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

// Deterministic overwrite policy: an existing, differing pre-push hook is always
// preserved as pre-push.backup-<unix-ts> (timestamped names are unique), then the
// managed hook is installed. Identical content is a no-op.
if (existsSync(dest)) {
  const existing = readFileSync(dest, "utf8");
  const managed = readFileSync(src, "utf8");
  if (existing === managed) {
    console.log(`pre-push hook already up to date at ${dest}`);
    process.exit(0);
  }
  const backup = `${dest}.backup-${Date.now()}`;
  renameSync(dest, backup);
  console.log(`existing pre-push hook preserved at ${backup}`);
}

copyFileSync(src, dest);

// chmod +x -- no-op on Windows but harmless
try {
  chmodSync(dest, 0o755);
} catch {
  // Windows: Git for Windows calls sh.exe directly, executable bit not required.
}

console.log(`pre-push hook installed at ${dest}. Runs typecheck + tests + privacy scan before every push.`);
console.log("Skip in an emergency with: git push --no-verify");

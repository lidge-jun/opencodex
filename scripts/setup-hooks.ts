/**
 * Sets up the .git/hooks/pre-push hook for local development.
 * Run once after cloning: bun run setup:hooks
 *
 * The hook runs `bun run typecheck && bun run test` before every push,
 * matching the same gate the CI runs on ubuntu/macos/windows.
 *
 * To skip in an emergency: git push --no-verify
 */
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const hooksDir = join(repoRoot, ".git", "hooks");
const src = join(repoRoot, "scripts", "pre-push.sh");
const dest = join(hooksDir, "pre-push");

if (!existsSync(join(repoRoot, ".git"))) {
  console.error("setup-hooks: must be run from inside a git repository.");
  process.exit(1);
}

if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir);
}

copyFileSync(src, dest);

// chmod +x -- no-op on Windows but harmless
try {
  chmodSync(dest, 0o755);
} catch {
  // Windows: Git for Windows calls sh.exe directly, executable bit not required.
}

console.log("pre-push hook installed. Runs typecheck + tests before every push.");
console.log("Skip in an emergency with: git push --no-verify");
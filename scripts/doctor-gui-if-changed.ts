/**
 * Run React Doctor in gui/ when this push includes gui/ changes.
 * Used by `bun run prepush`. Skip with: git push --no-verify
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const guiDir = join(repoRoot, "gui");

function hasRef(ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function diffNames(range: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", range], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function guiPathsChanged(): boolean {
  let range: string | null = null;
  if (hasRef("@{u}")) {
    range = "@{u}...HEAD";
  } else if (hasRef("origin/main")) {
    range = "origin/main...HEAD";
  } else if (hasRef("main")) {
    range = "main...HEAD";
  }

  const files = range ? diffNames(range) : [];
  if (files.length === 0 && !range) {
    // No useful base — run doctor so GUI pushes still get a check.
    return true;
  }
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

if (!guiPathsChanged()) {
  console.log("doctor:gui: skip (no gui/ changes in push range)");
  process.exit(0);
}

console.log("doctor:gui: gui/ changed — running React Doctor (scope=changed)");
execFileSync("bun", ["run", "doctor"], {
  cwd: guiDir,
  stdio: "inherit",
  env: { ...process.env, npm_config_yes: "true" },
});

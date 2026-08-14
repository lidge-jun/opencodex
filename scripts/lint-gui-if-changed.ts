/**
 * Run GUI Oxlint when this push includes gui/ changes.
 * Used by `bun run prepush`. Skip with: git push --no-verify
 *
 * Mirrors `scripts/doctor-gui-if-changed.ts` so the local pre-push gate and
 * the CI `gates` job agree: GUI lint runs only when the push actually touches
 * `gui/`. Unlike doctor there is no engine to fetch, so lint findings always
 * fail the push — there is no infra-degradation path to soft-skip on.
 *
 * Test hooks: LINT_DRY_RUN=1 prints the run/skip decision without spawning;
 * LINT_FILES (newline-separated) overrides git-derived changed files;
 * LINT_CMD overrides the spawned command.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** True when any changed path is the gui directory or inside it (slash-guarded). */
function guiPathsChanged(files: string[]): boolean {
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const guiDir = join(repoRoot, "gui");

  const hasRef = (ref: string): boolean => {
    try {
      const probe = spawnSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return probe.status === 0;
    } catch {
      return false;
    }
  };

  const diffNames = (range: string): string[] => {
    try {
      const diff = spawnSync("git", ["diff", "--name-only", range], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (diff.status !== 0) return [];
      return (diff.stdout ?? "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  let files: string[];
  let hadBase = true;
  if (process.env.LINT_FILES !== undefined) {
    files = process.env.LINT_FILES.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  } else {
    let range: string | null = null;
    if (hasRef("@{u}")) range = "@{u}...HEAD";
    else if (hasRef("origin/main")) range = "origin/main...HEAD";
    else if (hasRef("main")) range = "main...HEAD";
    hadBase = range !== null;
    files = range ? diffNames(range) : [];
  }

  // No usable base — run lint so GUI pushes still get a check.
  const shouldRun = hadBase ? guiPathsChanged(files) : true;

  if (process.env.LINT_DRY_RUN === "1") {
    console.log(shouldRun ? "lint:run" : "lint:skip");
    process.exit(0);
  }

  if (!shouldRun) {
    console.log("lint:gui: skip (no gui/ changes in push range)");
    process.exit(0);
  }

  console.log("lint:gui: gui/ changed — running oxlint (trigger=gui-changed, scope=full-gui)");
  const [cmd, ...args] = process.env.LINT_CMD
    ? process.env.LINT_CMD.split(" ")
    : ["bun", "run", "lint"];

  const result = spawnSync(cmd!, args, {
    cwd: guiDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  // Lint is local and deterministic: findings fail the push, and a failed
  // spawn is a real error, not an infrastructure soft-skip.
  if (result.error) {
    console.error(`lint:gui: could not run lint command: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

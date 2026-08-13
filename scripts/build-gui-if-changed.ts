/**
 * Rebuild the packaged GUI when a merge or pull brought `gui/` changes.
 * Used by the `post-merge` git hook. Skip with: git pull --no-verify
 *
 * Why this exists: `ocx` serves `gui/dist`, which is generated output and
 * therefore gitignored. A fast-forward advances `gui/src` but leaves `gui/dist`
 * at whatever was last built, so the dashboard keeps rendering the OLD bundle
 * while the source says otherwise — sidebar rows that were deleted stay on
 * screen, and nothing in git status hints at why. That cost a real debugging
 * session: the symlink and the source were both correct and the served bundle
 * was seven hours stale.
 *
 * Mirrors `scripts/lint-gui-if-changed.ts` and `scripts/doctor-gui-if-changed.ts`
 * so all three agree on what "gui changed" means.
 *
 * Test hooks: BUILD_GUI_DRY_RUN=1 prints the run/skip decision without
 * spawning; BUILD_GUI_FILES (newline-separated) overrides the git-derived file
 * list; BUILD_GUI_CMD overrides the spawned command.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** True when any changed path is the gui directory or inside it (slash-guarded). */
export function guiPathsChanged(files: string[]): boolean {
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, "..");

  /*
   * `post-merge` runs after the merge commit exists, so the range that describes
   * what just arrived is ORIG_HEAD...HEAD. Git sets ORIG_HEAD for merge and pull;
   * without it there is nothing to diff against.
   */
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

  const hasRef = (ref: string): boolean => {
    try {
      return spawnSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoRoot,
        stdio: "ignore",
      }).status === 0;
    } catch {
      return false;
    }
  };

  let files: string[];
  let hadBase = true;
  if (process.env.BUILD_GUI_FILES !== undefined) {
    files = process.env.BUILD_GUI_FILES.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  } else {
    hadBase = hasRef("ORIG_HEAD");
    files = hadBase ? diffNames("ORIG_HEAD...HEAD") : [];
  }

  /*
   * No usable base means we cannot tell what arrived. Skip rather than rebuild:
   * this hook runs on every merge, and an unconditional build would tax every
   * unrelated pull. A stale dist is recoverable with one command; a hook that
   * burns ten seconds on every merge gets disabled.
   */
  const shouldRun = hadBase && guiPathsChanged(files);

  if (process.env.BUILD_GUI_DRY_RUN === "1") {
    console.log(shouldRun ? "build:run" : "build:skip");
    process.exit(0);
  }

  if (!shouldRun) {
    process.exit(0);
  }

  console.log("build:gui: gui/ changed — rebuilding the packaged dashboard");
  const cmd = process.env.BUILD_GUI_CMD ?? "bun run build:gui";
  const [bin, ...args] = cmd.split(" ");
  const built = spawnSync(bin!, args, { cwd: repoRoot, stdio: "inherit" });

  /*
   * A failed rebuild must not fail the merge — the merge already happened, and
   * exiting non-zero here only prints a confusing error after a successful pull.
   * Say plainly what to run instead.
   */
  if (built.status !== 0) {
    console.error("build:gui failed. The dashboard will serve the previous bundle until you run: bun run build:gui");
  }
  process.exit(0);
}

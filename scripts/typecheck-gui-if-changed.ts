/**
 * Run the GUI TypeScript build when this push includes gui/ changes.
 * Used by "bun run prepush".
 *
 * Mirrors "scripts/lint-gui-if-changed.ts" so local push validation stays in
 * one shape: root "typecheck" cannot see gui/ (no project references), so the
 * gui compile check must run separately or a gui compile error ships silently
 * to a fork pull request where no CI lane would catch it (#6471).
 * "tsc -b" is local and deterministic, so a failure always fails the push —
 * there is no soft-skip path.
 *
 * The base is the merge base with the integration branch (upstream/dev, then origin/dev, then
 * dev, the order "test:changed" uses), not "@{u}": "prepush" is a package script, not a git hook,
 * so it never sees the push destination, and a tracking branch can already hold a GUI change
 * the destination lacks. Everything the branch adds over dev is a superset of any push range.
 * Paths are read NUL-delimited so a quoted non-ASCII name still matches "gui/", and with rename
 * detection off so a file moved out of gui/ still reports its gui/ source path. When no base
 * resolves or the diff itself fails, the check runs rather than reading the failure as "no
 * gui/ changes".
 *
 * Test hooks: TYPECHECK_DRY_RUN=1 prints the run/skip decision without
 * spawning; TYPECHECK_FILES (newline-separated) overrides git-derived changed
 * files; TYPECHECK_CMD overrides the spawned command (a JSON array of argv, or a
 * space-separated string). The default command runs via process.execPath so the
 * gate uses the same bun that launched it instead of trusting PATH.
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

  /** Changed paths for the range, or null when git could not produce them. */
  const diffNames = (range: string): string[] | null => {
    try {
      const diff = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", range], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (diff.status !== 0) return null;
      return (diff.stdout ?? "").split("\0").filter(Boolean);
    } catch {
      return null;
    }
  };

  // null: no usable base, or the diff failed. Either way the check runs.
  let files: string[] | null;
  if (process.env.TYPECHECK_FILES !== undefined) {
    files = process.env.TYPECHECK_FILES.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  } else {
    const base = ["upstream/dev", "origin/dev", "dev"].find(hasRef);
    files = base ? diffNames(`${base}...HEAD`) : null;
  }

  const shouldRun = files === null || guiPathsChanged(files);

  if (process.env.TYPECHECK_DRY_RUN === "1") {
    console.log(shouldRun ? "typecheck:run" : "typecheck:skip");
    process.exit(0);
  }

  if (!shouldRun) {
    console.log("typecheck:gui: skip (no gui/ changes in push range)");
    process.exit(0);
  }

  console.log("typecheck:gui: gui/ changed — running tsc -b (trigger=gui-changed, scope=gui project)");
  const override = process.env.TYPECHECK_CMD;
  const [cmd, ...args]: string[] = override
    ? (override.trimStart().startsWith("[") ? JSON.parse(override) as string[] : override.split(" "))
    : [process.execPath, "x", "tsc", "-b"];

  const result = spawnSync(cmd!, args, {
    cwd: guiDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  // The compiler is local and deterministic: a compile error fails the push,
  // and a failed spawn is a real error, not an infrastructure soft-skip.
  if (result.error) {
    console.error("typecheck:gui: could not run tsc -b: " + result.error.message);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

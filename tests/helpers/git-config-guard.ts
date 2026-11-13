/**
 * Detects a test run changing the developer's repository config.
 *
 * The preload arms one guard per test file for this checkout's COMMON .git/config (the file every
 * linked worktree shares) and fails the test after which a guarded key changed. It exists because
 * fixture helpers that inherited GIT_DIR/GIT_WORK_TREE once wrote user.name, user.email and a
 * core.worktree pointing at a deleted temp tree into a shared checkout, which re-authored every
 * later commit on that host and broke `git rev-parse --show-toplevel` in every worktree.
 *
 * Detection only, with stated limits: a change undone before the next check is invisible; a
 * legitimate change to a guarded key from another worktree fails one test per worker; the
 * per-worktree config.worktree is not watched. Reports carry key names only, never values.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { withoutGitRepositoryEnv } from "../../scripts/git-repository-env";

export const GUARDED_GIT_CONFIG_KEYS = ["core.bare", "core.hookspath", "core.worktree", "user.email", "user.name"] as const;

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const CONTEXT = "this test or a concurrent test worker";
const REMEDY = "A git command reached the developer's repository instead of a fixture: pass an env from tests/helpers/git-fixture.ts. If you changed it yourself, ignore this once.";

/** `<checkout>/.git/config`, or the common dir's config for a linked worktree; null without a .git. */
export function resolveCommonGitConfigPath(checkout: string): string | null {
  const dotGit = join(checkout, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, "config");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const gitDir = resolve(checkout, match[1]!);
    const commonFile = join(gitDir, "commondir");
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    return join(common, "config");
  } catch {
    return null;
  }
}

type GuardedValues = Map<string, string>;

function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Guarded keys as git itself parses them (quoting, comments, repeats, continuations); null if git refuses. */
function readGuarded(path: string): GuardedValues | null {
  const run = Bun.spawnSync(["git", "config", "--file", path, "--null", "--list"], {
    env: { ...withoutGitRepositoryEnv(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) return null;
  const values = new Map<string, string[]>();
  for (const entry of run.stdout.toString().split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
    if (!(GUARDED_GIT_CONFIG_KEYS as readonly string[]).includes(key)) continue;
    values.set(key, [...(values.get(key) ?? []), newline === -1 ? "" : entry.slice(newline + 1)]);
  }
  return new Map([...values].map(([key, list]) => [key, JSON.stringify(list)]));
}

function changedKeys(before: GuardedValues, after: GuardedValues): string[] {
  return GUARDED_GIT_CONFIG_KEYS.filter(key => before.get(key) !== after.get(key));
}

type State =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "unparsable"; bytes: Buffer };

export interface GitConfigGuard {
  readonly path: string;
  /** A report when the config changed since the last check, else null. Re-baselines either way. */
  check(): string | null;
}

/**
 * Null when the checkout has no .git (an exported tree has nothing to protect). A config that
 * exists in name but cannot be read or parsed at arm time is reported by the first check.
 */
export function createGitConfigGuard(checkout: string): GitConfigGuard | null {
  const path = resolveCommonGitConfigPath(checkout);
  if (!path) return null;
  const missing = `[test] the checkout's common .git/config is missing or unreadable after ${CONTEXT}.`;
  const unparsable = `[test] git could not parse the checkout's common .git/config after ${CONTEXT}.`;
  let lastGood: GuardedValues | null = null;
  let state: State;
  let pending: string | null = null;
  const initial = readBytes(path);
  if (initial === null) {
    state = { kind: "missing" };
    pending = missing;
  } else {
    lastGood = readGuarded(path);
    state = lastGood ? { kind: "ok", bytes: initial } : { kind: "unparsable", bytes: initial };
    if (!lastGood) pending = unparsable;
  }
  return {
    path,
    check() {
      if (pending) {
        const report = pending;
        pending = null;
        return report;
      }
      const bytes = readBytes(path);
      if (bytes === null) {
        if (state.kind === "missing") return null;
        state = { kind: "missing" };
        return missing;
      }
      if (state.kind !== "missing" && bytes.equals(state.bytes)) return null;
      const current = readGuarded(path);
      if (!current) {
        const already = state.kind === "unparsable";
        state = { kind: "unparsable", bytes };
        return already ? null : unparsable;
      }
      state = { kind: "ok", bytes };
      const previous = lastGood;
      lastGood = current;
      if (!previous) return null;
      const keys = changedKeys(previous, current);
      return keys.length > 0
        ? `[test] ${keys.join(", ")} changed in the checkout's common .git/config after ${CONTEXT}. ${REMEDY}`
        : null;
    },
  };
}

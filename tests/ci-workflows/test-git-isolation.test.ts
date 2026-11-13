import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath } from "../helpers/repo-root";

// A test git helper that inherits GIT_DIR / GIT_WORK_TREE from a hook or a --git-dir/--work-tree
// wrapper runs against THAT repository whatever its cwd: `git init` reinitialises it (and writes
// core.worktree from GIT_WORK_TREE), `git config` writes its .git/config, and add/commit land in
// it. That is how a shared checkout once gained user.name=t and a core.worktree pointing at a
// deleted temp tree. These cases hand a hostile environment to a child and inspect the outer repo.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** The parent's own environment with every GIT_* variable removed: the oracle, independent of the helpers under test. */
function withoutGit(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return env;
}

const OUTER_EMAIL = ["outer", "example.test"].join("@");
function oracleEnv(): Record<string, string> {
  return {
    ...withoutGit(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Outer", GIT_AUTHOR_EMAIL: OUTER_EMAIL,
    GIT_COMMITTER_NAME: "Outer", GIT_COMMITTER_EMAIL: OUTER_EMAIL,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: oracleEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitFile(root: string, name: string): string {
  writeFileSync(join(root, name), `${name}\n`);
  git(root, "add", name);
  git(root, "commit", "-q", "-m", name);
  return git(root, "rev-parse", "HEAD");
}

function outerRepo(): string {
  const root = tempDir("ocx-git-outer-");
  git(root, "init", "-q");
  commitFile(root, "outer.txt");
  return root;
}

function snapshot(outer: string) {
  return {
    config: readFileSync(join(outer, ".git", "config"), "utf8"),
    refs: git(outer, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: git(outer, "rev-parse", "HEAD"),
    index: readFileSync(join(outer, ".git", "index")).toString("base64"),
  };
}

function runChild(script: string, args: string[], hostile: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, helperPath(script), ...args], {
    env: { ...withoutGit(), ...hostile }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("fixture git helpers ignore an inherited repository", () => {
  test("GIT_DIR alone: the outer config, refs and index are untouched", () => {
    const outer = outerRepo();
    const before = snapshot(outer);
    const fixture = tempDir("ocx-git-fixture-");
    const child = runChild("git-fixture-child.ts", [fixture], { GIT_DIR: join(outer, ".git") });
    const after = snapshot(outer);
    expect(after.config).not.toContain("[user]");
    expect(after).toEqual(before);
    expect(child.stderr).toBe("");
    expect(child.exitCode).toBe(0);
    expect(existsSync(join(fixture, ".git"))).toBe(true);
    expect(git(fixture, "log", "-1", "--format=%an")).toBe("OpenCodex Fixture");
  });

  test("GIT_DIR with GIT_WORK_TREE: no core.worktree lands in the outer config", () => {
    const outer = outerRepo();
    const before = snapshot(outer);
    const tree = join(tempDir("ocx-git-wrapper-"), "tree");
    mkdirSync(tree);
    const fixture = tempDir("ocx-git-fixture-");
    const child = runChild("git-fixture-child.ts", [fixture], { GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: tree });
    const after = snapshot(outer);
    expect(after.config).not.toMatch(/worktree\s*=/);
    expect(after).toEqual(before);
    expect(child.stderr).toBe("");
    expect(git(fixture, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("script helpers that take a root read that root, not an inherited GIT_DIR", () => {
    const outer = outerRepo();
    const fixture = tempDir("ocx-git-scripts-");
    git(fixture, "init", "-q");
    const base = commitFile(fixture, "first.txt");
    commitFile(fixture, "second.txt");
    const child = runChild("git-env-scripts-child.ts", [fixture, base], {
      GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, ".git", "index"),
    });
    expect(child.exitCode, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      lsFiles: ["first.txt", "second.txt"],
      tracked: ["first.txt", "second.txt"],
      changed: { comparisonRef: base, comparisonCommit: base, changedFiles: ["second.txt"] },
    });
  });
});

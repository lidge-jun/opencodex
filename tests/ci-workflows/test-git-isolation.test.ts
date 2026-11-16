import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRepositoryEnvName } from "../../scripts/git-repository-env";
import { createGitConfigGuard, resolveCommonGitConfigPath } from "../helpers/git-config-guard";
import { FIXTURE_GIT_IDENTITY, fixtureGitEnv, repositoryGitEnv } from "../helpers/git-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath, repoRoot } from "../helpers/repo-root";

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

describe("repository variable scrub", () => {
  test("covers every variable the installed git clears for another repository", () => {
    const local = git(tempDir("ocx-git-local-vars-"), "rev-parse", "--local-env-vars").split(/\r?\n/).filter(Boolean);
    expect(local.length).toBeGreaterThan(5);
    expect(local.filter(name => !isGitRepositoryEnvName(name))).toEqual([]);
    for (const name of ["GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_12", "git_dir", "Git_Work_Tree"]) {
      expect(isGitRepositoryEnvName(name)).toBe(true);
    }
    for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_PAGER", "PATH"]) {
      expect(isGitRepositoryEnvName(name)).toBe(false);
    }
  });

  test("fixture env drops the repository and global config; checkout env keeps the global config", () => {
    const base = { PATH: "/bin", GIT_DIR: "/outer/.git", GIT_INDEX_FILE: "/outer/.git/index", GIT_CONFIG_GLOBAL: "/home/.gitconfig" };
    const fixture = fixtureGitEnv({}, base);
    expect(fixture.GIT_DIR).toBeUndefined();
    expect(fixture.GIT_INDEX_FILE).toBeUndefined();
    expect(fixture.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(fixture.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(fixture.GIT_AUTHOR_NAME).toBe(FIXTURE_GIT_IDENTITY.name);
    expect(fixture.GIT_COMMITTER_EMAIL).toBe(FIXTURE_GIT_IDENTITY.email);
    expect(repositoryGitEnv(base)).toEqual({ PATH: "/bin", GIT_CONFIG_GLOBAL: "/home/.gitconfig" });
  });
});

describe("git config guard", () => {
  function fixtureCheckout(): { root: string; config: string } {
    const root = tempDir("ocx-git-guard-");
    git(root, "init", "-q");
    return { root, config: join(root, ".git", "config") };
  }
  const setKey = (config: string, key: string, value: string) => git(tmpdir(), "config", "--file", config, key, value);

  test("resolves the common config for a checkout and for a linked worktree", () => {
    const { root, config } = fixtureCheckout();
    commitFile(root, "seed.txt");
    const linked = join(tempDir("ocx-git-guard-linked-"), "wt");
    git(root, "worktree", "add", "-q", "--detach", linked);
    expect(resolveCommonGitConfigPath(root)).toBe(config);
    // Native canonicalization on both sides: git records the linked worktree's gitdir with Windows' long
    // name (runneradmin), while the fixture root keeps the 8.3 short spelling (RUNNER~1) the JS
    // realpathSync leaves in place (run 43413601225). realpathSync.native expands both to one path.
    expect(realpathSync.native(resolveCommonGitConfigPath(linked)!)).toBe(realpathSync.native(config));
    expect(resolveCommonGitConfigPath(tempDir("ocx-git-guard-none-"))).toBeNull();
  });

  test("reports a guarded key once by name, ignores unrelated edits, and sees a same-size same-mtime rewrite", () => {
    const { root, config } = fixtureCheckout();
    const guard = createGitConfigGuard(root)!;
    expect(guard.check()).toBeNull();
    setKey(config, "user.name", "aaaa-private");
    const report = guard.check();
    expect(report).toContain("user.name changed");
    expect(report).not.toContain("aaaa-private");
    expect(report).not.toContain(root);
    expect(guard.check()).toBeNull();
    setKey(config, "branch.main.remote", "origin");
    expect(guard.check()).toBeNull();
    const { atime, mtime } = statSync(config);
    writeFileSync(config, readFileSync(config, "utf8").replace("aaaa-private", "bbbb-private"));
    utimesSync(config, atime, mtime);
    expect(guard.check()).toContain("user.name changed");
    setKey(config, "core.worktree", "/tmp/elsewhere");
    expect(guard.check()).toContain("core.worktree changed");
  });

  test("a missing or unparsable config is reported once, and recovery compares with the last good state", () => {
    const { root, config } = fixtureCheckout();
    const guard = createGitConfigGuard(root)!;
    const good = readFileSync(config);
    renameSync(config, config + ".away");
    expect(guard.check()).toContain("missing or unreadable");
    expect(guard.check()).toBeNull();
    renameSync(config + ".away", config);
    expect(guard.check()).toBeNull();
    writeFileSync(config, "[core\n\tbroken");
    expect(guard.check()).toContain("could not parse");
    writeFileSync(config, "[core\n\tbroken again");
    expect(guard.check()).toBeNull();
    writeFileSync(config, Buffer.concat([good, Buffer.from("[user]\n\temail = x\n")]));
    expect(guard.check()).toContain("user.email changed");
  });

  test("an existing .git whose config cannot be read at arm time is reported by the first check", () => {
    const { root, config } = fixtureCheckout();
    renameSync(config, config + ".away");
    const guard = createGitConfigGuard(root)!;
    expect(guard.check()).toContain("missing or unreadable");
    expect(guard.check()).toBeNull();
    expect(createGitConfigGuard(tempDir("ocx-git-guard-none-"))).toBeNull();
  });
});

describe("test preload", () => {
  function runProbe(source: string, env: Record<string, string>) {
    const dir = tempDir("ocx-git-probe-");
    const file = join(dir, "git-probe.test.ts");
    writeFileSync(file, source);
    const result = Bun.spawnSync([process.execPath, "test", "--parallel=1", file], {
      cwd: repoRoot(),
      env: { ...withoutGit(), OCX_TEST_NO_QUEUE: "1", ...env },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  test("removes inherited repository variables before any test or child sees them", () => {
    const outer = outerRepo();
    const guarded = tempDir("ocx-git-probe-checkout-");
    git(guarded, "init", "-q");
    const probe = runProbe(String.raw`import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
const NAMES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
test("scrubbed", () => {
  expect(NAMES.filter(name => name in process.env)).toEqual([]);
  const seen = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"]).toString();
  expect(NAMES.filter(name => JSON.parse(seen).includes(name))).toEqual([]);
});
`, {
      GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, ".git", "index"),
      OCX_GIT_CONFIG_GUARD_CHECKOUT: guarded,
    });
    expect(probe.exitCode, probe.output).toBe(0);
    const warning = probe.output.split("\n").find(line => line.includes("removed inherited")) ?? "";
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) expect(warning).toContain(name);
  }, { timeout: 90_000 });

  test("fails the case after which the guarded checkout's config changed", () => {
    const guarded = tempDir("ocx-git-probe-checkout-");
    git(guarded, "init", "-q");
    const probe = runProbe(String.raw`import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
test("leaves the config alone", () => {});
test("writes user.name", () => {
  execFileSync("git", ["config", "--file", join(process.env.OCX_GIT_CONFIG_GUARD_CHECKOUT!, ".git", "config"), "user.name", "probe-private-value"]);
});
`, { OCX_GIT_CONFIG_GUARD_CHECKOUT: guarded });
    expect(probe.exitCode, probe.output).toBe(1);
    expect(probe.output).toContain("(pass) leaves the config alone");
    expect(probe.output).toContain("(fail) writes user.name");
    const report = probe.output.split("\n").find(line => line.includes("changed in the checkout's common .git/config")) ?? "";
    expect(report).toContain("user.name changed");
    expect(report).not.toContain("probe-private-value");
    expect(probe.output).toMatch(/1 pass\s+1 fail/);
  }, { timeout: 90_000 });
});


import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Independent fixture for the retired, formerly shipped hook, not the remover's hash.
const legacyHook = [
  "#!/usr/bin/env sh",
  '# Pre-push hook shim. The actual command list lives in package.json ("prepush").',
  "# Installed by: bun run setup:hooks",
  "set -e",
  "exec bun run prepush",
  "",
].join("\n");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function gitEnv(root: string): NodeJS.ProcessEnv {
  // The test preload retains the real global Git config. Never let it redirect
  // fixture commands or hook writes into the developer's own checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".fixture-gitconfig") };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: gitEnv(root), encoding: "utf8", stdio: "pipe" }).trim();
}

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-hook-setup-")));
  roots.push(root);
  git(root, "init", "--quiet");
  mkdirSync(join(root, "scripts"));
  for (const name of ["setup-hooks.ts", "post-merge.sh"]) {
    copyFileSync(repoPath("scripts", name), join(root, "scripts", name));
  }
  return root;
}

function setup(root: string): string {
  return execFileSync(process.execPath, [join(root, "scripts/setup-hooks.ts")], {
    cwd: root, env: gitEnv(root), encoding: "utf8", timeout: 10_000, stdio: "pipe",
  });
}

function hooks(root: string): string {
  const path = git(root, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  // A linked worktree resolves to its parent fixture's shared hooks directory.
  expect(roots.some(fixtureRoot => {
    const rel = relative(fixtureRoot, path);
    return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
  })).toBe(true);
  return path;
}

describe("local hook setup", () => {
  test("fixture harness isolates inherited global hooks and Git directory overrides", () => {
    const external = fixture();
    const externalHook = join(hooks(external), "pre-push");
    writeFileSync(externalHook, "user-owned hook\n");
    const globalConfig = join(external, "global-config");
    git(external, "config", "--file", globalConfig, "core.hooksPath", hooks(external));
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedDir = process.env.GIT_DIR;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_DIR = join(external, ".git");
      const root = fixture();
      setup(root);
      expect(existsSync(join(hooks(root), "pre-push"))).toBe(false);
      expect(readFileSync(externalHook, "utf8")).toBe("user-owned hook\n");
      expect(existsSync(join(hooks(external), "post-merge"))).toBe(false);
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
    }
  });

  test("fresh setup installs only post-merge and is idempotent", () => {
    const root = fixture();
    setup(root);
    const hookDir = hooks(root);
    expect(existsSync(join(hookDir, "pre-push"))).toBe(false);
    expect(readFileSync(join(hookDir, "post-merge"), "utf8"))
      .toBe(readFileSync(repoPath("scripts/post-merge.sh"), "utf8"));
    setup(root);
    expect(readdirSync(hookDir).filter(name => name.startsWith("post-merge.backup-"))).toEqual([]);
  });

  for (const ending of ["\n", "\r\n"]) {
    test(`retires the shipped hook with ${JSON.stringify(ending)} line endings`, () => {
      const root = fixture();
      writeFileSync(join(hooks(root), "pre-push"), legacyHook.replace(/\n/g, ending));
      setup(root);
      expect(existsSync(join(hooks(root), "pre-push"))).toBe(false);
      expect(existsSync(join(hooks(root), "post-merge"))).toBe(true);
    });
  }

  test("preserves custom hooks even when they contain the old shim", () => {
    const root = fixture();
    const custom = legacyHook + "echo custom validation\n";
    writeFileSync(join(hooks(root), "pre-push"), custom);
    setup(root);
    expect(readFileSync(join(hooks(root), "pre-push"), "utf8")).toBe(custom);
  });

  test("uses a configured hooks directory without touching the default one", () => {
    const root = fixture();
    const original = hooks(root);
    writeFileSync(join(original, "pre-push"), legacyHook);
    const customDir = join(root, "custom hooks");
    mkdirSync(customDir);
    writeFileSync(join(customDir, "pre-push"), legacyHook);
    git(root, "config", "core.hooksPath", customDir);
    setup(root);
    expect(existsSync(join(customDir, "pre-push"))).toBe(false);
    expect(existsSync(join(customDir, "post-merge"))).toBe(true);
    expect(readFileSync(join(original, "pre-push"), "utf8")).toBe(legacyHook);
  });

  test("linked worktrees migrate the Git-resolved shared hooks directory", () => {
    const root = fixture();
    git(root, "add", "scripts");
    git(root, "-c", "user.name=Fixture", "-c", `user.email=${["fixture", "example.invalid"].join("@")}`,
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    const linked = join(root, "linked");
    git(root, "worktree", "add", "--detach", linked);
    const shared = hooks(root);
    writeFileSync(join(shared, "pre-push"), legacyHook);
    setup(linked);
    expect(hooks(linked)).toBe(shared);
    expect(existsSync(join(shared, "pre-push"))).toBe(false);
    expect(existsSync(join(shared, "post-merge"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("preserves symlinked pre-push hooks", () => {
    const root = fixture();
    const target = join(root, "user-hook");
    writeFileSync(target, legacyHook);
    const hook = join(hooks(root), "pre-push");
    symlinkSync(target, hook);
    setup(root);
    expect(lstatSync(hook).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(legacyHook);
  });
});

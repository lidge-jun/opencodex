import { afterAll, beforeAll, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installCodexShim } from "../../src/codex/shim";
import { removeTreeWithRetry } from "./remove-tree";

/**
 * Installs against throwaway native launchers and HOME/OPENCODEX_HOME/CODEX_HOME.
 * Exposes the private Unix overlay or Windows in-place wrappers and recorded native launchers,
 * then restores the environment and removes both temporary trees.
 *
 * This lived inside tests/codex-integration/codex-shim.test.ts until a second file needed it.
 * Copying it would have been the cheaper edit and the wrong one: the fixture owns the contract
 * that every shim test starts from a clean install, and two copies drift the moment one of them
 * learns something about Windows wrappers that the other does not.
 */
export function prependPath(dir: string, current: string | undefined): string {
  return [dir, current].filter(Boolean).join(delimiter);
}

export function withInstalledShim(run: (paths: {
  binDir: string;
  home: string;
  wrappers: string[];
  backups: string[];
  launchers: string[];
  statePath: string;
}) => void): void {
  const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-bin-"));
  const home = mkdtempSync(join(tmpdir(), "ocx-shim-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.OPENCODEX_HOME;
  const oldUserHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const wrappers = process.platform === "win32"
    ? [join(binDir, "codex.cmd"), join(binDir, "codex.ps1"), join(binDir, "codex")]
    : [join(binDir, "codex")];
  try {
    process.env.PATH = prependPath(binDir, oldPath);
    process.env.OPENCODEX_HOME = home;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, "codex-home");
    mkdirSync(process.env.CODEX_HOME);
    for (const wrapper of wrappers) {
      writeFileSync(wrapper, process.platform === "win32" ? `real ${wrapper}\n` : "#!/bin/sh\necho real\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
    }
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    const statePath = join(home, "codex-shim.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { schema?: number; wrapperPath: string; launcherPath?: string; wrappers?: Array<{ wrapperPath: string; backupPath: string }> };
    const launchers = state.schema === 2 ? [state.launcherPath!] : state.wrappers!.map(file => file.backupPath);
    run({
      binDir,
      home,
      wrappers: state.schema === 2 ? [state.wrapperPath] : state.wrappers!.map(file => file.wrapperPath),
      // Compatibility for legacy callers; overlay launchers are never renamed backups.
      backups: launchers,
      launchers,
      statePath,
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    if (oldUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldUserHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    removeTreeWithRetry(binDir);
    removeTreeWithRetry(home);
  }
}

/** Isolate template and direct-install tests that do not use withInstalledShim. */
export function isolateCodexShimEnvironment(): void {
  const keys = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
  let root: string;
  let saved: Array<string | undefined>;
  beforeAll(() => {
    saved = keys.map(key => process.env[key]);
    root = mkdtempSync(join(tmpdir(), "ocx-shim-environment-"));
    for (const key of keys) {
      process.env[key] = join(root, key);
      mkdirSync(process.env[key]!);
    }
  });
  afterAll(() => {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    removeTreeWithRetry(root);
  });
}

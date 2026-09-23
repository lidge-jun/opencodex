import { expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installCodexShim } from "../../src/codex/shim";
import { removeTreeWithRetry } from "./remove-tree";

/**
 * Installs a real Codex shim over a throwaway PATH entry and a throwaway OPENCODEX_HOME, hands
 * the resolved wrapper and backup paths to the caller, and restores both environment variables
 * and removes both temporary trees afterwards.
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
  statePath: string;
}) => void): void {
  const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-bin-"));
  const home = mkdtempSync(join(tmpdir(), "ocx-shim-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.OPENCODEX_HOME;
  const wrappers = process.platform === "win32"
    ? [join(binDir, "codex.cmd"), join(binDir, "codex.ps1"), join(binDir, "codex")]
    : [join(binDir, "codex")];
  try {
    process.env.PATH = prependPath(binDir, oldPath);
    process.env.OPENCODEX_HOME = home;
    for (const wrapper of wrappers) {
      writeFileSync(wrapper, process.platform === "win32" ? `real ${wrapper}\n` : "#!/bin/sh\necho real\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
    }
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    const statePath = join(home, "codex-shim.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { wrappers: Array<{ wrapperPath: string; backupPath: string }> };
    run({
      binDir,
      home,
      wrappers: state.wrappers.map(file => file.wrapperPath),
      backups: state.wrappers.map(file => file.backupPath),
      statePath,
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(binDir);
    removeTreeWithRetry(home);
  }
}

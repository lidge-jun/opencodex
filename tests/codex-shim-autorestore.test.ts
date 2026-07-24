import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexShimAutoRestoreResult } from "../src/codex/shim";
import { getDefaultConfig } from "../src/config";
import {
  maybeAutoRestoreCodexShim,
  skipsCodexShimAutoRestore,
  type CodexShimAutoRestoreCliDeps,
} from "../src/cli/codex-shim-autorestore";
import { autoRestoreCodexShim, CODEX_SHIM_STATE_MAX_BYTES, installCodexShim } from "../src/codex/shim";

const SHIM_MARKER = "opencodex codex autostart shim";

function cliDeps(
  result: CodexShimAutoRestoreResult,
  overrides: Partial<CodexShimAutoRestoreCliDeps> = {},
): { deps: CodexShimAutoRestoreCliDeps; warnings: string[]; readConfigCalls: () => number } {
  const warnings: string[] = [];
  let configCalls = 0;
  const deps: CodexShimAutoRestoreCliDeps = {
    env: {},
    warn: message => warnings.push(message),
    restore: () => result,
    readConfig: () => {
      configCalls += 1;
      return { config: getDefaultConfig(), source: "default", error: null };
    },
    ...overrides,
  };
  return { deps, warnings, readConfigCalls: () => configCalls };
}

describe("Codex shim CLI auto-restore policy", () => {
  test("skips destructive and explicit repair commands but keeps status and ordinary commands eligible", () => {
    expect(skipsCodexShimAutoRestore("uninstall", ["uninstall"])).toBe(true);
    expect(skipsCodexShimAutoRestore("remove", ["remove"])).toBe(true);
    for (const subcommand of ["install", "uninstall", "remove"]) {
      expect(skipsCodexShimAutoRestore("codex-shim", ["codex-shim", subcommand])).toBe(true);
    }
    expect(skipsCodexShimAutoRestore("codex-shim", ["codex-shim", "status"])).toBe(false);
    expect(skipsCodexShimAutoRestore("status", ["status"])).toBe(false);
  });

  test("restore failure -> warning only, command succeeds", () => {
    const { deps, warnings } = cliDeps({ status: "healthy" }, {
      restore: () => { throw new Error("permission denied"); },
    });

    expect(maybeAutoRestoreCodexShim("status", ["status"], deps)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("continuing without it");
    expect(warnings[0]).toContain("ocx codex-shim install");
  });

  test("successful automatic repair warns exactly once", () => {
    const { deps, warnings } = cliDeps({ status: "restored", message: "restored shim" });
    maybeAutoRestoreCodexShim("status", ["status"], deps);
    expect(warnings).toEqual([expect.stringContaining("automatic repair after Codex update")]);
  });

  test("actionable mixed-sibling deferrals are logged while ordinary deferrals stay silent", () => {
    const { deps, warnings } = cliDeps({
      status: "deferred",
      message: "tracked launcher siblings are in a mixed shim/replacement state",
    });
    maybeAutoRestoreCodexShim("status", ["status"], deps);
    expect(warnings).toEqual([expect.stringContaining("mixed shim/replacement state")]);
  });

  test("healthy, not-installed, disabled, and deferred outcomes stay silent and lazy", () => {
    for (const status of ["healthy", "not-installed", "disabled", "deferred"] as const) {
      const { deps, warnings, readConfigCalls } = cliDeps({ status });
      maybeAutoRestoreCodexShim("status", ["status"], deps);
      expect(warnings).toEqual([]);
      expect(readConfigCalls()).toBe(0);
    }
  });

  test("opt-out config and environment are evaluated lazily only for a candidate", () => {
    for (const [configValue, env] of [[false, {}], [true, { OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "0" }]] as const) {
      let enabledValue: boolean | undefined;
      const { deps, warnings } = cliDeps({ status: "disabled" }, {
        env,
        restore: options => {
          enabledValue = options.enabled();
          return { status: enabledValue ? "deferred" : "disabled" };
        },
        readConfig: () => ({
          config: { ...getDefaultConfig(), codexShimAutoRestore: configValue },
          source: "file",
          error: null,
        }),
      });
      maybeAutoRestoreCodexShim("status", ["status"], deps);
      expect(enabledValue).toBe(false);
      expect(warnings).toEqual([]);
    }
  });

  test("oversized shim state is bounded, skipped, and warned without loading config", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-oversized-state-"));
    const oldHome = process.env.OPENCODEX_HOME;
    try {
      process.env.OPENCODEX_HOME = home;
      const statePath = join(home, "codex-shim.json");
      writeFileSync(statePath, Buffer.alloc(CODEX_SHIM_STATE_MAX_BYTES + 1, 0x20));
      const before = readFileSync(statePath);
      const { deps, warnings, readConfigCalls } = cliDeps({ status: "healthy" }, {
        restore: autoRestoreCodexShim,
      });

      maybeAutoRestoreCodexShim("status", ["status"], deps);

      expect(warnings).toEqual([expect.stringContaining("exceeds the 1 MiB startup limit")]);
      expect(readConfigCalls()).toBe(0);
      expect(readFileSync(statePath)).toEqual(before);
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("shim replaced -> next ocx command auto-restores and warns", async () => {
    if (process.platform === "win32") return;
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-activation-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-activation-home-"));
    const wrapper = join(binDir, "codex");
    const backup = join(binDir, "codex.opencodex-real");
    const replacement = "#!/bin/sh\necho externally updated codex\n";
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    try {
      process.env.PATH = binDir;
      process.env.OPENCODEX_HOME = home;
      writeFileSync(wrapper, "#!/bin/sh\necho original codex\n", "utf8");
      chmodSync(wrapper, 0o755);
      expect(installCodexShim().installed).toBe(true);
      writeFileSync(wrapper, replacement, "utf8");
      chmodSync(wrapper, 0o755);
      await Bun.sleep(120);

      const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "cli", "index.ts"), "codex-shim", "status"], {
        encoding: "utf8",
        env: { ...process.env, PATH: binDir, OPENCODEX_HOME: home },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("automatic repair after Codex update");
      expect(result.stdout).toContain("wrapper shim present");
      expect(readFileSync(wrapper, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(backup, "utf8")).toBe(replacement);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

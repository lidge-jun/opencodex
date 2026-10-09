import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRestoreCodexShim, buildWindowsCodexShim, installCodexShim } from "../../src/codex/shim";
import { RuntimePreflightError, type RuntimePreflightReason } from "../../src/lib/bun-runtime-preflight";
import type { DurableBunRuntime } from "../../src/lib/bun-runtime";
import { maybeAutoRestoreCodexShim } from "../../src/cli/codex-shim-autorestore";
import { getDefaultConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const runtime: DurableBunRuntime = { path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" };
/** Exercise the Windows shim state machine on every host with only temporary launchers. */
function fixture(run: (paths: { home: string; wrapper: string; backup: string; state: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-shim-runtime-"));
  const home = join(root, "home"); const bin = join(root, "bin");
  mkdirSync(home); mkdirSync(bin);
  const wrapper = join(bin, "codex.cmd"); const backup = join(bin, "codex.opencodex-real.cmd"); const state = join(home, "codex-shim.json");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const keys = ["HOME", "OPENCODEX_HOME", "CODEX_HOME", "PATH"] as const;
  const saved = keys.map(key => process.env[key]);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    process.env.HOME = home; process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = join(home, "codex-home"); process.env.PATH = bin;
    writeFileSync(wrapper, "@echo replacement\r\n"); writeFileSync(backup, "@echo original\r\n");
    writeFileSync(state, JSON.stringify({ platform: "win32", wrapperPath: wrapper, originalPath: wrapper, backupPath: backup,
      wrappers: [{ wrapperPath: wrapper, originalPath: wrapper, backupPath: backup }] }));
    run({ home, wrapper, backup, state });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    removeTreeWithRetry(root);
  }
}

function snapshot(paths: { home: string; wrapper: string; backup: string; state: string }): unknown {
  return { wrapper: readFileSync(paths.wrapper, "utf8"), backup: readFileSync(paths.backup, "utf8"), state: readFileSync(paths.state, "utf8"), entries: readdirSync(paths.home) };
}

describe("Windows shim selected-runtime preflight", () => {
  for (const reason of ["spawn", "timeout", "create", "remove", "protocol"] as RuntimePreflightReason[]) {
    test(`${reason} stops explicit refresh before rename, wrapper or state writes`, () => fixture(paths => {
      const before = snapshot(paths);
      expect(() => installCodexShim({ selectRuntime: () => runtime, assertRuntimeWritable: () => { throw new RuntimePreflightError(reason); } })).toThrow(RuntimePreflightError);
      expect(snapshot(paths)).toEqual(before);
    }));
    test(`${reason} defers automatic restore before acquiring a lock, and startup continues with guidance`, () => fixture(paths => {
      const before = snapshot(paths);
      let locked = false;
      const result = autoRestoreCodexShim({ enabled: () => true, selectRuntime: () => runtime,
        assertRuntimeWritable: () => { throw new RuntimePreflightError(reason); },
        afterRestoreLockAcquired: () => { locked = true; }, stabilitySleep: () => {},
      });
      expect(result.status).toBe("deferred");
      expect("message" in result && result.message).toContain("OPENCODEX_BUN_PATH");
      expect(locked).toBe(false); expect(snapshot(paths)).toEqual(before);
      const warnings: string[] = [];
      expect(maybeAutoRestoreCodexShim("start", ["start"], { env: {}, warn: message => warnings.push(message), restore: () => result,
        readConfig: () => ({ config: getDefaultConfig(), source: "default", error: null }),
      })).toBeUndefined();
      expect(warnings).toEqual([expect.stringContaining("npm install -g opencodex")]);
    }));
  }

  test("fresh install refuses before moving the native launcher or creating state", () => fixture(paths => {
    // No valid prior installation: explicit install must still admit before its first move.
    writeFileSync(paths.state, "{}");
    const before = snapshot(paths);
    expect(() => installCodexShim({ selectRuntime: () => runtime, assertRuntimeWritable: () => { throw new RuntimePreflightError("create"); } })).toThrow(RuntimePreflightError);
    expect(snapshot(paths)).toEqual(before);
  }));

  test("fresh install admits once before the first move and freezes all wrapper rendering", () => fixture(paths => {
    unlinkSync(paths.state); unlinkSync(paths.backup);
    const original = readFileSync(paths.wrapper, "utf8");
    const selected = { ...runtime }; let probes = 0;
    const result = installCodexShim({ selectRuntime: () => selected,
      assertRuntimeWritable: admitted => {
        probes++; expect(admitted).toEqual(runtime); expect(Object.isFrozen(admitted)).toBe(true);
        expect(readFileSync(paths.wrapper, "utf8")).toBe(original);
        expect(existsSync(paths.state)).toBe(false); expect(existsSync(paths.backup)).toBe(false);
        selected.path = "unprobed.exe"; selected.source = "process";
      },
    });
    expect(result.installed).toBe(true); expect(probes).toBe(1);
    expect(readFileSync(paths.wrapper, "utf8")).toContain(runtime.path);
    expect(readFileSync(paths.wrapper, "utf8")).toContain('OCX_BUN_RUNTIME_SOURCE=override');
    expect(readFileSync(paths.wrapper, "utf8")).not.toContain("unprobed.exe");
    expect(readFileSync(paths.backup, "utf8")).toBe(original);
  }));

  test("healthy and disabled shims perform zero runtime selections and zero probes", () => fixture(paths => {
    const unexpected = () => { throw new Error("unexpected probe or selection"); };
    const disabled = autoRestoreCodexShim({ enabled: () => false, selectRuntime: unexpected, assertRuntimeWritable: unexpected });
    expect(disabled.status).toBe("disabled");
    writeFileSync(paths.wrapper, buildWindowsCodexShim(paths.backup, runtime.path, "cli.ts", runtime.source));
    const before = snapshot(paths);
    expect(autoRestoreCodexShim({ enabled: unexpected, selectRuntime: unexpected, assertRuntimeWritable: unexpected }).status).toBe("healthy");
    expect(installCodexShim({ selectRuntime: unexpected, assertRuntimeWritable: unexpected }).installed).toBe(false);
    expect(snapshot(paths)).toEqual(before);
  }));

  test("automatic refresh bakes the frozen admitted path/source after selection changes", () => fixture(paths => {
    const selected = { ...runtime }; let selections = 0; let probes = 0;
    const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {},
      selectRuntime: () => { selections++; return selected; },
      assertRuntimeWritable: admitted => { probes++; expect(admitted).toEqual(runtime); selected.path = "unprobed.exe"; selected.source = "process"; },
    });
    expect(result.status).toBe("restored"); expect(selections).toBe(1); expect(probes).toBe(1);
    const wrapper = readFileSync(paths.wrapper, "utf8");
    expect(wrapper).toContain(runtime.path); expect(wrapper).toContain('OCX_BUN_RUNTIME_SOURCE=override'); expect(wrapper).not.toContain("unprobed.exe");
    expect(readFileSync(paths.backup, "utf8")).toContain("replacement");
    expect(existsSync(join(paths.home, "codex-shim.autorestore.lock"))).toBe(false);
  }));
});

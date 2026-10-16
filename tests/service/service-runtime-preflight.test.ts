import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSelectedRuntimeWritable, RuntimePreflightError, type RuntimePreflightReason } from "../../src/lib/bun-runtime-preflight";
import { durableBunRuntime, BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, type DurableBunRuntime } from "../../src/lib/bun-runtime";
import { installServiceSafely, installFreshWindowsSchedulerSafely, platformOps } from "../../src/service/orchestration";
import { installWindows, installWindowsNative, type WindowsServiceInstallDeps } from "../../src/service/windows-ops";
import { repairService } from "../../src/service/repair";
import { cliEntry, writeServiceInstallState } from "../../src/service/state";
import { buildWindowsServiceScript } from "../../src/service/windows-taskxml";
import { defaultWinswEntry } from "../../src/lib/winsw";
import { recordOwnedConfigPath, CONFIG_OWNER_FILE, CONFIG_UNINSTALL_MANIFEST } from "../../src/lib/config-ownership";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";
import { windowsEnvIndirectBatchValue } from "../../src/lib/win-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const runtime: DurableBunRuntime = { path: process.execPath, source: "override", overrideEnv: "OPENCODEX_BUN_PATH" };
/** The service script writes a profile-located Bun as a %LOCALAPPDATA%/%USERPROFILE% token with batch escaping. */
const bunLine = () => `set "OCX_BUN=${windowsEnvIndirectBatchValue(runtime.path, v => v.replace(/%/g, "%%").replace(/\^/g, "^^").replace(/"/g, ""))}"`;
const roots: string[] = [];
const envKeys = ["OPENCODEX_HOME", "CODEX_HOME", BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV] as const;
const originalEnv = envKeys.map(key => process.env[key]);
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-service-runtime-")); roots.push(dir); return dir;
}
afterEach(() => {
  for (const [index, key] of envKeys.entries()) {
    if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index];
  }
  for (const dir of roots.splice(0)) removeTreeWithRetry(dir);
});
const diagnostic: ServiceDiagnostic = {
  supported: true, installed: true, enabled: true, running: true, viable: true,
  startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test",
};

describe("service selected-runtime admission", () => {
  for (const reason of ["spawn", "timeout", "create", "remove", "protocol"] as RuntimePreflightReason[]) {
    test(`${reason} refuses before disruption and rolls back fresh registration after ownership`, async () => {
      const effects: string[] = [];
      const deny = () => { throw new RuntimePreflightError(reason); };
      const deps = { platform: "win32" as const, selectRuntime: () => runtime, configDir: () => temporary(), assertRuntimeWritable: deny };
      await expect(installServiceSafely("scheduler", () => { effects.push("install"); }, {
        ...deps, diagnose: () => { effects.push("diagnose"); return diagnostic; },
        managerOps: () => ({ status: () => "present", stop: () => { effects.push("stop"); } }),
        stopTrackedProxy: async () => { effects.push("proxy"); },
      })).rejects.toMatchObject({ code: "OCX_RUNTIME_PREFLIGHT_FAILED", reason });
      const home = join(temporary(), "absent-home");
      const freshOrder: string[] = [];
      await expect(installFreshWindowsSchedulerSafely({
        ...deps, configDir: () => home,
        assertRuntimeWritable: (_selected, _root, options) => {
          expect(options?.rootWasAbsent).toBe(false); freshOrder.push("preflight"); deny();
        },
        stageRegistrationXml: () => { expect(existsSync(home)).toBe(false); freshOrder.push("stage"); return "stage"; },
        register: async () => { freshOrder.push("register"); }, removeStagedXml: () => {},
        recordOwnership: () => { freshOrder.push("ownership"); return recordOwnedConfigPath(home, join(home, "service-state.json")); },
        prepare: async () => { freshOrder.push("prepare"); effects.push("stop"); },
        removeNativeService: () => { freshOrder.push("remove"); }, publishAssets: () => { freshOrder.push("assets"); },
        verifyBeforeRun: () => { freshOrder.push("verify"); }, runTask: () => { freshOrder.push("run"); },
        writeState: () => { freshOrder.push("state"); },
        rollbackTask: async () => { freshOrder.push("rollback"); return null; },
      })).rejects.toThrow(`${new RuntimePreflightError(reason).message}\nThe new Task Scheduler registration was rolled back.`);
      expect(freshOrder).toEqual(["stage", "register", "ownership", "preflight", "rollback"]);
      expect(existsSync(join(home, CONFIG_OWNER_FILE))).toBe(true);
      expect(() => installWindows(undefined, deps)).toThrow(RuntimePreflightError);
      await expect(installWindowsNative(undefined, deps)).rejects.toThrow(RuntimePreflightError);
      for (const backend of ["scheduler", "native"] as const) {
        await expect(repairService({
          ...deps, diagnose: () => ({ ...diagnostic, backend }), readOwnership: () => ({ kind: "none", revision: 0 }),
          assertEnv: () => { effects.push("env"); }, assertAuth: () => { effects.push("token"); },
          writeSchedulerAssets: () => { effects.push("assets"); }, stopScheduler: () => { effects.push("stop"); },
          repairNative: () => { effects.push("download/xml"); }, writeNativeState: () => { effects.push("state"); },
        })).rejects.toMatchObject({ code: "OCX_RUNTIME_PREFLIGHT_FAILED", reason });
      }
      expect(effects).toEqual(["env", "token", "env", "token"]);
    });
  }

  test("generic install freezes the admitted selection before stopping any manager", async () => {
    const selected = { ...runtime };
    const order: string[] = [];
    let selections = 0;
    await installServiceSafely("scheduler", admitted => {
      order.push("install"); expect(admitted).toEqual(runtime); expect(Object.isFrozen(admitted)).toBe(true);
    }, {
      platform: "win32", configDir: temporary, selectRuntime: () => { selections++; return selected; },
      assertRuntimeWritable: admitted => { order.push("preflight"); expect(admitted).toEqual(runtime); selected.path = "unprobed.exe"; },
      diagnose: () => diagnostic,
      managerOps: () => ({ status: () => "present", stop: () => { order.push("stop"); } }),
      stopTrackedProxy: async () => { order.push("proxy"); },
    });
    expect(selections).toBe(1);
    expect(order).toEqual(["preflight", "stop", "proxy", "install"]);
  });

  for (const backend of ["scheduler", "native"] as const) {
    for (const refuses of [true, false]) {
      test(`${backend} composed install ${refuses ? "refuses before stop" : "never admits again after stop"}`, async () => {
        const home = temporary(); process.env.OPENCODEX_HOME = home;
        const selected = { ...runtime };
        const order: string[] = [];
        const seen: DurableBunRuntime[] = [];
        let probes = 0, selections = 0;
        const admission = {
          platform: "win32" as const, configDir: () => home,
          selectRuntime: () => { selections++; return selected; },
          assertRuntimeWritable: (admitted: DurableBunRuntime) => {
            order.push("preflight"); probes++; seen.push(admitted);
            if (refuses || probes > 1) throw new RuntimePreflightError("create");
            selected.path = "unprobed.exe";
          },
        };
        const effects: WindowsServiceInstallDeps = {
          ...admission,
          recordSchedulerOwnership: () => { order.push("ownership"); return true; },
          removeNativeService: () => { order.push("remove-native"); },
          stopScheduler: () => { order.push("installer-stop"); },
          writeSchedulerAssets: admitted => {
            seen.push(admitted); order.push("assets");
            expect(buildWindowsServiceScript(cliEntry(admitted), 12345, [])).toContain(bunLine());
          },
          schedulerCommand: args => { order.push(args[0]!); return ""; },
          assertNativeAccount: () => { order.push("account"); },
          prepareNativeConfig: () => { order.push("native-config"); },
          uninstallScheduler: () => { throw new Error("no scheduler to uninstall"); },
          installNativeService: async entry => {
            order.push("winsw"); expect(entry.bun).toBe(runtime.path); expect(entry.bunRuntimeSource).toBe(runtime.source);
          },
          writeState: (installedBackend, admitted) => {
            expect(installedBackend).toBe(backend); seen.push(admitted); order.push("state");
            writeServiceInstallState(installedBackend, undefined, { paths: [join(home, "state.json")] }, admitted);
          },
        };
        const ops = platformOps(backend, { platform: "win32", windowsInstall: effects })!;
        const result = installServiceSafely(backend, ops.install, {
          ...admission, diagnose: () => ({ ...diagnostic, backend }),
          managerOps: () => ({ status: () => "present", stop: () => { order.push("stop"); } }),
          stopTrackedProxy: async () => { order.push("proxy"); },
        });
        if (refuses) {
          await expect(result).rejects.toMatchObject({ code: "OCX_RUNTIME_PREFLIGHT_FAILED", reason: "create" });
          expect(order).toEqual(["preflight"]); expect(readdirSync(home)).toEqual([]);
        } else {
          await result;
          expect(order).toEqual(backend === "scheduler"
            ? ["preflight", "stop", "proxy", "ownership", "remove-native", "installer-stop", "assets", "/create", "/run", "state"]
            : ["preflight", "stop", "proxy", "account", "native-config", "/query", "winsw", "state"]);
          expect(JSON.parse(readFileSync(join(home, "state.json"), "utf8"))).toMatchObject({ backend, bunPath: runtime.path });
        }
        expect(probes).toBe(1); expect(selections).toBe(1);
        for (const admitted of seen) {
          expect(admitted).toBe(seen[0]); expect(admitted).toEqual(runtime); expect(Object.isFrozen(admitted)).toBe(true);
        }
      });
    }

    test(`${backend} direct public installer admits before committing`, async () => {
      const home = temporary(); process.env.OPENCODEX_HOME = home;
      const order: string[] = [];
      let probes = 0;
      const deps: WindowsServiceInstallDeps = {
        platform: "win32", configDir: () => home, selectRuntime: () => runtime,
        assertRuntimeWritable: admitted => { probes++; order.push("preflight"); expect(Object.isFrozen(admitted)).toBe(true); },
        recordSchedulerOwnership: () => true, removeNativeService: () => {}, stopScheduler: () => { order.push("stop"); },
        writeSchedulerAssets: () => { order.push("assets"); }, schedulerCommand: () => "",
        assertNativeAccount: () => {}, prepareNativeConfig: () => { order.push("config"); },
        installNativeService: async () => { order.push("winsw"); }, writeState: () => { order.push("state"); },
      };
      if (backend === "scheduler") installWindows(undefined, deps);
      else await installWindowsNative(undefined, deps);
      expect(probes).toBe(1);
      expect(order).toEqual(backend === "scheduler" ? ["preflight", "stop", "assets", "state"] : ["preflight", "config", "winsw", "state"]);
    });
  }

  test("fresh absent root clears stale ownership refusal before preflight and preparation", async () => {
    const home = join(temporary(), "absent-home");
    mkdirSync(home); writeFileSync(join(home, "legacy.txt"), "keep");
    expect(recordOwnedConfigPath(home, join(home, "service-state.json"))).toBe(false);
    removeTreeWithRetry(home);
    const order: string[] = [];
    const selected = { ...runtime };
    let selections = 0;
    await installFreshWindowsSchedulerSafely({
      platform: "win32", configDir: () => home, selectRuntime: () => { selections++; return selected; },
      assertRuntimeWritable: (admitted, root, options) => {
        expect(options?.rootWasAbsent).toBe(false);
        expect(existsSync(join(home, CONFIG_OWNER_FILE))).toBe(true);
        expect(admitted).toEqual(runtime); expect(Object.isFrozen(admitted)).toBe(true);
        assertSelectedRuntimeWritable(admitted, root, options); order.push("preflight");
      },
      stageRegistrationXml: () => {
        expect(existsSync(home)).toBe(false); selected.path = "unprobed.exe"; order.push("stage"); return "stage";
      },
      register: async () => { order.push("register"); }, removeStagedXml: () => {},
      recordOwnership: () => { order.push("ownership"); return recordOwnedConfigPath(home, join(home, "service-state.json")); },
      prepare: async () => { order.push("prepare"); }, removeNativeService: () => { order.push("remove"); },
      publishAssets: admitted => { expect(admitted).toEqual(runtime); order.push("assets"); },
      verifyBeforeRun: () => { order.push("verify"); }, runTask: () => { order.push("run"); }, writeState: () => { order.push("state"); },
      rollbackTask: async () => { order.push("rollback"); return null; },
    });
    expect(selections).toBe(1);
    expect(order).toEqual(["stage", "register", "ownership", "preflight", "prepare", "remove", "assets", "verify", "run", "state"]);
    expect(existsSync(join(home, CONFIG_OWNER_FILE))).toBe(true);
  });

  test("fresh denied absent root retains ownership and rolls back registration before preparation", async () => {
    const home = join(temporary(), "absent-home");
    const order: string[] = [];
    let registeredNonce = "", rolledBackNonce = "";
    await expect(installFreshWindowsSchedulerSafely({
      platform: "win32", configDir: () => home, selectRuntime: () => ({ ...runtime, path: join(home, "missing.exe") }),
      assertRuntimeWritable: (selected, root, options) => {
        order.push("preflight"); expect(options?.rootWasAbsent).toBe(false);
        assertSelectedRuntimeWritable(selected, root, options);
      },
      stageRegistrationXml: () => { expect(existsSync(home)).toBe(false); order.push("stage"); return "stage"; },
      register: async (_path, nonce) => { registeredNonce = nonce; order.push("register"); }, removeStagedXml: () => {},
      recordOwnership: () => { order.push("ownership"); return recordOwnedConfigPath(home, join(home, "service-state.json")); },
      prepare: async () => { order.push("prepare"); order.push("stop"); }, removeNativeService: () => { order.push("remove"); },
      publishAssets: () => { order.push("assets"); }, verifyBeforeRun: () => { order.push("verify"); },
      runTask: () => { order.push("run"); }, writeState: () => { order.push("state"); },
      rollbackTask: async nonce => { rolledBackNonce = nonce; order.push("rollback"); return null; },
    })).rejects.toThrow(`${new RuntimePreflightError("spawn").message}\nThe new Task Scheduler registration was rolled back.`);
    expect(order).toEqual(["stage", "register", "ownership", "preflight", "rollback"]);
    expect(registeredNonce).not.toBe(""); expect(rolledBackNonce).toBe(registeredNonce);
    expect(existsSync(join(home, CONFIG_OWNER_FILE))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, CONFIG_UNINSTALL_MANIFEST), "utf8")).paths).toContain("service-state.json");
    expect(existsSync(join(home, "service-state.json"))).toBe(false);
  });

  test("selection changes after admission cannot change scheduler rendering, WinSW entry or install state", async () => {
    const home = temporary();
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    process.env[BUN_RUNTIME_PATH_ENV] = runtime.path;
    process.env[BUN_RUNTIME_SOURCE_ENV] = runtime.source;
    let selections = 0;
    const state = join(home, "state.json");
    await installFreshWindowsSchedulerSafely({
      platform: "win32", configDir: () => home, selectRuntime: () => { selections++; return durableBunRuntime(); },
      assertRuntimeWritable: () => {},
      stageRegistrationXml: () => "stage", register: async () => {}, removeStagedXml: () => {}, recordOwnership: () => true,
      prepare: async () => { process.env[BUN_RUNTIME_SOURCE_ENV] = "process"; }, removeNativeService: () => {},
      publishAssets: selected => {
        expect(durableBunRuntime().source).toBe("process");
        expect(selected).toEqual(runtime);
        expect(buildWindowsServiceScript(cliEntry(selected), 12345, [])).toContain('set "OCX_BUN_RUNTIME_SOURCE=override"');
        expect(defaultWinswEntry("source", selected)).toMatchObject({ bun: runtime.path, bunRuntimeSource: "override" });
      }, verifyBeforeRun: () => {}, runTask: () => {},
      writeState: selected => writeServiceInstallState("scheduler", undefined, { paths: [state] }, selected),
    });
    expect(selections).toBe(1);
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ bunPath: runtime.path, backend: "scheduler" });
    // A distinct selected path also survives the state writer's default selector.
    const distinct = { ...runtime, path: join(home, "selected.exe") };
    writeServiceInstallState("native", undefined, { paths: [state] }, distinct);
    expect(JSON.parse(readFileSync(state, "utf8")).bunPath).toBe(distinct.path);
  });

  test("native repair uses one frozen admitted runtime for both rendering and state", async () => {
    const selected = { ...runtime };
    const seen: DurableBunRuntime[] = [];
    await repairService({
      platform: "win32", configDir: temporary, selectRuntime: () => selected,
      diagnose: () => ({ ...diagnostic, backend: "native" }), readOwnership: () => ({ kind: "none", revision: 0 }),
      assertRuntimeWritable: admitted => { seen.push(admitted); selected.path = "unprobed.exe"; },
      assertEnv: () => {}, assertAuth: () => {}, launcherPathDiagnostic: () => null,
      repairNative: admitted => { seen.push(admitted); }, writeNativeState: admitted => { seen.push(admitted); },
    });
    expect(seen).toEqual([runtime, runtime, runtime]);
    expect(seen[0]).toBe(seen[1]); expect(seen[1]).toBe(seen[2]);
  });

  test("preflight stays outside cliEntry and CLI reports refusal as exit 1", () => {
    const state = readFileSync(repoPath("src/service/state.ts"), "utf8");
    const entry = state.slice(state.indexOf("export function cliEntry("), state.indexOf("export function serviceLauncherPathDiagnostic"));
    expect(entry).not.toContain("assertSelectedRuntimeWritable");
    const cli = readFileSync(repoPath("src/service/cli.ts"), "utf8");
    expect(cli).toContain("process.exitCode = 1");
  });
});

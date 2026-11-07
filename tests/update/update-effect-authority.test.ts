import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { createUpdateServiceHomePolicy } from "../../src/update/service-home-policy.mjs";
import { guardedRun, materializeMutationData, UpdateMutationRefusedError } from "../../src/update/mutation-guard.mjs";

// Execute the production orchestration with only OS I/O replaced. No signals,
// TCP deletions, or service/tray commands reach this machine.
function load(path: string, name: string, deps: object) {
  const text = readFileSync(repoPath(path), "utf8");
  const candidates = [`export function ${name}(`, `export async function ${name}(`, `function ${name}(`];
  const start = candidates.map(c => text.indexOf(c)).find(n => n >= 0) ?? -1;
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\nexport ", start + 1);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text.slice(start, end < 0 ? undefined : end).replace("export ", ""));
  return new Function("deps", `with(deps){${js};return ${name};}`)(deps);
}
function adapter(name: string, deps: object) {
  const path = name === "guardedStopWindowsTray" ? "src/update/guarded-tray-ops.ts" : "src/update/guarded-runtime-ops.ts";
  const text = readFileSync(repoPath(path), "utf8").replace(/^import .+;\r?$/gm, "").replace(/^export \{.+\};\r?$/gm, "").replace(/^export /gm, "");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
  return new Function("deps", `with(deps){${js};return ${name};}`)({ guardedRun, materializeMutationData, UpdateMutationRefusedError, ...deps });
}

for (const phase of ["identity", "liveness", "kill-liveness", "escalation", "stable"])
  test(`reclaim carries authority to every signal after ${phase}`, async () => {
    let home: "same" | "unknown" = "same", aliveReads = 0, waits = 0, probes = 0;
    const signals: string[] = [];
    const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
    const kill = load("src/lib/process-control.ts", "killProxy", {
      process: { platform: "linux", kill: (_: number, signal: string) => { signals.push(signal); } },
      isProcessAlive: () => { if (phase === "kill-liveness") home = "unknown"; return true; },
      waitForExit: () => { if (++waits === 1 && phase === "escalation") home = "unknown"; return waits > 1; },
    });
    const reclaim = load("src/server/port-reclaim.ts", "reclaimListenPort", {
      process: { platform: "linux", pid: 99 }, killProxy: kill,
      dropWindowsTcpRowsForLocalPort: () => { throw new Error("unexpected TCP path"); },
      normalizeListenPidScan: (pids: number[]) => ({ ok: true, pids }),
    });
    const result = await reclaim(19001, "127.0.0.1", {
      timeoutMs: 500, intervalMs: 0, scanIntervalMs: 0, killOcxHolders: true, onlyKillPids: [4242], dropTcpRows: false,
      isAvailableFn: async () => ++probes > 1,
      listListenPidsFn: () => [4242],
      isAliveFn: () => { if (++aliveReads === 2 && phase === "liveness") home = "unknown"; return true; },
      verifyOcxFn: (pid: number) => { if (aliveReads === 2 && phase === "identity") home = "unknown"; return pid; },
      mayMutateFn: () => policy.authorizeMutation("runtime"), sleepMs: async () => {},
    });
    expect(signals).toEqual(phase === "stable" ? ["SIGTERM", "SIGKILL"] : phase === "escalation" ? ["SIGTERM"] : []);
    expect(result).toBe(phase === "stable");
    if (phase !== "stable") { home = "same"; expect(policy.authorizeMutation("publish")).toBe(false); }
  });

for (const operation of ["wrapper", "winsw", "scheduler", "tray", "pid", "runtime", "registry"])
  for (const changed of [true, false]) test(`leaf ${operation} gates after preparation (${changed})`, () => {
    let home: "same" | "unknown" = "same", effects = 0;
    const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
    const prepare = () => { if (changed) home = "unknown"; return "fixture"; };
    const gate = () => { if (!policy.authorizeMutation(operation === "tray" ? "tray" : ["pid", "runtime", "registry"].includes(operation) ? "runtime" : "service"))
      throw Object.assign(new Error("refused"), { code: "EUPDATEAUTHORITY" }); };
    const effect = () => { effects++; return "stopped"; };
    let invoke: () => unknown;
    if (operation === "wrapper") {
      const fn = load("src/lib/windows-service-wrappers.ts", "killWindowsSchedulerWrappers", {
        process: { platform: "win32" }, resolveTrustedWindowsPowerShellExe: prepare,
        windowsWrapperKillScript: () => "fixture", spawnSync: effect,
      });
      const wrapped = adapter("guardedKillWindowsWrappers", { killWindowsSchedulerWrappers: fn });
      invoke = () => wrapped(policy.authorizeMutation, { scriptPath: "script", launcherPath: "launcher" });
    } else if (operation === "winsw") {
      const run = load("src/lib/winsw.ts", "runWinsw", {
        winswExePath: prepare, execFileSync: effect, SERVICE_STOPWAIT_TIMEOUT_MS: 1, SERVICE_COMMAND_TIMEOUT_MS: 1,
      });
      const fn = load("src/lib/winsw.ts", "stopWinswService", { runWinsw: run, statusWinswRaw: () => "stopped" });
      invoke = () => adapter("guardedStopWinsw", { stopWinswService: fn })(policy.authorizeMutation);
    } else if (operation === "scheduler") {
      const query = load("src/service/windows-scheduler.ts", "querySchtasks", {
        isTestHomeGuardArmed: () => false, querySchtasksForTests: null, windowsSchtasks: prepare, runFile: effect,
      });
      const schtasks = load("src/service/windows-scheduler.ts", "schtasks", { querySchtasks: query, toWindowsSchtasksError: (e: unknown) => e });
      const stop = load("src/service/windows-ops.ts", "stopWindows", { schtasks, TASK: "fixture", isWindowsSchedulerEndBenign: () => false });
      invoke = () => adapter("guardedStopWindows", { stopWindows: stop })(policy.authorizeMutation);
    } else if (operation === "tray") {
      const signal = load("src/tray/windows.ts", "signalTrayStop", {
        readHeartbeat: () => ({}), windowsPowerShellPath: prepare, currentEntry: () => ({}),
        windowsTrayProcessArgs: () => [], execFileSync: effect,
      });
      const fn = load("src/tray/windows.ts", "stopWindowsTray", {
        assertWindows() {}, readHeartbeat: () => ({}), signalTrayStop: signal,
        waitForTrayExit: () => true, getWindowsTrayStatus: () => ({}),
      });
      invoke = () => adapter("guardedStopWindowsTray", { stopWindowsTray: fn })(policy.authorizeMutation);
    } else if (operation === "registry") {
      const fn = load("src/config/owner-registry.ts", "unregisterOwnerRegistryHome", {
        registryEntryPath: prepare, ownerRegistryDir: () => "fixture", unlinkSync: effect,
      });
      invoke = () => fn("fixture", gate);
    } else {
      const fn = load("src/config/process-state.ts", operation === "pid" ? "removePid" : "removeRuntimePort", {
        readPidFileValue: () => 4242, readRuntimePort: () => ({}), getPidPath: prepare,
        getRuntimePortPath: prepare, unlinkSync: effect, unregisterOwnerRegistryHome() {}, getConfigDir: () => "fixture",
      });
      invoke = () => operation === "pid" ? adapter("guardedRemovePid", { removePid: fn })(policy.authorizeMutation, 4242)
        : adapter("guardedRemoveRuntimePort", { removeRuntimePort: fn })(policy.authorizeMutation);
    }
    if (changed) expect(invoke).toThrow(); else invoke();
    expect(effects).toBe(changed ? 0 : 1);
    if (changed) { home = "same"; expect(policy.authorizeMutation("publish")).toBe(false); }
  });

test("Windows kill refusal propagates even when a later liveness check would report exit", () => {
  let reads = 0;
  const fn = adapter("guardedKillProxy", {
    process: { platform: "win32", env: {} }, isProcessAlive: () => ++reads === 1, waitForExit: () => true,
    guardedExecFileSync: () => { throw new UpdateMutationRefusedError(); },
  });
  expect(() => fn(() => false, "runtime", 4242)).toThrow(UpdateMutationRefusedError);
  expect(reads).toBe(1);
});

test("guarded TCP adapter carries the authorizer through netstat preparation", () => {
  let home: "same" | "unknown" = "same", deletions = 0;
  const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const drop = load("src/server/windows-tcp-drop.ts", "dropWindowsTcpRowsForLocalPort", {
    process: { platform: "win32" }, loadSetTcpEntry: () => () => { deletions++; return 0; },
    readNetstatAno: () => { home = "unknown"; return "fixture"; },
    parseTcpQuadsForLocalPort: () => [{ localAddr: "127.0.0.1", remoteAddr: "127.0.0.1", localPort: 19001, remotePort: 20000 }],
    ipv4ToWinUint32: () => 1, htons: (n: number) => n, ptr: () => 0,
  });
  const wrapped = adapter("guardedDropWindowsTcp", { dropWindowsTcpRowsForLocalPort: drop });
  expect(() => wrapped(policy.authorizeMutation, 19001)).toThrow();
  expect(deletions).toBe(0);
});

for (const changed of [true, false]) test(`reclaim default TCP callback retains its gate (${changed})`, async () => {
  let home: "same" | "unknown" = "same", deletions = 0, probes = 0;
  const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const drop = load("src/server/windows-tcp-drop.ts", "dropWindowsTcpRowsForLocalPort", {
    process: { platform: "win32" }, loadSetTcpEntry: () => () => { deletions++; return 0; },
    readNetstatAno: () => { if (changed) home = "unknown"; return "fixture"; },
    parseTcpQuadsForLocalPort: () => [{ localAddr: "127.0.0.1", remoteAddr: "127.0.0.1", localPort: 19001, remotePort: 20000 }],
    ipv4ToWinUint32: () => 1, htons: (n: number) => n, ptr: () => 0,
  });
  const reclaim = load("src/server/port-reclaim.ts", "reclaimListenPort", {
    process: { platform: "win32", pid: 99 }, dropWindowsTcpRowsForLocalPort: drop,
    normalizeListenPidScan: (pids: number[]) => ({ ok: true, pids }),
  });
  const result = await reclaim(19001, "127.0.0.1", {
    timeoutMs: 500, intervalMs: 0, scanIntervalMs: 0, dropTcpRows: true,
    listListenPidsFn: () => [], isAliveFn: () => false, verifyOcxFn: () => null, killFn() {},
    isAvailableFn: async () => ++probes > 1, sleepMs: async () => {}, mayMutateFn: () => policy.authorizeMutation("runtime"),
  });
  expect(result).toBe(!changed); expect(deletions).toBe(changed ? 0 : 1);
});

for (const phase of ["ffi", "netstat", "pointer", "second-row", "stable"])
  test(`TCP deletion authorizes each prepared native row after ${phase}`, () => {
    let home: "same" | "unknown" = "same", deletions = 0;
    const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
    const drop = load("src/server/windows-tcp-drop.ts", "dropWindowsTcpRowsForLocalPort", {
      process: { platform: "win32" },
      loadSetTcpEntry: () => { if (phase === "ffi") home = "unknown"; return () => {
        deletions++; if (phase === "second-row") home = "unknown"; return 0;
      }; },
      readNetstatAno: () => { if (phase === "netstat") home = "unknown"; return "fixture"; },
      parseTcpQuadsForLocalPort: () => Array.from({ length: 2 }, () => ({ localAddr: "127.0.0.1", remoteAddr: "127.0.0.1", localPort: 19001, remotePort: 20000 })),
      ipv4ToWinUint32: () => 1, htons: (n: number) => n,
      ptr: () => { if (phase === "pointer") home = "unknown"; return 0; },
    });
    const invoke = () => drop(19001, () => policy.authorizeMutation("runtime"));
    if (phase === "stable") expect(invoke().dropped).toBe(2);
    else expect(invoke).toThrow();
    expect(deletions).toBe(phase === "stable" ? 2 : phase === "second-row" ? 1 : 0);
    if (phase !== "stable") { home = "same"; expect(policy.authorizeMutation("publish")).toBe(false); }
  });

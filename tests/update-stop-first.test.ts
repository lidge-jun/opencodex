import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNpmCachePreflight } from "../src/update/npm-cache-preflight.mjs";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server", "index.ts"), "utf8");
const dispatchSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "dispatch.ts"), "utf8");

describe("update stops the running proxy before replacing files", () => {
  test("a failed cache pre-flight aborts before the stop callback can run", () => {
    let stopped = false;
    const malformedSpawn = (() => ({ status: 0, signal: null, stdout: "not-json", stderr: "" })) as never;
    const preflight = runNpmCachePreflight({ platform: "linux", spawnSyncFn: malformedSpawn });

    if (preflight.ok) stopped = true;

    expect(preflight).toEqual({ ok: false, reason: "worker_output_malformed" });
    expect(stopped).toBe(false);
  });

  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, selfLaunchArgv(["stop"])');
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const updateAt = updateSource.indexOf("spawnSync(target.bin, target.args");
    expect(stopAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
  });

  test("integrity pre-flight runs BEFORE the stop so anomalous metadata never unloads the proxy", () => {
    const gateAt = updateSource.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const abortAt = updateSource.indexOf("aborting the update before stopping the proxy");
    const stopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    expect(gateAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(stopAt);
    expect(abortAt).toBeLessThan(stopAt);
  });

  test("cache access gates in both CLI entry points precede every tray/proxy stop", () => {
    const runtimeGate = updateSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const runtimeStop = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherGate = launcherSource.indexOf("const cachePreflight = runNpmCachePreflight();");
    const launcherTrayStop = launcherSource.indexOf('runTrayLifecycle(launcher, "stop")');
    const launcherProxyStop = launcherSource.indexOf('[launcher, "stop"]');

    expect(runtimeGate).toBeGreaterThan(-1);
    expect(launcherGate).toBeGreaterThan(-1);
    expect(runtimeGate).toBeLessThan(runtimeStop);
    expect(launcherGate).toBeLessThan(launcherTrayStop);
    expect(launcherGate).toBeLessThan(launcherProxyStop);
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    // #1942: the destructive step is now the transactional staged update, not a direct
    // global npm install. The stop must still precede it.
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(stopAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
    expect(launcherSource).toContain('existsSync(join(configDir(), "runtime-port.json"))');
  });

  test("Windows npm paths resolve safely before stop and never use shell:true", () => {
    const updateResolveAt = updateSource.indexOf("const target = updateSpawnTarget(bin, cmdArgs);");
    const updateStopAt = updateSource.indexOf('selfLaunchArgv(["stop"])');
    const launcherResolveAt = launcherSource.indexOf("const installInvocation = npmInvocation(");
    const launcherStopAt = launcherSource.indexOf('[launcher, "stop"]');

    expect(updateResolveAt).toBeGreaterThan(-1);
    expect(launcherResolveAt).toBeGreaterThan(-1);
    expect(updateResolveAt).toBeLessThan(updateStopAt);
    expect(launcherResolveAt).toBeLessThan(launcherStopAt);
    expect(updateSource).not.toContain("shell: true");
    expect(launcherSource).not.toContain("shell: true");
    expect(updateSource).not.toContain('"npm.cmd"');
    expect(launcherSource).not.toContain('"npm.cmd"');
  });

  test("both paths abort when the stop fails, and REPAIR a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    // 260804 #970: the refresh must not re-register. `install` reaches `schtasks /create`
    // on Windows scheduler backends, which a non-elevated updater cannot run — it would
    // stop a working proxy and then fail to bring its service back.
    expect(updateSource).toContain("serviceReinstallArgs()");
    expect(launcherSource).toContain("aborting the update");
    expect(launcherSource).toContain('"service", "repair"');
    // The launcher still reads service-state.json for service-installed detection, and
    // for the backend choice on the genuinely-absent install fallback.
    expect(launcherSource).toContain('"service-state.json"');
    // That marker can be STALE, so the fallback asks for structured state rather than
    // parsing a failure message; bin/ocx.mjs is plain Node and cannot import
    // diagnoseService(), so it reads startup.serviceInstalled from `status --json`.
    expect(launcherSource).toContain("startup?.serviceInstalled");
    expect(updateSource).toContain("OCX_BAKE_PORT");
    expect(launcherSource).toContain("OCX_BAKE_PORT");
    // Live runtime port 10100 must not be discarded as a missing-port sentinel.
    expect(launcherSource).toContain("sawRuntimePort");
    expect(updateSource).toContain("runtimeTrusted");
  });

  test("both update paths surface a skipped history restore after the stop", () => {
    // A codex-history-backup-*.json surviving `ocx stop` means the native-history restore
    // was skipped (locked state DB) — users must be told or their threads silently stay
    // hidden in the Codex app.
    expect(updateSource).toContain("export function historyRestoreIncomplete(");
    expect(updateSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(updateSource).toContain("if (historyRestoreIncomplete())");
    expect(launcherSource).toContain("function historyRestoreIncomplete()");
    expect(launcherSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(launcherSource).toContain("if (historyRestoreIncomplete())");
    const warnAt = launcherSource.indexOf("Codex resume history was NOT restored");
    const installAt = launcherSource.indexOf("transactionalNpmUpdate({");
    expect(warnAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState)");
    expect(launcherSource).toContain("stopRes.status !== 0 || stillHasRuntimeState");
  });

  test("GUI worker update children use pipe stdio so background updates do not open consoles", () => {
    expect(updateSource).toContain("function updateChildStdio()");
    expect(updateSource).toContain('process.env.OCX_SERVICE === "1"');
    expect(updateSource).toContain('return "pipe"');
    // All three update children (stop, installer, service reinstall) go through it.
    expect(updateSource).toContain("stdio: stopStdio");
    expect(updateSource).toContain("stdio: installStdio");
    expect(updateSource).toContain("stdio: svcStdio");
    expect(updateSource).toContain("windowsHide: true");
  });
});

describe("ocx update --help has no side effects (#168)", () => {
  test("the Bun CLI short-circuits help before importing the update runner", () => {
    const caseAt = dispatchSource.indexOf('update: async');
    const helpAt = dispatchSource.indexOf('printSubcommandUsage("update")');
    const runAt = dispatchSource.indexOf("await runUpdate()");
    expect(caseAt).toBeGreaterThan(-1);
    expect(helpAt).toBeGreaterThan(caseAt);
    expect(helpAt).toBeLessThan(runAt);
  });

  test("the npm launcher intercepts update --help before the self-update path", () => {
    const helpAt = launcherSource.indexOf("updateHelpRequested");
    const updateAt = launcherSource.indexOf("runNpmSelfUpdate();");
    expect(helpAt).toBeGreaterThan(-1);
    expect(launcherSource).toContain('process.argv[2] === "update" &&');
    // The guard that CALLS the self-update must come after the help exit.
    const guardAt = launcherSource.lastIndexOf('process.argv[2] === "update" && isNodeModulesInstall()');
    expect(helpAt).toBeLessThan(guardAt);
    expect(updateAt).toBeGreaterThan(guardAt);
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: healthPort");
  });
});

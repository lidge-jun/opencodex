import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
const updateJobSource = readFileSync(join(import.meta.dir, "..", "src", "update", "job.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server", "index.ts"), "utf8");
const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

describe("update stops the running proxy before replacing files", () => {
  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, [process.argv[1], "stop"]');
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    const updateAt = updateSource.indexOf("const { bin, args: cmdArgs } = updateCommand(installer, tag, latest);");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
  });

  test("integrity pre-flight runs BEFORE the stop so anomalous metadata never unloads the proxy", () => {
    const gateAt = updateSource.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const abortAt = updateSource.indexOf("aborting the update before stopping the proxy");
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    expect(gateAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(stopAt);
    expect(abortAt).toBeLessThan(stopAt);
  });

  test("npm cache ownership pre-flight runs before either updater stops the proxy", () => {
    const cliGateAt = updateSource.indexOf("const cacheOwnership = checkNpmCacheOwnership()");
    const cliStopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    const launcherGateAt = launcherSource.indexOf("const cacheOwnership = checkNpmCacheOwnership(");
    const launcherStopAt = launcherSource.indexOf('[launcher, "stop"]');
    expect(cliGateAt).toBeGreaterThan(-1);
    expect(launcherGateAt).toBeGreaterThan(-1);
    expect(cliGateAt).toBeLessThan(cliStopAt);
    expect(launcherGateAt).toBeLessThan(launcherStopAt);
    expect(updateSource).toContain("formatNpmCacheOwnershipFailure(cacheOwnership)");
    expect(launcherSource).toContain("formatNpmCacheOwnershipFailure(cacheOwnership)");
    expect(updateSource).toContain("npm cache ownership pre-flight skipped");
    expect(launcherSource).toContain("npm cache ownership pre-flight skipped");
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    const installAt = launcherSource.indexOf('runProcessTreeCommand(npm, ["install", "-g"');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
    expect(launcherSource).toContain('existsSync(join(configDir(), "runtime-port.json"))');
  });

  test("both paths abort when the stop fails, and reinstall a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    // The update path now uses serviceReinstallArgs() to preserve the chosen backend.
    expect(updateSource).toContain("serviceReinstallArgs()");
    expect(launcherSource).toContain("aborting the update");
    // The launcher reads service-state.json to preserve the backend choice on reinstall.
    expect(launcherSource).toContain("serviceReinstallArgs");
    // The launcher reads the state path for both service-installed detection and backend choice.
    expect(launcherSource).toContain('"service-state.json"');
    expect(updateSource).toContain("OCX_BAKE_PORT");
    expect(launcherSource).toContain("OCX_BAKE_PORT");
    // Live runtime port 10100 must not be discarded as a missing-port sentinel.
    expect(launcherSource).toContain("sawRuntimePort");
    expect(updateJobSource).toContain("const liveBeforeUpdate = await findLiveProxyForUpdate()");
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
    const installAt = launcherSource.indexOf('runProcessTreeCommand(npm, ["install", "-g"');
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState)");
    expect(launcherSource).toContain("stopRes.status !== 0 || stillHasRuntimeState");
  });

  test("GUI failure recovery is gated by identity-checked pre-update liveness", () => {
    expect(updateJobSource).toContain("const liveBeforeUpdate = await findLiveProxyForUpdate()");
    expect(updateJobSource).toContain("const proxyWasActive = liveBeforeUpdate !== null");
    expect(updateJobSource).toContain("(io.readAlivePidFn ?? readAlivePid)()");
    expect(updateJobSource).toContain("(io.verifyPidIdentityFn ?? verifyPidIdentityFresh)(candidatePid)");
    expect(updateJobSource).toContain("(io.readRuntimePortFn ?? readRuntimePort)(candidatePid)");
    expect(updateJobSource).not.toContain("const proxyWasActive = isServiceInstalled() || runtimeTrusted");
  });

  test("GUI failure recovery identity-checks the old PID and threads a validated launcher", () => {
    expect(updateJobSource).toContain("(io.verifyPidIdentityFn ?? verifyPidIdentityFresh)(captured.oldPid)");
    expect(updateJobSource).toContain("io.recoveryLaunchersFn ?? findNpmRecoveryLaunchers");
    expect(updateJobSource).toContain("{ ...captured, recoveryLauncher }");
    expect(updateJobSource).toContain("captured?.recoveryLauncher ?? packageLauncherPath()");
    expect(updateJobSource).toContain("const readPidForRestart = (context: string)");
    expect(updateJobSource).toContain("const verifyCurrentPid = io.verifyPidIdentityFn ?? verifyPidIdentityFresh");
    expect(updateJobSource).toContain("verifyCurrentPid(rawPid) === rawPid");
    expect(updateJobSource).toContain('if (readPidForRestart("after service port reclaim").refused) return');
    expect(updateJobSource).toContain('const directPid = readPidForRestart("before direct restart")');
    expect(updateJobSource).toContain('if (readPidForRestart("after direct port reclaim").refused) return');
    expect(updateJobSource).toContain("hasTrustedRecoveryPermissions(rootStat)");
    expect(updateJobSource).toContain("uid === currentUid || uid === 0");
    expect(updateJobSource).toContain("hasTrustedRecoveryTree(packageRoot)");
    expect(updateJobSource).toContain("(stat.mode & 0o022) === 0");
  });

  test("GUI recovery waits beyond the nested npm install deadline", () => {
    const outerRaw = /const UPDATE_TIMEOUT_MS = ([\d_]+);/.exec(updateJobSource)?.[1];
    const innerRaw = /const NPM_INSTALL_TIMEOUT_MS = ([\d_]+);/.exec(launcherSource)?.[1];
    expect(outerRaw).toBeDefined();
    expect(innerRaw).toBeDefined();
    const outerMs = Number(outerRaw?.replaceAll("_", ""));
    const innerMs = Number(innerRaw?.replaceAll("_", ""));
    expect(outerMs).toBeGreaterThanOrEqual(innerMs + 60_000);
    expect(launcherSource).toContain("timeoutMs: NPM_INSTALL_TIMEOUT_MS");
    expect(launcherSource).toContain("await runProcessTreeCommand(npm");
    expect(updateJobSource).toContain("await runLoggedProcessTreeCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS)");
    expect(updateJobSource).toContain("if (result.status !== 0 || !result.treeExited)");
    expect(updateJobSource).toContain("return result.treeExited");
    expect(updateJobSource).toContain("installerFailureAllowsRecovery(check.installer, result)");
    expect(updateJobSource).toContain("if (trayWasRunning && mayRecover)");
    expect(updateJobSource).toContain("The Windows tray also remains stopped");
    expect(updateJobSource).toContain("candidates.slice(0, MAX_NPM_RECOVERY_CANDIDATES)");
  });

  test("GUI recovery scan imports the worker argument contract from the worker module", () => {
    expect(updateJobSource).toContain('import { RECOVERY_TREE_SCAN_WORKER_ARG } from "./recovery-tree-scan.mjs"');
    expect(updateJobSource).not.toContain('const RECOVERY_TREE_SCAN_WORKER_ARG = "__scan-recovery-tree"');
  });

  test("GUI worker update children use pipe stdio so Windows npm.cmd does not open consoles", () => {
    expect(updateSource).toContain("function updateChildStdio()");
    expect(updateSource).toContain('process.env.OCX_SERVICE === "1"');
    expect(updateSource).toContain('return "pipe"');
    // All three update children (stop, installer, service reinstall) go through it.
    expect(updateSource).toContain("stdio: stopStdio");
    expect(updateSource).toContain("stdio: installStdio");
    expect(updateSource).toContain("stdio: svcStdio");
    expect(updateSource).toContain("windowsHide: true");
  });

  test("Bun/source installer cleanup is tree-aware before shim or service refresh", () => {
    const installAt = updateSource.indexOf("await runProcessTreeCommand(target.bin, cmdArgs");
    const cleanupGateAt = updateSource.indexOf("if (!r.treeExited)");
    const successAt = updateSource.indexOf("if (r.status === 0)");
    expect(installAt).toBeGreaterThan(-1);
    expect(cleanupGateAt).toBeGreaterThan(installAt);
    expect(cleanupGateAt).toBeLessThan(successAt);
    expect(updateSource).toContain("timeoutMs: 180000");
    expect(updateSource).toContain("INSTALLER_TREE_CLEANUP_FAILED_EXIT_CODE");
  });
});

describe("ocx update --help has no side effects (#168)", () => {
  test("the Bun CLI short-circuits help before importing the update runner", () => {
    const caseAt = cliSource.indexOf('case "update"');
    const helpAt = cliSource.indexOf('printSubcommandUsage("update")');
    const runAt = cliSource.indexOf("await runUpdate()");
    expect(caseAt).toBeGreaterThan(-1);
    expect(helpAt).toBeGreaterThan(caseAt);
    expect(helpAt).toBeLessThan(runAt);
  });

  test("the npm launcher intercepts update --help before the self-update path", () => {
    const helpAt = launcherSource.indexOf("updateHelpRequested");
    const updateAt = launcherSource.indexOf("await runNpmSelfUpdate();");
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
    expect(serverSource).toContain("port: listenPort");
  });
});

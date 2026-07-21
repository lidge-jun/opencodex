import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
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

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    const installAt = launcherSource.indexOf('spawnSync(npm, ["install", "-g"');
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
    const installAt = launcherSource.indexOf('spawnSync(npm, ["install", "-g"');
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState)");
    expect(launcherSource).toContain("stopRes.status !== 0 || stillHasRuntimeState");
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
    expect(serverSource).toContain("port: listenPort");
  });
});

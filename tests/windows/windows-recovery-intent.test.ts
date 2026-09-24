import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeRecoveryIntentIfGuardianEnabled, backupRecoveryIntent, restoreRecoveryIntent } from "../../src/lib/recovery-intent";
import { parseIntent } from "../../scripts/ocx-recovery-guardian/main.cjs";
import { repoPath } from "../helpers/repo-root";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop()!, { recursive: true, force: true }); });

function homeFixture(): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-recovery-intent-"));
  fixtures.push(home);
  return home;
}

function enableGuardian(home: string): void {
  writeFileSync(join(home, "recovery-guardian.json"), JSON.stringify({ version: 1, enabled: true }));
}

describe("persistent manual recovery intent", () => {
  test("leaves no intent when the guardian marker is missing or explicitly disabled", async () => {
    const missing = homeFixture();
    expect(await writeRecoveryIntentIfGuardianEnabled("stopped", { home: missing, at: 11 })).toBe(false);
    expect(existsSync(join(missing, "recovery-intent.json"))).toBe(false);

    const disabled = homeFixture();
    writeFileSync(join(disabled, "recovery-guardian.json"), JSON.stringify({ version: 1, enabled: false }));
    expect(await writeRecoveryIntentIfGuardianEnabled("running", { home: disabled, at: 12 })).toBe(false);
    expect(existsSync(join(disabled, "recovery-intent.json"))).toBe(false);
  });

  test("writes the bounded v1 stopped and maintenance intents only for an enabled guardian", async () => {
    const home = homeFixture();
    enableGuardian(home);
    expect(await writeRecoveryIntentIfGuardianEnabled("stopped", { home, at: 21 })).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "recovery-intent.json"), "utf8"))).toEqual({ version: 1, mode: "stopped", at: 21 });

    expect(await writeRecoveryIntentIfGuardianEnabled("maintenance", { home, at: 22, until: 202 })).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "recovery-intent.json"), "utf8"))).toEqual({ version: 1, mode: "maintenance", at: 22, until: 202 });
  });

  test("fails closed without changing the intent for a malformed enabled-marker boundary", async () => {
    const home = homeFixture();
    writeFileSync(join(home, "recovery-guardian.json"), "{ nope");
    await expect(writeRecoveryIntentIfGuardianEnabled("stopped", { home, at: 31 })).rejects.toThrow("Recovery guardian marker is malformed");
    expect(existsSync(join(home, "recovery-intent.json"))).toBe(false);
  });

  test("wires manual stop, receipt-backed API stop, and visible-launcher start/restart through the same fail-closed contract", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const api = readFileSync(repoPath("src/server/management-api.ts"), "utf8");
    const launcher = readFileSync(repoPath("scripts/windows-visible-proxy.ps1"), "utf8");
    const tray = readFileSync(repoPath("src/tray/windows-tray.ps1"), "utf8");

    expect(cli).toContain('OPENCODEX_GUARDIAN_RECOVERY');
    expect(cli).toContain('writeRecoveryIntentIfGuardianEnabled("stopped")');
    expect(api).toContain("if (!holdsReceipt)");
    expect(api).toContain('writeRecoveryIntentIfGuardianEnabled("stopped")');
    expect(launcher).toContain('Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "running"');
    expect(launcher).toContain('Set-RecoveryIntent -OpenCodexDirectory $OpenCodexHome -Mode "maintenance"');
    expect(launcher).toContain('$startInfo.EnvironmentVariables["OPENCODEX_GUARDIAN_RECOVERY"] = "1"');
    expect(launcher).toContain('Ensure-RecoveryGuardian -OpenCodexDirectory $OpenCodexHome -Root $ProjectRoot -EffectiveCodexHome $CodexHome -PrimaryPort $Port');
    expect(launcher).toContain("service -ceq 'ocx-recovery-gateway'");
    expect(launcher).toContain("Start-Process -FilePath $expectedNode");
    expect(launcher).toContain("ConvertTo-RecoveryGuardianArgument");
    expect(launcher).toContain("-ArgumentList $guardianArgs");
    expect(launcher).toContain('$marker.primaryPort -eq $PrimaryPort');
    expect(launcher).toContain('$null -ne $marker.fallback.models');
    expect(tray).toContain('Set-RecoveryIntent -OpenCodexHome $OpenCodexHome -Mode "stopped"');
    expect(tray).toContain('Set-RecoveryIntent -OpenCodexHome $OpenCodexHome -Mode "running"');
    expect(tray).toContain('Test-RecoveryGuardianIntentEnabled');
    expect(tray).toContain('if (-not (Test-RecoveryGuardianIntentEnabled $OpenCodexHome)) { return }');
  });

  test("ships the tray recovery helper as an owned installed asset through status, rollback, and uninstall", () => {
    const trayTs = readFileSync(repoPath("src/tray/windows.ts"), "utf8");
    expect(existsSync(repoPath("scripts/ocx-recovery-guardian/intent.ps1"))).toBe(true);
    expect(trayTs).toContain('const INSTALLED_TRAY_RECOVERY_INTENT_FILE = "opencodex-recovery-intent.ps1"');
    expect(trayTs).toContain("sourceTrayRecoveryIntentPath()");
    expect(trayTs).toContain("installedTrayRecoveryIntentPath()");
    expect(trayTs).toContain("replaceWindowsTrayOwnedFile(installedRecoveryIntent");
    expect(trayTs).toContain("previousRecoveryIntentBytes");
    expect(trayTs).toContain("installedTrayRecoveryIntentPath()]");
  });

  test("the PowerShell helper replaces existing stopped, maintenance, and running intents atomically", () => {
    if (process.platform !== "win32") return;
    const home = homeFixture();
    const helper = repoPath("scripts/ocx-recovery-guardian/intent.ps1");
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const intent = join(home, "recovery-intent.json");
    const until = Date.now() + 60_000;
    const code = `$null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode stopped; if (Test-Path -LiteralPath ${quote(intent)}) { exit 11 }; Set-Content -LiteralPath ${quote(join(home, "recovery-guardian.json"))} -Value '{"version":1,"enabled":true}' -NoNewline; Set-Content -LiteralPath ${quote(intent)} -Value '{"version":1,"mode":"stopped","at":1}' -NoNewline; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode maintenance -Until ${until}; $maintenance = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode running; $running = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode stopped; $stopped = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $temps = @(Get-ChildItem -LiteralPath ${quote(home)} -Filter '.recovery-intent.*.tmp'); @($maintenance, $running, $stopped, $temps.Count) | ConvertTo-Json -Compress`;
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-Command", code], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    const [maintenance, running, stopped, tempCount] = JSON.parse(Buffer.from(run.stdout).toString()) as [{ version: number; mode: string; until?: number }, { mode: string }, { mode: string }, number];
    expect(maintenance).toMatchObject({ version: 1, mode: "maintenance", until });
    expect(running).toMatchObject({ version: 1, mode: "running" });
    expect(stopped).toMatchObject({ version: 1, mode: "stopped" });
    expect(tempCount).toBe(0);
  }, 20_000);

  test("the PowerShell helper fails closed on a reparse point and on an out-of-contract maintenance window", () => {
    if (process.platform !== "win32") return;
    const root = homeFixture();
    const helper = repoPath("scripts/ocx-recovery-guardian/intent.ps1");
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const invoke = (home: string, command: string) => Bun.spawnSync(
      [ps, "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; & ${quote(helper)} -OpenCodexHome ${quote(home)} ${command}`],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const intentOf = (home: string) => join(home, "recovery-intent.json");

    // A reparse-point marker must refuse the write. Windows file symlinks need
    // developer-mode rights, so fall back to a directory junction: it carries
    // the same ReparsePoint attribute bit the guard tests.
    const home = join(root, "home");
    mkdirSync(home);
    const outside = join(root, "outside.json");
    writeFileSync(outside, '{"version":1,"enabled":true}');
    let reparseHome = home;
    try {
      symlinkSync(outside, join(home, "recovery-guardian.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      symlinkSync(home, join(root, "linked-home"), "junction");
      writeFileSync(join(home, "recovery-guardian.json"), '{"version":1,"enabled":true}');
      reparseHome = join(root, "linked-home");
    }
    const refused = invoke(reparseHome, "-Mode stopped");
    expect(refused.exitCode, Buffer.from(refused.stdout).toString()).not.toBe(0);
    expect(existsSync(intentOf(home))).toBe(false);

    const enabled = join(root, "enabled");
    mkdirSync(enabled);
    writeFileSync(join(enabled, "recovery-guardian.json"), '{"version":1,"enabled":true}');
    // parseIntent in main.cjs decodes any intent outside at < until <= at+180000
    // as 'stopped', which fences every request, so the writer must reject it.
    for (const until of [77, Date.now() - 1, Date.now() + 400_000]) {
      const rejected = invoke(enabled, `-Mode maintenance -Until ${until}`);
      expect(rejected.exitCode, `until=${until}`).not.toBe(0);
      expect(existsSync(intentOf(enabled)), `until=${until}`).toBe(false);
    }
    expect(invoke(enabled, `-Mode maintenance -Until ${Date.now() + 60_000}`).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(intentOf(enabled), "utf8"))).toMatchObject({ mode: "maintenance" });
    expect(invoke(enabled, "-Mode running").exitCode).toBe(0);
    expect(invoke(enabled, `-Mode running -Until ${Date.now() + 60_000}`).exitCode).not.toBe(0);
  }, 30_000);

  test("a refused stop restores the durable intent exactly as it found it", async () => {
    const home = homeFixture();
    enableGuardian(home);
    const intentPath = join(home, "recovery-intent.json");
    const found = { version: 1, mode: "running", at: 5 };
    writeFileSync(intentPath, JSON.stringify(found) + "\n");
    const backup = backupRecoveryIntent(home);
    expect(await writeRecoveryIntentIfGuardianEnabled("stopped", { home, at: 6 })).toBe(true);
    expect(JSON.parse(readFileSync(intentPath, "utf8")).mode).toBe("stopped");
    expect(await restoreRecoveryIntent(backup)).toBe(true);
    expect(JSON.parse(readFileSync(intentPath, "utf8"))).toEqual(found);
    // A home that had no intent file still has none afterwards: the rollback must not
    // invent an instruction this run never found, and must not delete one it did.
    const fresh = homeFixture();
    enableGuardian(fresh);
    const absent = backupRecoveryIntent(fresh);
    await writeRecoveryIntentIfGuardianEnabled("stopped", { home: fresh, at: 7 });
    expect(existsSync(join(fresh, "recovery-intent.json"))).toBe(true);
    expect(await restoreRecoveryIntent(absent)).toBe(true);
    expect(existsSync(join(fresh, "recovery-intent.json"))).toBe(false);
    // No guardian means nothing was written, so there is nothing to put back.
    const plain = homeFixture();
    expect(backupRecoveryIntent(plain)).toBeNull();
    expect(await restoreRecoveryIntent(null)).toBe(true);
  // Every write here hardens the file's ACL through a real icacls spawn, so the wait is
  // intrinsic to the assertion; this file already budgets its spawn-bound cases this way.
  }, 20_000);

  test("every refusal site that answers 'nothing was changed' rolls the intent back", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const api = readFileSync(repoPath("src/server/management-api.ts"), "utf8");
    expect(cli).toMatch(/stopIntent = backupRecoveryIntent\(\);\s*\n\s*await writeRecoveryIntentIfGuardianEnabled\("stopped"\)/);
    // `runtimeDown` is the stop's own evidence that a proxy of this home is still serving.
    expect(cli).toMatch(/if \(stopIntent && !outcome\.summary\.runtimeDown && !await restoreRecoveryIntent\(stopIntent\)\)/);
    const stop = api.slice(api.indexOf('if (url.pathname === "/api/stop"'), api.indexOf('if (url.pathname.startsWith("/api/native-main-profiles")'));
    expect(stop).toContain("stopIntent = backupRecoveryIntent();");
    expect(stop).toContain("return await refuseStop(");
    // A bare 409 from this route means the durable `stopped` outlived a proxy that never
    // stopped, which fences the whole home through the guardian gateway.
    expect(stop).not.toContain(", 409, req, config)");
  });

  test("writer, reader and action script agree on every maintenance-window cell", async () => {
    // One contract, three parties: at < until <= at + 180000. Anything else decodes as
    // `stopped` in the guardian reader, which fences all gateway traffic.
    const at = Date.now() - 1000;
    const cells: Array<[string, number | undefined, boolean]> = [
      ["until missing", undefined, false],
      ["until <= at", at, false],
      ["until > at+180000", at + 180_001, false],
      ["until == at+180000", at + 180_000, true],
    ];
    const bodies: string[] = [];
    for (const [label, until, accepted] of cells) {
      const home = homeFixture();
      enableGuardian(home);
      const intent: { version: number; mode: string; at: number; until?: number } = { version: 1, mode: "maintenance", at };
      if (until !== undefined) intent.until = until;
      bodies.push(JSON.stringify(intent));
      const wrote = await writeRecoveryIntentIfGuardianEnabled("maintenance", { home, at, until }).then(() => true, () => false);
      expect(wrote, `writer rejected ${label}`).toBe(accepted);
      expect(parseIntent(intent, at + 1000).valid, `reader on ${label}`).toBe(accepted);
    }
    if (process.platform !== "win32") return;
    const source = readFileSync(repoPath("scripts/ocx-recovery-guardian/windows-action.ps1"), "utf8");
    const start = source.indexOf("function Read-RecoveryIntent");
    const end = source.indexOf("function Test-CurrentRunningIntent", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const directory = homeFixture();
    const script = join(directory, "cells.ps1");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    writeFileSync(script, [
      "$ErrorActionPreference='Stop'",
      "Set-StrictMode -Version Latest",
      "$IntentMaxBytes=16384",
      "function Read-BoundedJson { param([string]$Path,[int]$MaximumBytes) Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }",
      source.slice(start, end),
      `$cellHome = ${quote(directory)}`,
      `$bodies = @(${bodies.map(body => quote(body)).join(", ")})`,
      "foreach ($b in $bodies) {",
      "  Set-Content -LiteralPath (Join-Path $cellHome 'recovery-intent.json') -NoNewline -Value $b",
      "  [Console]::Out.WriteLine((Read-RecoveryIntent -OpenCodexDirectory $cellHome).valid)",
      "}",
    ].join("\r\n"));
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", script], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    expect(Buffer.from(run.stdout).toString().trim().toLowerCase().split(/\r?\n/)).toEqual(cells.map(([, , accepted]) => String(accepted)));
  }, 40_000);

  test("visible launcher and tray invoke the enabled recovery helper with named parameters", () => {
    if (process.platform !== "win32") return;
    const root = homeFixture();
    const project = join(root, "project");
    const launcherHome = join(root, "launcher-home");
    const trayHome = join(root, "tray-home");
    const trayDir = join(root, "tray");
    const helper = repoPath("scripts/ocx-recovery-guardian/intent.ps1");
    mkdirSync(join(project, "scripts", "ocx-recovery-guardian"), { recursive: true });
    mkdirSync(launcherHome, { recursive: true });
    mkdirSync(trayHome, { recursive: true });
    mkdirSync(trayDir, { recursive: true });
    copyFileSync(helper, join(project, "scripts", "ocx-recovery-guardian", "intent.ps1"));
    copyFileSync(helper, join(trayDir, "opencodex-recovery-intent.ps1"));
    writeFileSync(join(launcherHome, "recovery-guardian.json"), '{"version":1,"enabled":true}');
    writeFileSync(join(trayHome, "recovery-guardian.json"), '{"version":1,"enabled":true}');

    const launcher = readFileSync(repoPath("scripts/windows-visible-proxy.ps1"), "utf8");
    const launcherStart = launcher.indexOf("function Set-RecoveryIntent {");
    const launcherEnd = launcher.indexOf("function Get-VisibleProxyMutexName", launcherStart);
    const tray = readFileSync(repoPath("src/tray/windows-tray.ps1"), "utf8");
    const trayStart = tray.indexOf("function Test-RecoveryGuardianIntentEnabled");
    const trayEnd = tray.indexOf("function Update-TrayState", trayStart);
    expect(launcherStart).toBeGreaterThan(0);
    expect(launcherEnd).toBeGreaterThan(launcherStart);
    expect(trayStart).toBeGreaterThan(0);
    expect(trayEnd).toBeGreaterThan(trayStart);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const launcherScript = join(root, "invoke-launcher-intent.ps1");
    writeFileSync(launcherScript, `$ErrorActionPreference='Stop'\n$ProjectRoot=${quote(project)}\n${launcher.slice(launcherStart, launcherEnd)}\nSet-RecoveryIntent -OpenCodexDirectory ${quote(launcherHome)} -Mode stopped\n`);
    const trayScript = join(trayDir, "invoke-tray-intent.ps1");
    const trayUntil = Date.now() + 60_000;
    writeFileSync(trayScript, `$ErrorActionPreference='Stop'\n${tray.slice(trayStart, trayEnd)}\nSet-RecoveryIntent -OpenCodexHome ${quote(trayHome)} -Mode maintenance -Until ${trayUntil}\n`);
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    for (const script of [launcherScript, trayScript]) {
      const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(launcherHome, "recovery-intent.json"), "utf8"))).toMatchObject({ mode: "stopped" });
    expect(JSON.parse(readFileSync(join(trayHome, "recovery-intent.json"), "utf8"))).toMatchObject({ mode: "maintenance", until: trayUntil });
  }, 30_000);

  test("the visible launcher CheckOnly path parses but never initializes a guardian or writes intent", () => {
    if (process.platform !== "win32") return;
    const root = homeFixture();
    const project = join(root, "project");
    const home = join(root, "home");
    const codex = join(root, "codex");
    const guardianDir = join(project, "scripts", "ocx-recovery-guardian");
    const nodePath = join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe");
    if (!existsSync(nodePath)) return;
    mkdirSync(guardianDir, { recursive: true });
    mkdirSync(join(project, "node_modules", "bun", "bin"), { recursive: true });
    mkdirSync(join(project, "src", "cli"), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(project, "node_modules", "bun", "bin", "bun.exe"), "fixture");
    writeFileSync(join(project, "src", "cli", "index.ts"), "// fixture\n");
    writeFileSync(join(guardianDir, "main.cjs"), "require('node:fs').writeFileSync(process.argv[3] + '.argv', JSON.stringify(process.argv.slice(1)));\n");
    copyFileSync(repoPath("scripts/ocx-recovery-guardian/intent.ps1"), join(guardianDir, "intent.ps1"));
    // Without an approved marker there is no guardian to initialize and no intent to fence,
    // so both absence assertions below would pass for the wrong reason. The ports are ones
    // nothing listens on: a developer's real proxy on the default 10100 would let a
    // mutation that skips the early exit still leave no intent, by exiting on health instead.
    const marker = join(home, "recovery-guardian.json");
    writeFileSync(marker, JSON.stringify({
      version: 1, enabled: true, projectRoot: project, openCodexHome: home, codexHome: codex,
      nodePath, listenPort: 31997, primaryPort: 31998, fallback: { models: { fixture: "fixture" } }, repair: {},
    }));
    const launcher = repoPath("scripts/windows-visible-proxy.ps1");
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", launcher,
      "-ProjectRoot", project, "-OpenCodexHome", home, "-CodexHome", codex, "-Port", "31998", "-CheckOnly", "-NoPause"],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    expect(Buffer.from(run.stdout).toString()).toContain("check passed");
    expect(existsSync(marker + ".argv")).toBe(false);
    expect(existsSync(join(home, "recovery-intent.json"))).toBe(false);
  }, 20_000);

  test("the visible guardian launcher passes an exact config path containing spaces to Node", () => {
    if (process.platform !== "win32") return;
    const root = homeFixture();
    const project = join(root, "project with spaces");
    const home = join(root, "home with spaces");
    const codex = join(root, "codex with spaces");
    const guardianDir = join(project, "scripts", "ocx-recovery-guardian");
    mkdirSync(guardianDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const marker = join(home, "recovery-guardian.json");
    const main = join(guardianDir, "main.cjs");
    const nodePath = join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe");
    if (!existsSync(nodePath)) return;
    writeFileSync(main, "require('node:fs').writeFileSync(process.argv[3] + '.argv', JSON.stringify(process.argv.slice(1)));\n");
    writeFileSync(marker, JSON.stringify({
      version: 1, enabled: true, projectRoot: project, openCodexHome: home, codexHome: codex,
      nodePath, listenPort: 31997, primaryPort: 10100, fallback: { models: { fixture: "fixture" } }, repair: {},
    }));
    const source = readFileSync(repoPath("scripts/windows-visible-proxy.ps1"), "utf8");
    // The main launcher has the only column-zero `try`. Keep extraction below
    // its function region, while permitting diagnostics before path validation.
    const boundary = source.indexOf("\ntry {\n");
    expect(boundary).toBeGreaterThan(0);
    expect(source.slice(boundary, boundary + 400)).toContain("$ProjectRoot = Resolve-AbsolutePath");
    const functions = source.slice(source.indexOf("$LogFileName ="), boundary);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const psFile = join(root, "invoke-guardian.ps1");
    writeFileSync(psFile, `$ErrorActionPreference='Stop'\n$ProjectRoot=${quote(project)}\n$OpenCodexHome=${quote(home)}\n$CodexHome=${quote(codex)}\n$Port=10100\n${functions}\nforeach ($unsafe in @('quote"unsafe', ('control' + [char]10))) { try { ConvertTo-RecoveryGuardianArgument -Value $unsafe | Out-Null; throw 'unsafe argument was accepted' } catch { if ($_.Exception.Message -eq 'unsafe argument was accepted') { throw } } }\nEnsure-RecoveryGuardian -OpenCodexDirectory $OpenCodexHome -Root $ProjectRoot -EffectiveCodexHome $CodexHome -PrimaryPort $Port\nStart-Sleep -Milliseconds 600\n`);
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", psFile], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    expect(JSON.parse(readFileSync(marker + ".argv", "utf8"))).toEqual([main, "--config", marker]);
  }, 20_000);
});

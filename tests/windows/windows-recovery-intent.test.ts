import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeRecoveryIntentIfGuardianEnabled } from "../../src/lib/recovery-intent";
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
    const code = `$null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode stopped; if (Test-Path -LiteralPath ${quote(intent)}) { exit 11 }; Set-Content -LiteralPath ${quote(join(home, "recovery-guardian.json"))} -Value '{"version":1,"enabled":true}' -NoNewline; Set-Content -LiteralPath ${quote(intent)} -Value '{"version":1,"mode":"stopped","at":1}' -NoNewline; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode maintenance -Until 77; $maintenance = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode running; $running = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $null = & ${quote(helper)} -OpenCodexHome ${quote(home)} -Mode stopped; $stopped = Get-Content -LiteralPath ${quote(intent)} -Raw | ConvertFrom-Json; $temps = @(Get-ChildItem -LiteralPath ${quote(home)} -Filter '.recovery-intent.*.tmp'); @($maintenance, $running, $stopped, $temps.Count) | ConvertTo-Json -Compress`;
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-Command", code], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    const [maintenance, running, stopped, tempCount] = JSON.parse(Buffer.from(run.stdout).toString()) as [{ version: number; mode: string; until?: number }, { mode: string }, { mode: string }, number];
    expect(maintenance).toMatchObject({ version: 1, mode: "maintenance", until: 77 });
    expect(running).toMatchObject({ version: 1, mode: "running" });
    expect(stopped).toMatchObject({ version: 1, mode: "stopped" });
    expect(tempCount).toBe(0);
  }, 20_000);

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
    writeFileSync(trayScript, `$ErrorActionPreference='Stop'\n${tray.slice(trayStart, trayEnd)}\nSet-RecoveryIntent -OpenCodexHome ${quote(trayHome)} -Mode maintenance -Until 123\n`);
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    for (const script of [launcherScript, trayScript]) {
      const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(launcherHome, "recovery-intent.json"), "utf8"))).toMatchObject({ mode: "stopped" });
    expect(JSON.parse(readFileSync(join(trayHome, "recovery-intent.json"), "utf8"))).toMatchObject({ mode: "maintenance", until: 123 });
  }, 30_000);

  test("the visible launcher CheckOnly path parses but never initializes a guardian or writes intent", () => {
    if (process.platform !== "win32") return;
    const root = homeFixture();
    const project = join(root, "project");
    const home = join(root, "home");
    const codex = join(root, "codex");
    mkdirSync(join(project, "node_modules", "bun", "bin"), { recursive: true });
    mkdirSync(join(project, "src", "cli"), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(project, "node_modules", "bun", "bin", "bun.exe"), "fixture");
    writeFileSync(join(project, "src", "cli", "index.ts"), "// fixture\n");
    const launcher = repoPath("scripts/windows-visible-proxy.ps1");
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", launcher,
      "-ProjectRoot", project, "-OpenCodexHome", home, "-CodexHome", codex, "-CheckOnly", "-NoPause"],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    expect(Buffer.from(run.stdout).toString()).toContain("check passed");
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

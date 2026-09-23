import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoPath } from "../helpers/repo-root";

const actionPath = repoPath("scripts/ocx-recovery-guardian/windows-action.ps1");

function actionSource() {
  return Bun.file(actionPath).text();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-recovery-windows-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const codex = join(root, "codex");
  mkdirSync(join(project, "node_modules", "bun", "bin"), { recursive: true });
  mkdirSync(join(project, "src", "cli"), { recursive: true });
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(project, "node_modules", "bun", "bin", "bun.exe"), "fixture only");
  writeFileSync(join(project, "src", "cli", "index.ts"), "// fixture only\n");
  writeFileSync(join(project, "scripts", "windows-visible-proxy.ps1"), "# fixture only\n");
  return { root, project, home, codex };
}

describe("Windows recovery guardian action ownership", () => {
  test("has a narrow structured interface and never serializes command lines", async () => {
    const source = await actionSource();
    expect(source).toContain("[ValidateSet('Inspect', 'Recover')]");
    expect(source).toContain("ExpectedLauncherPid");
    expect(source).toContain("ExpectedLauncherStart");
    expect(source).toContain("ConvertTo-Json -Compress");
    expect(source).not.toMatch(/commandLine\s*=/i);
    expect(source).not.toMatch(/Write-(Host|Verbose|Warning|Error).*CommandLine/i);
    expect(source).toContain("if ($Mode -eq 'Recover')");
    expect(source).toContain("invalid-expected-identity");
  });

  test("requires the exact Bun CLI and visible-launcher parent rather than Bun alone", async () => {
    const source = await actionSource();
    expect(source).toContain("node_modules\\bun\\bin\\bun.exe");
    expect(source).toContain("src\\cli\\index.ts");
    expect(source).toContain("scripts\\windows-visible-proxy.ps1");
    expect(source).toContain("Get-CimInstance Win32_Process");
    expect(source).toContain("Get-CimInstance Win32_Process -Filter");
    expect(source).toContain("-OperationTimeoutSec 3");
    expect(source).toContain("Test-ExpectedIdentity");
    expect(source).toContain("Test-VisibleLauncherParent");
    expect(source).toContain("$Child.ParentProcessId -ne $ExpectedLauncherPid");
    expect(source).toContain("$CreationDate -is [DateTime]");
    expect(source).toContain("$CreationDate -is [DateTimeOffset]");
    expect(source).toContain("Get-StableCodexHome");
    expect(source).toContain("OcxGuardianCanonicalDirectory");
    expect(source).toContain("Test-OptionalPathArgument");
    expect(source).toContain("$launchArguments -join ' '");
  });

  test("has no direct kill path and makes a foreign listener terminal before visible launch", async () => {
    const source = await actionSource();
    expect(source).not.toMatch(/\b(taskkill|Stop-Process|Terminate\s*\()/i);
    expect(source).toContain("foreign-listener");
    expect(source).toContain("port-closed");
    const collision = source.indexOf("foreign-listener");
    const start = source.lastIndexOf("Start-VisibleLauncher -ScriptPath");
    expect(collision).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(collision);
  });

  test("refuses malformed manual intent in an isolated fake project without invoking a child", () => {
    if (process.platform !== "win32") return;
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.home, "recovery-intent.json"), "{ not-json");
      const run = Bun.spawnSync([
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoProfile", "-NonInteractive", "-File", actionPath,
        "-Mode", "Recover", "-ProjectRoot", fixture.project,
        "-OpenCodexHome", fixture.home, "-CodexHome", fixture.codex,
        "-Port", "18991", "-ExpectedPid", "424242", "-ExpectedStart", "1",
        "-ExpectedLauncherPid", "424243", "-ExpectedLauncherStart", "1",
      ], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
      const result = JSON.parse(Buffer.from(run.stdout).toString()) as { action: string; reason: string };
      expect(result).toMatchObject({ action: "refused", reason: "invalid-intent" });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("uses the shared version/at intent envelope rather than a divergent schema", async () => {
    const source = await actionSource();
    expect(source).toContain("$intent.version");
    expect(source).toContain("$intent.at");
    expect(source).not.toContain("$intent.schema");
    expect(source).toContain("$intent.until -le $intent.at");
    expect(source).toContain("$intent.PSObject.Properties['until']");
  });

  test("accepts a running intent without until under StrictMode but rejects a maintenance intent without one", () => {
    if (process.platform !== "win32") return;
    const source = readFileSync(actionPath, "utf8");
    const start = source.indexOf("function Read-RecoveryIntent");
    const end = source.indexOf("function Test-CurrentRunningIntent", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const directory = mkdtempSync(join(tmpdir(), "ocx-recovery-intent-schema-"));
    const psFile = join(directory, "intent.ps1");
    const home = join(directory, "home");
    mkdirSync(home);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    writeFileSync(psFile, `$ErrorActionPreference='Stop'\nSet-StrictMode -Version Latest\n$IntentMaxBytes=16384\nfunction Read-BoundedJson { param([string]$Path,[int]$MaximumBytes) Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }\n${source.slice(start, end)}\n$intentHomeFixture=${quote(home)}\nSet-Content -LiteralPath (Join-Path $intentHomeFixture 'recovery-intent.json') -NoNewline -Value '{"version":1,"mode":"running","at":100}'\n$running = Read-RecoveryIntent -OpenCodexDirectory $intentHomeFixture\nSet-Content -LiteralPath (Join-Path $intentHomeFixture 'recovery-intent.json') -NoNewline -Value '{"version":1,"mode":"maintenance","at":100}'\n$maintenance = Read-RecoveryIntent -OpenCodexDirectory $intentHomeFixture\n@($running.valid,$running.reason,$maintenance.valid,$maintenance.reason) | ConvertTo-Json -Compress\n`);
    try {
      const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", psFile], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
      expect(JSON.parse(Buffer.from(run.stdout).toString())).toEqual([true, "allowed", false, "maintenance-expired"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("revalidates the same running intent generation at both irreversible action edges", async () => {
    const source = await actionSource();
    expect(source).toContain("function Test-RecoveryBoundary");
    expect(source).toContain("function Test-CurrentRunningIntent");
    expect(source).toContain("intent-changed");
    expect(source).toContain("intent-not-running");
    const beforeStop = source.indexOf("$beforeStopBoundary = Test-RecoveryBoundary");
    const stop = source.indexOf("$stopStatus = Invoke-GracefulProjectStop");
    const afterStop = source.indexOf("$afterStopBoundary = Test-RecoveryBoundary");
    const beforeStart = source.indexOf("$beforeStartBoundary = Test-RecoveryBoundary");
    const start = source.indexOf("Start-VisibleLauncher -ScriptPath");
    expect(beforeStop).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(beforeStop);
    expect(afterStop).toBeGreaterThan(stop);
    expect(beforeStart).toBeGreaterThan(afterStop);
    expect(start).toBeGreaterThan(beforeStart);
    expect(source.slice(beforeStop, stop)).toContain("-ExpectedIntentAt $intentAt");
    expect(source.slice(afterStop, beforeStart)).toContain("-ExpectedIntentAt $intentAt");
    expect(source.slice(beforeStart, start)).toContain("-ExpectedIntentAt $intentAt");
  });

  test("refuses deterministic stop or maintenance races after the recovery operation has begun", () => {
    if (process.platform !== "win32") return;
    const source = readFileSync(actionPath, "utf8");
    const start = source.indexOf("function New-RecoveryBoundaryResult");
    const end = source.indexOf("function Initialize-DiscardDrainType", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const boundary = source.slice(start, end);
    const psDirectory = mkdtempSync(join(tmpdir(), "ocx-recovery-boundary-"));
    const psFile = join(psDirectory, "boundary.ps1");
    const sample = "[pscustomobject]@{ owned=$false; alive=$false; listenerPid=0; pid=41; start='41'; launcherPid=42; launcherStart='42'; launcherAlive=$true; launcherOwned=$true }";
    writeFileSync(psFile, `$ErrorActionPreference='Stop'\n${boundary}\n$global:sample = ${sample}\nfunction Get-OwnershipSnapshot { $global:sample }\nfunction Same-Snapshot { param($Left,$Right) $true }\nfunction Test-PortClosedTwice { $true }\nfunction Test-CurrentRunningIntent { param([string]$OpenCodexDirectory,[long]$ExpectedAt) $global:intentCalls += 1; if ($global:intentCalls -eq 1) { return [pscustomobject]@{ valid=$true; reason='allowed'; mode='running'; at=$ExpectedAt } }; if ($global:race -eq 'stopped') { return [pscustomobject]@{ valid=$false; reason='manual-stop'; mode='stopped'; at=$ExpectedAt + 1 } }; return [pscustomobject]@{ valid=$false; reason='intent-not-running'; mode='maintenance'; at=$ExpectedAt + 1 } }\n$results = @()\nforeach ($race in @('stopped','maintenance')) { $global:race=$race; $global:intentCalls=0; $result = Test-RecoveryBoundary -Boundary before-start -ExpectedSnapshot $global:sample -BunPath 'b' -CliPath 'c' -ScriptPath 's' -Root 'r' -OpenCodexDirectory 'h' -CodexConfigured 'd' -CodexCanonical 'd' -ExpectedIntentAt 99; $results += $result.reason }\n$results | ConvertTo-Json -Compress\n`);
    try {
      const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const run = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-File", psFile], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
      expect(JSON.parse(Buffer.from(run.stdout).toString())).toEqual(["manual-stop", "intent-not-running"]);
    } finally {
      rmSync(psDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not claim the current Bun test process as owned when it is not the exact launcher tree", () => {
    if (process.platform !== "win32") return;
    const fixture = makeFixture();
    try {
      const run = Bun.spawnSync([
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoProfile", "-NonInteractive", "-File", actionPath,
        "-Mode", "Inspect", "-ProjectRoot", repoPath(),
        "-OpenCodexHome", fixture.home, "-CodexHome", fixture.codex,
        "-Port", "18992",
      ], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
      const result = JSON.parse(Buffer.from(run.stdout).toString()) as { owned: boolean };
      expect(result.owned).toBe(false);
      expect(Buffer.from(run.stdout).toString()).not.toContain(process.execPath);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("reports an isolated foreign listener but never treats it as a recovery target", async () => {
    if (process.platform !== "win32") return;
    const fixture = makeFixture();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    try {
      await fetch(server.url);
      const run = Bun.spawnSync([
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoProfile", "-NonInteractive", "-File", actionPath,
        "-Mode", "Inspect", "-ProjectRoot", repoPath(),
        "-OpenCodexHome", fixture.home, "-CodexHome", fixture.codex,
        "-Port", String(server.port),
      ], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
      const result = JSON.parse(Buffer.from(run.stdout).toString()) as { action: string; owned: boolean; listenerPid: number };
      expect(result).toMatchObject({ action: "inspect" });
      expect(result.owned).toBe(false);
      expect(result.listenerPid).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

});

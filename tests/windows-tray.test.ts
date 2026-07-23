import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWindowsTrayRunCommand,
  parseWindowsTrayRunValue,
  windowsTrayProcessArgs,
  windowsTrayRunValue,
  windowsTrayStatePathsOwned,
  windowsTrayRegistrationIsStale,
  windowsRegistryParentShowsRunKey,
  type WindowsTrayEntry,
} from "../src/tray/windows";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const entry: WindowsTrayEntry = {
  bun: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\bun.exe",
  cli: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\cli\\index.ts",
  script: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\tray\\windows-tray.ps1",
  codexHome: "C:\\사용자 공간\\.codex",
  opencodexHome: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\.opencodex",
};

describe("Windows tray packaging and command safety", () => {
  test("uses fixed argv for the hidden PowerShell host", () => {
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-STA");
    expect(args).toContain(entry.script);
    expect(args).toContain(entry.bun);
    expect(args).toContain(entry.cli);
    expect(args).not.toContain("-Command");
    expect(windowsTrayProcessArgs(entry, "Run", 4242)).toContain("4242");
  });

  test("quotes metacharacter and Unicode paths without shell interpolation", () => {
    const powershellCommand = buildWindowsTrayRunCommand(entry, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellCommand).toContain(`-File "${entry.script}"`);
    expect(powershellCommand).toContain(`-OpenCodexHome "${entry.opencodexHome}"`);
    expect(powershellCommand).not.toContain("cmd /c");
    expect(powershellCommand).not.toContain("-Command");
  });

  test("rejects quote and control-character path injection", () => {
    expect(() => windowsTrayProcessArgs({ ...entry, opencodexHome: 'C:\\bad" -Command whoami' })).toThrow();
    expect(() => windowsTrayProcessArgs({ ...entry, cli: "C:\\bad\r\nwhoami" })).toThrow();
  });

  test("never trusts state-selected executable or deletion paths", () => {
    const home = "C:\\Users\\Test\\.opencodex";
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: join(home, "opencodex-tray.vbs"),
    }, home)).toBe(true);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: "C:\\attacker\\payload.ps1",
    }, home)).toBe(false);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: "C:\\victim\\document.txt",
    }, home)).toBe(false);
  });

  test("treats a live unregistered tray as stale so uninstall cannot skip it", () => {
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: true,
      heartbeatFresh: true,
    })).toBe(true);
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: false,
      heartbeatFresh: false,
    })).toBe(false);
  });

  test("normalizes equivalent homes to one owned Run value", () => {
    expect(windowsTrayRunValue("C:\\Users\\Test\\.opencodex"))
      .toBe(windowsTrayRunValue("C:\\Users\\Test\\.opencodex\\."));
  });

  test("treats an unexpected registry type or unreadable value as foreign", () => {
    const value = "OpenCodexTray-test";
    const command = '"C:\\Windows\\powershell.exe" -File "C:\\tray.ps1"';
    expect(parseWindowsTrayRunValue(`    ${value}    REG_SZ    ${command}`, value)).toBe(command);
    expect(parseWindowsTrayRunValue(`    ${value}    REG_EXPAND_SZ    ${command}`, value)).not.toBe(command);
    expect(parseWindowsTrayRunValue("unexpected output", value)).not.toBeNull();
  });

  test("distinguishes a missing Run key from an unreadable existing key", () => {
    const parent = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    ].join("\r\n");
    expect(windowsRegistryParentShowsRunKey(parent)).toBe(true);
    expect(windowsRegistryParentShowsRunKey(parent.replace(/\\Run\r?\n?$/, ""))).toBe(false);
  });

  test("PowerShell controller uses mutex/event shutdown and bans command evaluation", () => {
    const typescript = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows.ts"), "utf8");
    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows-tray.ps1"), "utf8");
    expect(typescript).not.toContain("\u0000");
    expect(typescript).toContain("OCX_TRAY_ENTRY_B64");
    expect(typescript).toContain('detached: true');
    expect(source).toContain("System.Threading.Mutex");
    expect(source).toContain("System.Threading.EventWaitHandle");
    expect(source).toContain("GetFullPath");
    expect(source).toContain("GetPathRoot");
    expect(source).toContain("$heartbeat.hostPid = $HostPid");
    expect(source).toContain('Start-OcxCommand @("__tray-restart")');
    expect(source).not.toContain("$menu.add_Opening({ Update-TrayState })");
    expect(source).not.toContain("Invoke-Expression");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("Stop-Process");
  });

  test("serves tray status without blocking the proxy event loop", async () => {
    if (process.platform !== "win32") return;
    const url = new URL("http://localhost/api/windows-tray");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai" } as OcxConfig,
    );
    await Bun.sleep(50);
    expect(timerFired).toBe(true);
    clearTimeout(timer);
    const response = await responsePromise;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(typeof body.installed).toBe("boolean");
    expect(typeof body.running).toBe("boolean");
  });

  test("copies the tray script into the hardened home and gates all update lanes", () => {
    const root = join(import.meta.dir, "..");
    const tray = readFileSync(join(root, "src", "tray", "windows.ts"), "utf8");
    expect(tray).toContain('join(getConfigDir(), "opencodex-tray.ps1")');
    expect(tray).toContain("const hardened = hardenSecretPath(temporary, { required: true })");
    expect(tray).toContain("if (!hardened.ok)");
    expect(tray).toContain("if (!hardenedDir.ok)");
    expect(tray).toContain("refusing to replace its persistent script");
    expect(tray).toContain("restorePreviousInstall");
    expect(tray).toContain("previousStateBytes");
    expect(tray).toContain("previousScriptBytes");
    expect(tray).toContain('windowsTrayProcessArgs(currentEntry(), "Stop")');
    expect(tray).not.toContain("spawnTray(state)");
    expect(tray).toContain('runRegistry(["query", RUN_KEY, "/reg:64"])');

    const updateSources = [
      join(root, "src", "update", "index.ts"),
      join(root, "src", "update", "job.ts"),
      join(root, "bin", "ocx.mjs"),
    ].map(path => readFileSync(path, "utf8"));
    for (const source of updateSources) {
      expect(source).toContain("tray");
      expect(source).toContain("stop");
      expect(source).toContain("aborting before package replacement");
    }
  });
});

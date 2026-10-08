import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { compatibilityActivationScript, launchWindowsCodexCompatibility, validatedCompatibilityPacUrl } from "../../src/codex/desktop-compatibility/windows-package-launch";
import { WINDOWS_ACTIVATION_SOURCE } from "../../src/codex/desktop-compatibility/windows-activation-source";
import { setTrustedWindowsElevationExecutablesForTests } from "../../src/lib/windows-elevation";
import type { DesktopExec } from "../../src/codex/desktop-app/types";
import { windowsDesktopAppAdapter } from "../../src/codex/desktop-app/windows";
import { activateWindowsCodexCompatibility, captureWindowsCompatibilityContext } from "../../src/codex/desktop-compatibility/windows-package-command";
import { acquireDesktopCompatibilityRuntime, bindDesktopCompatibilityLaunch, readDesktopCompatibilityLaunch } from "../../src/codex/desktop-compatibility/runtime-ownership";

const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const install = { id: "OpenAI.Codex_fixture", root: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture", relaunch: "OpenAI.Codex_fixture!App" };
const pac = "http://127.0.0.1:10102/fixture-0123456789/proxy.pac";
const packageFullName = "OpenAI.Codex_1.2.3.0_x64__fixture";
const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); setTrustedWindowsElevationExecutablesForTests(null); });
function own(pacUrl = pac, current = () => true) {
  const release = acquireDesktopCompatibilityRuntime(); releases.push(release);
  releases.push(bindDesktopCompatibilityLaunch(pacUrl, current));
  return { release, generation: readDesktopCompatibilityLaunch()!.generation };
}
function executor(options: { running?: string; probeFailure?: boolean; output?: string } = {}) {
  const calls: string[] = [];
  setTrustedWindowsElevationExecutablesForTests({ powershell });
  const exec: DesktopExec = (_file, args) => {
    const script = args.at(-1)!; calls.push(script);
    if (script.includes("OpenCodexPackageActivation")) return options.output ?? JSON.stringify({ pid: 123, packageFullName, verified: true });
    if (script.includes("Get-AppxPackage")) return `${install.id}\n${install.root}\n${install.relaunch}`;
    if (options.probeFailure) throw new Error("probe refused");
    return options.running ?? "";
  };
  return { calls, exec };
}

describe("Codex Desktop compatibility package launch", () => {
  test("a same-shape PAC without a live runtime owner refuses before restart", () => {
    const root = { pid: 100, parentPid: 50, createdAt: "fixture", executable: "ChatGPT.exe", commandLine: `ChatGPT.exe --proxy-pac-url=${pac}` };
    expect(() => captureWindowsCompatibilityContext([root])).toThrow("desktop_compatibility_launch_owner_unverified");
  });
  test("activation tolerates a BOM and preceding warnings but normalizes invalid or timed-out output", () => {
    const io = executor({ output: `\uFEFFwarning: fixture\r\n${JSON.stringify({ pid: 123, packageFullName, verified: true })}\r\n` });
    expect(activateWindowsCodexCompatibility(io.exec, install, pac)).toEqual({ pid: 123, packageFullName });
    for (const output of ["", "null", "[]", "warning only"]) {
      expect(() => activateWindowsCodexCompatibility(executor({ output }).exec, install, pac)).toThrow("desktop_compatibility_activation_unverified");
    }
    expect(() => activateWindowsCodexCompatibility(() => { throw new Error("fixture timeout"); }, install, pac)).toThrow("desktop_compatibility_activation_unverified");
  });
  test("the shipped Windows restart adapter captures and reapplies an active compatibility PAC", () => {
    const { generation } = own();
    const commandLine = `"${install.root}\\app\\ChatGPT.exe" --proxy-pac-url=${pac}`;
    const io = executor({ running: `100 50 2026-01-01T00:00:00Z ${install.root}\\app\\ChatGPT.exe\t${Buffer.from(commandLine).toString("base64")}` });
    const processes = windowsDesktopAppAdapter.listProcesses(io.exec, install)!;
    expect(processes[0]?.commandLine).toBe(commandLine);
    const context = windowsDesktopAppAdapter.captureRelaunchContext(io.exec, install, processes);
    expect(context).toEqual({ codexCompatibilityPacUrl: pac, codexCompatibilityGeneration: generation });
    windowsDesktopAppAdapter.relaunch(io.exec, install, context);
    expect(io.calls.at(-1)).toContain("OpenCodexPackageActivation");
    expect(io.calls.at(-1)).toContain(pac);
  });

  test("an explicitly unreadable root command line survives parsing and refuses context capture", () => {
    for (const commandLine of ["", "   "]) {
      const io = executor({ running: `100 50 2026-01-01T00:00:00Z ${install.root}\\app\\ChatGPT.exe\t${Buffer.from(commandLine).toString("base64")}` });
      const processes = windowsDesktopAppAdapter.listProcesses(io.exec, install)!;
      expect(processes).toHaveLength(1);
      expect(processes[0]?.commandLine).toBe(commandLine);
      expect(() => windowsDesktopAppAdapter.captureRelaunchContext(io.exec, install, processes))
        .toThrow("desktop_compatibility_launch_context_unavailable");
    }
  });

  test("helper arguments cannot override the main app and conflicting roots refuse before a stop", () => {
    const { generation } = own();
    const root = { pid: 100, parentPid: 50, createdAt: "fixture", executable: "ChatGPT.exe", commandLine: `ChatGPT.exe --proxy-pac-url=${pac}` };
    const other = pac.replace(":10102", ":10103");
    expect(captureWindowsCompatibilityContext([root, { ...root, pid: 101, parentPid: 100, commandLine: `ChatGPT.exe --proxy-pac-url=${other}` }]))
      .toEqual({ codexCompatibilityPacUrl: pac, codexCompatibilityGeneration: generation });
    expect(() => captureWindowsCompatibilityContext([root, { ...root, pid: 200, commandLine: `ChatGPT.exe --proxy-pac-url=${other}` }]))
      .toThrow("desktop_compatibility_conflicting_launch_context");
    expect(captureWindowsCompatibilityContext([{ ...root, commandLine: "ChatGPT.exe" }])).toEqual({});
    expect(captureWindowsCompatibilityContext([root, { ...root, pid: 101, parentPid: 100, commandLine: "" }]))
      .toEqual({ codexCompatibilityPacUrl: pac, codexCompatibilityGeneration: generation });
  });

  test("a foreign same-shape endpoint and an invalidated owner refuse capture", () => {
    let current = true;
    own(pac, () => current);
    const root = { pid: 100, parentPid: 50, createdAt: "fixture", executable: "ChatGPT.exe", commandLine: `ChatGPT.exe --proxy-pac-url=${pac.replace(":10102", ":10103")}` };
    expect(() => captureWindowsCompatibilityContext([root])).toThrow("desktop_compatibility_launch_owner_unverified");
    current = false;
    expect(() => captureWindowsCompatibilityContext([{ ...root, commandLine: `ChatGPT.exe --proxy-pac-url=${pac}` }]))
      .toThrow("desktop_compatibility_launch_owner_unverified");
  });

  test("a stopped or replaced runtime cannot reuse a previously captured restart context", () => {
    const first = own();
    const root = { pid: 100, parentPid: 50, createdAt: "fixture", executable: "ChatGPT.exe", commandLine: `ChatGPT.exe --proxy-pac-url=${pac}` };
    const context = captureWindowsCompatibilityContext([root]), io = executor();
    first.release();
    expect(() => windowsDesktopAppAdapter.relaunch(io.exec, install, context)).toThrow("desktop_compatibility_launch_owner_unverified");
    const second = own();
    expect(second.generation).not.toBe(first.generation);
    expect(() => windowsDesktopAppAdapter.relaunch(io.exec, install, context)).toThrow("desktop_compatibility_launch_owner_unverified");
    expect(io.calls).toEqual([]);
    windowsDesktopAppAdapter.relaunch(io.exec, install, captureWindowsCompatibilityContext([root]));
    expect(io.calls).toHaveLength(1);
  });

  test("accepts only canonical owned-shape loopback PAC URLs", () => {
    expect(validatedCompatibilityPacUrl(pac)).toBe(pac);
    for (const value of ["https://127.0.0.1:10102/fixture-0123456789/proxy.pac", pac.replace("127.0.0.1", "localhost"),
      pac + "?other=1", pac + "#fragment", pac.replace("127.0.0.1", "user@127.0.0.1"), pac.replace("proxy.pac", "other.pac"),
      pac.replace("fixture-0123456789", "short"), pac + " --disable-web-security", pac.replace(":10102", "")]) {
      expect(() => validatedCompatibilityPacUrl(value)).toThrow("desktop_compatibility_invalid_pac_url");
    }
  });

  test("uses Windows package activation with PAC arguments and requires package readback", () => {
    const io = executor();
    expect(launchWindowsCodexCompatibility(pac, { exec: io.exec, platform: "win32" })).toEqual({ status: "started", pid: 123, packageFullName });
    const script = io.calls.at(-1)!;
    expect(script).toContain("::Activate($family+'!App','--proxy-pac-url='+$pac)");
    expect(script).toContain("::PackageOf($pidValue)");
    expect(script).toContain("Get-AppxPackageManifest");
    expect(script).toContain("Launch arguments not observed");
    expect(script).not.toContain("Start-Process");
    expect(script).not.toContain("taskkill");
  });

  test("an existing app or failed process discovery refuses before activation", () => {
    const running = executor({ running: `100 50 2026-01-01T00:00:00Z ${install.root}\\app\\ChatGPT.exe` });
    expect(launchWindowsCodexCompatibility(pac, { exec: running.exec, platform: "win32" })).toEqual({ status: "refused", reason: "app_running" });
    expect(running.calls.some(script => script.includes("OpenCodexPackageActivation"))).toBe(false);
    const failed = executor({ probeFailure: true });
    expect(launchWindowsCodexCompatibility(pac, { exec: failed.exec, platform: "win32" })).toEqual({ status: "refused", reason: "process_probe_failed" });
  });

  test("unverified activation or the wrong package publisher cannot report success", () => {
    for (const output of ["broken", JSON.stringify({ pid: 123, packageFullName, verified: false }),
      JSON.stringify({ pid: 123, packageFullName: "OpenAI.Codex_1.2.3.0_x64__foreign", verified: true })]) {
      const io = executor({ output });
      expect(launchWindowsCodexCompatibility(pac, { exec: io.exec, platform: "win32" })).toEqual({ status: "refused", reason: "activation_failed" });
    }
  });

  test("non-Windows and armed tests never reach the real native app", () => {
    expect(launchWindowsCodexCompatibility(pac, { platform: "linux" })).toEqual({ status: "refused", reason: "unsupported_platform" });
    expect(launchWindowsCodexCompatibility(pac, { platform: "win32" })).toEqual({ status: "refused", reason: "test_environment" });
  });

  test.skipIf(process.platform !== "win32")("the real Windows parser and COM service accept the adapter without launching an app", () => {
    const script = compatibilityActivationScript(install, pac);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const validation = ["$ErrorActionPreference='Stop'",
      `$null=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
      "Add-Type -TypeDefinition @'", WINDOWS_ACTIVATION_SOURCE, "'@",
      "[OpenCodexPackageActivation]::ValidateActivationService()", "'validated-without-launch'"].join("\n");
    const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", validation], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(output.trim()).toBe("validated-without-launch");
  }, 15_000);
});

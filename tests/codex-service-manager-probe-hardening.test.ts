import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectServiceManagerInstallation,
  type RawProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";

let home = "";
let configDir = "";
let trustedSystem32 = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-probe-hardening-"));
  configDir = join(home, "custom-opencodex");
  trustedSystem32 = join(home, "System32");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(trustedSystem32, { recursive: true });
  writeFileSync(join(trustedSystem32, "schtasks.exe"), "");
  writeFileSync(join(trustedSystem32, "sc.exe"), "");
  setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
});

afterEach(() => {
  setTrustedWindowsSystemDirectoryResolverForTests(null);
  rmSync(home, { recursive: true, force: true });
});

function raw(
  status: number | null,
  stdout = "",
  stderr = "",
  extra: Partial<ReturnType<RawProbeRunner>> = {},
): ReturnType<RawProbeRunner> {
  return {
    status,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from(stderr, "utf8"),
    timedOut: false,
    spawnFailed: false,
    ...extra,
  };
}

function cp949KoreanFixture(value: string): Buffer {
  const parts = value.split("한글");
  if (parts.length !== 2) throw new Error("fixture must contain exactly one Korean marker");
  return Buffer.concat([
    Buffer.from(parts[0]!, "ascii"),
    Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]),
    Buffer.from(parts[1]!, "ascii"),
  ]);
}

function schedulerXml(launcherPath: string): string {
  const escaped = launcherPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    "<Task>",
    "  <Actions>",
    "    <Exec>",
    `      <Arguments>/b /nologo &quot;${escaped}&quot;</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ].join("\n");
}

function writeSchedulerChain(
  dir: string,
  codexHome: string,
  opencodexHome: string,
  options: { writeTaskXml?: boolean } = {},
): { launcher: string; wrapper: string; taskXml: string } {
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "opencodex-service.cmd");
  const launcher = join(dir, "opencodex-service-launcher.vbs");
  const taskXml = join(dir, "opencodex-service-task.xml");
  writeFileSync(wrapper, [
    "@echo off",
    "setlocal",
    `set "CODEX_HOME=${codexHome}"`,
    `set "OPENCODEX_HOME=${opencodexHome}"`,
    'set "OCX_BUN=C:\\bun\\bun.exe"',
    'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
    ":loop",
    '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
  ].join("\r\n"));
  writeFileSync(launcher, `shell.Run """${wrapper}""", 0, True\r\n`);
  if (options.writeTaskXml !== false) writeFileSync(taskXml, schedulerXml(launcher));
  return { launcher, wrapper, taskXml };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function writeWinsw(
  dir: string,
  codexHome: string,
  opencodexHome: string,
): void {
  const winswDir = join(dir, "winsw");
  mkdirSync(winswDir, { recursive: true });
  writeFileSync(join(winswDir, "opencodex-proxy-native.exe"), "not-executable-test-placeholder");
  writeFileSync(join(winswDir, "opencodex-proxy-native.xml"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<service>",
    "  <id>opencodex-proxy-native</id>",
    `  <env name="CODEX_HOME" value="${xmlEscape(codexHome)}"/>`,
    `  <env name="OPENCODEX_HOME" value="${xmlEscape(opencodexHome)}"/>`,
    '  <arguments>"C:\\cli\\index.ts" start --port 10100</arguments>',
    "</service>",
  ].join("\n"));
}

function taskAbsentRunner(calls: Array<{ file: string; args: readonly string[] }>): RawProbeRunner {
  return (file, args) => {
    calls.push({ file, args });
    if (args[0]?.toLowerCase() === "query" && args.includes("/xml")) {
      return raw(1, "", "ERROR: The system cannot find the file specified.");
    }
    if (args[0]?.toLowerCase() === "/query" && args.includes("/xml")) {
      return raw(1, "", "ERROR: The system cannot find the file specified.");
    }
    if (args.includes("/fo")) return raw(0, "");
    return raw(1, "", "ERROR: The system cannot find the file specified.");
  };
}

describe("Windows ownership probe hardening regressions", () => {
  test("registered CP949 task XML preserves a Korean profile path", () => {
    const koreanConfigDir = join(home, "한글", ".opencodex");
    const codexHome = join(home, "한글", ".codex");
    const chain = writeSchedulerChain(koreanConfigDir, codexHome, koreanConfigDir);
    const runRaw: RawProbeRunner = (file, args) => {
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) {
        return {
          ...raw(0),
          stdout: cp949KoreanFixture(schedulerXml(chain.launcher)),
        };
      }
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir: koreanConfigDir,
      runRaw,
      windowsLocale: "ko-KR",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("present");
    expect(result.claims[0].homes).toEqual({ codexHome, opencodexHome: koreanConfigDir });
  });

  test("ownership inspects the effective current OPENCODEX_HOME without an injected configDir", () => {
    const currentCodexHome = "C:\\current\\.codex";
    const foreignCodexHome = "C:\\foreign\\.codex";
    writeSchedulerChain(configDir, foreignCodexHome, configDir);
    const statePath = join(configDir, "service-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      backend: "scheduler",
      codexHome: currentCodexHome,
      opencodexHome: configDir,
    }));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      runRaw,
      winswStatus: () => "nonexistent",
      statePaths: [statePath],
      currentHomes: { codexHome: currentCodexHome, opencodexHome: configDir },
    });

    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("different homes");
  });

  test("the default WinSW registration probe uses bounded trusted sc.exe instead of executing the WinSW binary", () => {
    const codexHome = "C:\\owned\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw: RawProbeRunner = (file, args) => {
      calls.push({ file, args });
      if (file.toLowerCase().endsWith("sc.exe")) return raw(0, "SERVICE_NAME: opencodex-proxy-native");
      if (args.includes("/xml")) return raw(1, "", "ERROR: Das System kann die angegebene Datei nicht finden.");
      if (args.includes("/fo")) return raw(0, "");
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({ platform: "win32", home, configDir, runRaw });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].backend).toBe("winsw");
    expect(calls.some(call => call.file.toLowerCase().endsWith("sc.exe")
      && call.args[0] === "query"
      && call.args[1] === "opencodex-proxy-native")).toBe(true);
    expect(calls.every(call => call.file.toLowerCase().includes("system32"))).toBe(true);
  });

  test("registered scheduler plus registered WinSW conflicts even when staged task XML is missing", () => {
    const codexHome = "C:\\owned\\.codex";
    const scheduler = writeSchedulerChain(configDir, codexHome, configDir, { writeTaskXml: false });
    writeWinsw(configDir, codexHome, configDir);
    const runRaw: RawProbeRunner = (_file, args) => {
      if (args.includes("/xml")) return raw(0, schedulerXml(scheduler.launcher));
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
    });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.claims.map(claim => claim.backend).sort()).toEqual(["scheduler", "winsw"]);
  });

  test("a scheduler definition cannot make the probe follow a launcher outside the generated config chain", () => {
    const foreignDir = join(home, "foreign");
    const foreign = writeSchedulerChain(foreignDir, "C:\\foreign\\.codex", foreignDir);
    writeFileSync(join(configDir, "opencodex-service-task.xml"), schedulerXml(foreign.launcher));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("expected launcher");
  });

  test("localized schtasks task-not-found output falls back to the task listing before declaring absence", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw: RawProbeRunner = (file, args) => {
      calls.push({ file, args });
      if (args.includes("/xml")) {
        return raw(1, "", "FEHLER: Das System kann die angegebene Datei nicht finden.");
      }
      if (args.includes("/fo")) {
        return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("absent");
    expect(calls.some(call => call.args.includes("/fo"))).toBe(true);
  });

  test("a staged but unregistered WinSW definition remains visible as a present claim", () => {
    const codexHome = "C:\\staged\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].backend).toBe("winsw");
    expect(result.claims[0].registration).toBe("absent");
  });

  test("legacy v1 service state means scheduler and cannot authorize a WinSW manager", () => {
    const codexHome = "C:\\owned\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const statePath = join(configDir, "service-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      codexHome,
      opencodexHome: configDir,
    }));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
      statePaths: [statePath],
      currentHomes: { codexHome, opencodexHome: configDir },
    });

    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("backend scheduler");
  });

  test("WinSW home values are XML-unescaped before ownership comparison", () => {
    const codexHome = "C:\\Users\\A&B\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBe(codexHome);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as configFacade from "../src/config";
import {
  getPidPath,
  getRuntimePortPath,
  isOcxStartCommandLine,
  ocxStartProcessCacheSizeForTests,
  parsePidFile,
  readPid,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  setOcxStartProcessCacheForTests,
  setProcessCommandLineExecForTests,
  setProcessCommandLinePlatformForTests,
  writePid,
  writeRuntimePort,
} from "../src/config/process-state";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-process-state-"));
  process.env.OPENCODEX_HOME = testDir;
  setOcxStartProcessCacheForTests([]);
});

afterEach(() => {
  setProcessCommandLineExecForTests(null);
  setProcessCommandLinePlatformForTests(null);
  setTrustedWindowsSystemDirectoryResolverForTests(null);
  setOcxStartProcessCacheForTests([]);
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("proxy process-state ownership", () => {
  test("the process-state leaf does not import the config facade", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "config", "process-state.ts"), "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\.\/config["']/);
    expect(source).toContain('from "./atomic-write"');
    expect(source).toContain('from "./paths"');
  });

  test("config.ts remains a compatibility facade for public process-state exports", () => {
    expect(configFacade.getPidPath).toBe(getPidPath);
    expect(configFacade.getRuntimePortPath).toBe(getRuntimePortPath);
    expect(configFacade.readPid).toBe(readPid);
    expect(configFacade.readRuntimePort).toBe(readRuntimePort);
  });

  test("parses pid files", () => {
    expect(parsePidFile("12345")).toBe(12345);
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("12x")).toBeNull();
    expect(parsePidFile("not-json")).toBeNull();
  });

  test("recognizes opencodex start command lines", () => {
    expect(isOcxStartCommandLine("bun run src/cli.ts start")).toBe(true);
    expect(isOcxStartCommandLine('"C:/tools/bun/bin/bun.exe" "run" "src/cli/index.ts" "start"')).toBe(true);
    expect(isOcxStartCommandLine("bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start")).toBe(true);
    expect(isOcxStartCommandLine(
      "bun C:/nvm/node_modules/@bitkyc08/.opencodex-1JejBqbZ/src/cli/index.ts start --port 10100",
    )).toBe(true);
    expect(isOcxStartCommandLine("opencodex start")).toBe(true);
    expect(isOcxStartCommandLine("bun run src/cli.ts status")).toBe(false);
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid state through the shared atomic writer", () => {
    writePid(process.pid);
    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("pid validation never resolves ps through PATH", () => {
    const attackerDir = join(testDir, "attacker-bin");
    const fakePs = join(attackerDir, "ps");
    const markerPath = `${fakePs}.executed`;
    const previousPath = process.env.PATH;
    const probes: string[] = [];
    mkdirSync(attackerDir);
    writeFileSync(fakePs, `#!/bin/sh\ntouch "$0.executed"\necho 'ocx start'\n`, { mode: 0o755 });

    try {
      setProcessCommandLinePlatformForTests("darwin");
      setProcessCommandLineExecForTests(executable => {
        probes.push(executable);
        throw new Error("fixed ps probe unavailable");
      });
      process.env.PATH = `${attackerDir}${delimiter}${previousPath ?? ""}`;
      writePid(process.pid);

      expect(readPid()).toBeNull();
      expect(probes).toEqual(["/bin/ps", "/usr/bin/ps"]);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(process.env.PATH).toBe(previousPath);
    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
  });

  test("pid validation selects only trusted Windows process probes", () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    const trustedSystem32 = join(testDir, "trusted", "System32");
    const trustedWmic = join(trustedSystem32, "wbem", "WMIC.exe");
    const trustedPowerShell = join(trustedSystem32, "WindowsPowerShell", "v1.0", "powershell.exe");
    const attackerRoot = join(testDir, "attacker-windows");
    const calls: string[] = [];

    try {
      mkdirSync(dirname(trustedPowerShell), { recursive: true });
      writeFileSync(trustedPowerShell, "", { mode: 0o755 });
      setProcessCommandLinePlatformForTests("win32");
      setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
      process.env.SystemRoot = attackerRoot;
      process.env.WINDIR = attackerRoot;
      writeFileSync(getPidPath(), String(process.pid), "utf-8");

      setProcessCommandLineExecForTests(executable => {
        calls.push(executable);
        if (executable === trustedWmic) return "CommandLine=ocx start\r\n";
        throw new Error(`unexpected process probe: ${executable}`);
      });
      expect(readPid()).toBe(process.pid);
      expect(calls).toEqual([trustedWmic]);

      calls.length = 0;
      setOcxStartProcessCacheForTests([]);
      setProcessCommandLineExecForTests(executable => {
        calls.push(executable);
        if (executable === trustedWmic) throw new Error("WMIC unavailable");
        if (executable === trustedPowerShell) return "ocx start\n";
        throw new Error(`unexpected process probe: ${executable}`);
      });
      expect(readPid()).toBe(process.pid);
      expect(calls).toEqual([trustedWmic, trustedPowerShell]);
      expect(calls.every(executable => !executable.startsWith(attackerRoot))).toBe(true);
    } finally {
      setOcxStartProcessCacheForTests([]);
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }

    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
  });

  test("removes pid state only while the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });

  test("runtime port metadata round-trips and validates the expected pid", () => {
    const attestationSecret = "A".repeat(43);
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });

    expect(readRuntimePort()).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });
    expect(readRuntimePort(1234)).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });
    expect(readRuntimePort(9999)).toBeNull();
  });

  test("runtime port removal preserves newer pid state", () => {
    writeRuntimePort({ pid: 1234, port: 58195 });
    removeRuntimePort(9999);
    expect(existsSync(getRuntimePortPath())).toBe(true);
    removeRuntimePort(1234);
    expect(existsSync(getRuntimePortPath())).toBe(false);
  });

  test("invalid runtime port metadata is rejected", () => {
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 99999 }), "utf-8");
    expect(readRuntimePort()).toBeNull();

    writeFileSync(
      getRuntimePortPath(),
      JSON.stringify({ pid: 1234, port: 58195, attestationSecret: "too-short" }),
      "utf-8",
    );
    expect(readRuntimePort()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as configFacade from "../../src/config";
import {
  getPidPath,
  getRuntimePortPath,
  isOcxCommandLine,
  isLikelyOcxProcess,
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
} from "../../src/config/process-state";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../../src/lib/windows-elevation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

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
    const source = readFileSync(repoPath("src", "config", "process-state.ts"), "utf-8");
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
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/server/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("recognizes opencodex command lines that are not the proxy", () => {
    // A pending-teardown receipt is owned by whichever invocation claimed it, and that is
    // never an `ocx start`. Asking the start-shaped question about a stop or update worker
    // called every real owner foreign, which is one half of the #4897 wedge.
    expect(isOcxCommandLine("bun run src/cli.ts stop")).toBe(true);
    expect(isOcxCommandLine("opencodex update --tag latest")).toBe(true);
    expect(isOcxCommandLine("ocx stop")).toBe(true);
    expect(isOcxCommandLine("node C:/npm/node_modules/@bitkyc08/opencodex/bin/ocx.mjs update")).toBe(true);
    // And it must stay narrow enough to keep an unrelated process from impersonating one.
    expect(isOcxCommandLine("notepad.exe")).toBe(false);
    expect(isOcxCommandLine("bun test C:/work/opencodex/tests/server/config.test.ts")).toBe(false);
    expect(isOcxCommandLine("/usr/sbin/cupsd -l")).toBe(false);
    // The broader predicate is a superset of the start one, never a replacement for it.
    expect(isOcxCommandLine("bun run src/cli.ts start")).toBe(true);
    expect(isOcxStartCommandLine("bun run src/cli.ts stop")).toBe(false);
    expect(isOcxStartCommandLine("opencodex update --tag latest")).toBe(false);
  });

  test("the ownership probe distinguishes a real owner from a reused PID", () => {
    // The stop-side teardown recovery asks this about a PID recorded in a receipt. Bare
    // liveness said "still running" for any process that inherited the number, so the
    // obligation was never recovered while both updater gates kept refusing (#4897).
    setProcessCommandLinePlatformForTests("darwin");

    setProcessCommandLineExecForTests(() => "node /usr/local/lib/node_modules/@bitkyc08/opencodex/bin/ocx.mjs update\n");
    expect(isLikelyOcxProcess(4242)).toBe(true);

    // The reported wedge: the owner exited and an unrelated process holds its number.
    setProcessCommandLineExecForTests(() => "/usr/sbin/cupsd -l\n");
    expect(isLikelyOcxProcess(4242)).toBe(false);

    // A probe that cannot answer is not evidence that the owner is still running. Reporting
    // "alive" there is what made the receipt permanently unrecoverable, so an unreadable
    // command line resolves to "not ours" and lets the recovery loop — which still has to
    // prove the endpoint is down — decide.
    setProcessCommandLineExecForTests(() => { throw new Error("ps unavailable"); });
    expect(isLikelyOcxProcess(4242)).toBe(false);

    // Never cached: a later call must re-ask rather than reuse an answer about a PID that
    // may since have been recycled again.
    setProcessCommandLineExecForTests(() => "ocx stop\n");
    expect(isLikelyOcxProcess(4242)).toBe(true);
    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
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

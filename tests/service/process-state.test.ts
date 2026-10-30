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
  verifyPidIdentity,
  writePid,
  writeRuntimePort,
} from "../../src/config/process-state";
import {
  describeTrackedRuntimeTarget,
  inspectTrackedRuntimeRecord,
} from "../../src/config/tracked-runtime-inspection";
import type { TrackedRecordProbeDeps } from "../../src/config/tracked-runtime-inspection";
import { markSiblingStart, resetSiblingStartForTests, siblingRuntimeField } from "../../src/codex/sibling-start";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../../src/lib/windows-elevation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

let testDir = "";
const previousHome = process.env.OPENCODEX_HOME;

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
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
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

  test("recognizes the Windows standalone executable, whatever its case or path shape", () => {
    // scripts/build-standalone.ts and desktop/scripts/prepare-sidecar.ts both emit ocx.exe
    // on Windows targets, and the bundled sidecar is copied as ocx-<triple>.exe. A quoted
    // install path with spaces is the realistic WMIC/PowerShell command line for it.
    expect(isOcxCommandLine('"C:/Program Files/OpenCodex/bin/ocx.exe" start --port 10100')).toBe(true);
    expect(isOcxCommandLine('"C:\\Program Files\\OpenCodex\\bin\\OCX.EXE" start')).toBe(true);
    expect(isOcxCommandLine("C:/tools/ocx.exe stop")).toBe(true);
    expect(isOcxCommandLine("ocx.exe")).toBe(true);
    expect(isOcxCommandLine("opencodex.exe status")).toBe(true);
    expect(isOcxStartCommandLine('"C:/Program Files/OpenCodex/bin/ocx.exe" start')).toBe(true);
    // Lookalikes stay foreign: the token boundary around the executable name is the whole
    // defence, and widening it for .exe must not widen it for neighbours.
    expect(isOcxCommandLine("not-ocx.exe start")).toBe(false);
    expect(isOcxCommandLine("myocx.exe")).toBe(false);
    expect(isOcxCommandLine("ocx.exes start")).toBe(false);
  });

  test("a transient Windows command-line probe failure is retried once", () => {
    const trustedSystem32 = join(testDir, "trusted", "System32");
    const trustedWmic = join(trustedSystem32, "wbem", "WMIC.exe");
    const trustedPowerShell = join(trustedSystem32, "WindowsPowerShell", "v1.0", "powershell.exe");
    const calls: string[] = [];
    mkdirSync(dirname(trustedPowerShell), { recursive: true });
    writeFileSync(trustedPowerShell, "", { mode: 0o755 });
    setProcessCommandLinePlatformForTests("win32");
    setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
    // WMIC absent, the first CIM read times out, the retry answers — an unchanged
    // process must not read as foreign because one probe flaked.
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      if (executable === trustedPowerShell && calls.filter(entry => entry === trustedPowerShell).length === 2) {
        return "C:\\tools\\ocx.exe start\n";
      }
      throw new Error("probe unavailable");
    });
    expect(isLikelyOcxProcess(4242)).toBe(true);
    expect(calls).toEqual([trustedWmic, trustedPowerShell, trustedPowerShell]);
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

  test("a sibling record carries the live owner's port; every other record keeps its bytes", () => {
    // Absent means "not a sibling", and the writer must not add the key: a non-sibling record is
    // byte-identical to the one written before the field existed.
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "127.0.0.1", ...siblingRuntimeField() });
    expect(readFileSync(getRuntimePortPath(), "utf-8"))
      .toBe(`${JSON.stringify({ pid: 1234, port: 58195, hostname: "127.0.0.1" }, null, 2)}\n`);
    expect(readRuntimePort()?.siblingOfPort).toBeUndefined();

    markSiblingStart(10100);
    try {
      writeRuntimePort({ pid: 1234, port: 10199, hostname: "127.0.0.1", ...siblingRuntimeField() });
    } finally {
      resetSiblingStartForTests();
    }
    expect(readRuntimePort()).toEqual({ pid: 1234, port: 10199, hostname: "127.0.0.1", siblingOfPort: 10100 });

    for (const siblingOfPort of [0, 70000, 1.5, "10100", null]) {
      writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 10199, siblingOfPort }), "utf-8");
      expect(readRuntimePort()).toBeNull();
    }
  });
});

describe("tracked runtime record inspection", () => {
  // Injected deps keep every probe input fake: no process.kill, no WMIC/PowerShell/ps,
  // and no real stop ever runs. Record reads default to the real temp-home files. The
  // cache-sharing cases below drive the same exec seams production uses -- with faked
  // native answers and a real signal-0 read on this process only.
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error("fake " + code), { code });
  const liveOcx: TrackedRecordProbeDeps = { signal: () => {}, identity: () => "match" };
  const trackedPid = () => writeFileSync(getPidPath(), "4242", "utf-8");
  const trustedProbePaths = () => {
    const trustedSystem32 = join(testDir, "trusted", "System32");
    const trustedPowerShell = join(trustedSystem32, "WindowsPowerShell", "v1.0", "powershell.exe");
    mkdirSync(dirname(trustedPowerShell), { recursive: true });
    writeFileSync(trustedPowerShell, "", { mode: 0o755 });
    setProcessCommandLinePlatformForTests("win32");
    setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
    return { trustedWmic: join(trustedSystem32, "wbem", "WMIC.exe"), trustedPowerShell };
  };
  // The trusted-System32 seam also reroutes icacls resolution, so these records are
  // written directly like the cases above -- the parity being tested is the shared
  // identity cache, not the atomic writer.
  const trackedSelf = (hostname: string) => {
    writeFileSync(getPidPath(), String(process.pid), "utf-8");
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: process.pid, port: 58195, hostname }), "utf-8");
  };

  test("a verified record pair returns the tracked target", () => {
    trackedPid();
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 4242, port: 58195, hostname: "0.0.0.0" }), "utf-8");
    expect(inspectTrackedRuntimeRecord(liveOcx)).toEqual(
      { status: "verified", pid: 4242, port: 58195, hostname: "0.0.0.0" });
    expect(describeTrackedRuntimeTarget(liveOcx)).toEqual({ pid: 4242, port: 58195, hostname: "0.0.0.0" });
  });

  test("an absent or invalid pid record is named before any process probe", () => {
    const probes: string[] = [];
    const deps: TrackedRecordProbeDeps = {
      signal: () => { probes.push("signal"); },
      identity: () => { probes.push("identity"); return "match"; },
    };
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "pid-record-absent" });
    expect(probes).toEqual([]);

    writeFileSync(getPidPath(), "not-a-pid", "utf-8");
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "pid-record-invalid" });
    expect(probes).toEqual([]);
  });

  test("pid-record read errors separate real permission denials from other failures", () => {
    const denied = (code: string) => inspectTrackedRuntimeRecord({
      readFile: () => { throw errno(code); },
      signal: () => {},
      identity: () => "match",
    });
    expect(denied("EACCES")).toEqual({ status: "refused", reason: "pid-record-permission-denied" });
    expect(denied("EPERM")).toEqual({ status: "refused", reason: "pid-record-permission-denied" });
    expect(denied("EIO")).toEqual({ status: "refused", reason: "pid-record-unreadable" });
  });

  test("a dead recorded pid reports not-running; other signal errors stay unverifiable", () => {
    trackedPid();
    const withSignal = (signal: (pid: number) => void) =>
      inspectTrackedRuntimeRecord({ signal, identity: () => "match" });
    expect(withSignal(() => { throw errno("ESRCH"); })).toEqual(
      { status: "refused", reason: "process-not-running" });
    expect(withSignal(() => { throw errno("EINVAL"); })).toEqual(
      { status: "refused", reason: "process-unverifiable" });
    expect(withSignal(() => { throw new Error("signal probe failed"); })).toEqual(
      { status: "refused", reason: "process-unverifiable" });
  });

  test("an unverifiable identity observation is never permission evidence", () => {
    trackedPid();
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 4242, port: 58195 }), "utf-8");
    // Whether the liveness signal was clean or EPERM, an identity that cannot be
    // observed only means it could not be verified. The unelevated-desktop case
    // behind #7771 is one possibility, not a proven cause.
    for (const signal of [() => {}, () => { throw errno("EPERM"); }]) {
      expect(inspectTrackedRuntimeRecord({ signal, identity: () => "unverifiable" })).toEqual(
        { status: "refused", reason: "process-unverifiable" });
    }
    // And a foreign process holding the recorded pid is a different fact entirely.
    expect(inspectTrackedRuntimeRecord({
      signal: () => {},
      identity: () => "mismatch",
    })).toEqual({ status: "refused", reason: "process-identity-mismatch" });
  });

  test("runtime record failures distinguish absent, denied, invalid and pid-mismatch", () => {
    trackedPid();
    const deps: TrackedRecordProbeDeps = { signal: () => {}, identity: () => "match" };
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "runtime-record-absent" });

    writeFileSync(getRuntimePortPath(), "{not json", "utf-8");
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "runtime-record-invalid" });

    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 4242, port: 99999 }), "utf-8");
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "runtime-record-invalid" });

    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 9999, port: 58195 }), "utf-8");
    expect(inspectTrackedRuntimeRecord(deps)).toEqual(
      { status: "refused", reason: "runtime-record-pid-mismatch" });

    expect(inspectTrackedRuntimeRecord({
      readFile: path => path.endsWith("ocx.pid")
        ? "4242"
        : (() => { throw errno("EACCES"); })(),
      signal: () => {},
      identity: () => "match",
    })).toEqual({ status: "refused", reason: "runtime-record-permission-denied" });
  });

  test("refusal details are fixed sentences and never leak the observed error text", () => {
    const marker = "t0ken-c0mmand-l1ne";
    const mismatched = describeTrackedRuntimeTarget({
      readFile: () => { throw Object.assign(new Error("open failed " + marker), { code: "EPERM" }); },
      signal: () => {},
      identity: () => "mismatch",
    });
    expect(mismatched).toEqual({ untracked: "reading the recorded PID file was denied" });
    expect(JSON.stringify(mismatched)).not.toContain(marker);

    trackedPid();
    expect(describeTrackedRuntimeTarget(liveOcx)).toEqual(
      { untracked: "the tracked runtime record is absent" });
  });

  test("a cached start identity serves both readers after the native probe dies", () => {
    const { trustedWmic } = trustedProbePaths();
    trackedSelf("0.0.0.0");
    const calls: string[] = [];
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      if (executable === trustedWmic) return "CommandLine=ocx.exe start\r\n";
      throw new Error("unexpected process probe: " + executable);
    });
    // The pidless healthz path fills the shared start-identity cache for this PID.
    expect(verifyPidIdentity(process.pid)).toBe(process.pid);
    expect(calls).toEqual([trustedWmic]);
    // Every native probe is now dead: the cached verdict must still admit this
    // record for both readers, and neither may ask again.
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      throw new Error("native probe unavailable");
    });
    expect(readPid()).toBe(process.pid);
    expect(readRuntimePort(process.pid)?.port).toBe(58195);
    expect(describeTrackedRuntimeTarget()).toEqual({ pid: process.pid, port: 58195, hostname: "0.0.0.0" });
    expect(calls).toEqual([trustedWmic]);
  });

  test("a cached foreign verdict still refuses both readers while a fresh probe could answer", () => {
    trustedProbePaths();
    trackedSelf("0.0.0.0");
    setOcxStartProcessCacheForTests([[process.pid, false]]);
    const calls: string[] = [];
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      return "CommandLine=ocx.exe start\r\n";
    });
    expect(readPid()).toBeNull();
    expect(describeTrackedRuntimeTarget()).toEqual(
      { untracked: "the recorded process does not match the expected start command" });
    expect(calls).toEqual([]);
  });

  test("an unreadable identity answer is cached by neither reader and recovers together", () => {
    const { trustedWmic, trustedPowerShell } = trustedProbePaths();
    trackedSelf("0.0.0.0");
    const calls: string[] = [];
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      throw new Error("native probe unavailable");
    });
    expect(readPid()).toBeNull();
    expect(describeTrackedRuntimeTarget()).toEqual(
      { untracked: "the recorded process identity could not be verified" });
    // Each reader asked the identical dead sequence: WMIC, then both CIM retries.
    expect(calls).toEqual([
      trustedWmic, trustedPowerShell, trustedPowerShell,
      trustedWmic, trustedPowerShell, trustedPowerShell,
    ]);
    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
    // Recovery: the next miss re-probes once and the shared answer then serves both.
    calls.length = 0;
    setProcessCommandLineExecForTests(executable => {
      calls.push(executable);
      if (executable === trustedWmic) return "CommandLine=ocx.exe start\r\n";
      throw new Error("unexpected process probe: " + executable);
    });
    expect(readPid()).toBe(process.pid);
    expect(describeTrackedRuntimeTarget()).toEqual({ pid: process.pid, port: 58195, hostname: "0.0.0.0" });
    expect(calls).toEqual([trustedWmic]);
  });
});

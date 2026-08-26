import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";
import {
  afterCatalogWriteHandleAppServers,
  attachStaleAppServerHint,
  catalogStateTtlMs,
  collectCodexAppServerCatalogState,
  collectCodexAppServerCatalogStateForRequest,
  formatStaleCodexAppServerWarning,
  isCodexAppServerCommandLine,
  isWindowsCodexCandidateCommandLine,
  listCodexAppServerProcesses,
  listWindowsSnapshots,
  parseWindowsSnapshotOutput,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
  STALE_CODEX_APP_SERVER_HINT,
  warnIfStaleCodexAppServersAfterStartupWrite,
  WINDOWS_CODEX_BASENAME_CANDIDATE_RE,
} from "../src/codex/app-server-processes";

describe("collectCodexAppServerCatalogState (#857)", () => {
const APP_SERVER_CMD = "/usr/local/bin/codex app-server";

/**
 * A stand-in for powershell.exe that stalls, prints `line`, and exits.
 *
 * Platform-shaped on purpose: `execFile` launches its target directly with no shell, so a
 * POSIX `.sh` script is not an executable on Windows — and Windows is the platform this
 * whole fix exists for, with its own CI shard running this suite. On Windows the fake is a
 * `.cmd` invoked through `cmd.exe`; elsewhere it is a shell script.
 */
function writeStallingFakePowerShell(dir: string, line: string): string {
  if (process.platform === "win32") {
    const cmd = join(dir, "fake-powershell.cmd");
    writeFileSync(cmd, [
      "@echo off",
      // ~200ms without depending on timeout.exe, which refuses a redirected stdin.
      "ping -n 1 -w 200 192.0.2.1 >nul 2>&1",
      `echo ${line.replace(/\t/g, "\t")}`,
    ].join("\r\n"));
    return cmd;
  }
  const sh = join(dir, "fake-powershell.sh");
  writeFileSync(sh, ["#!/bin/sh", "sleep 0.2", `printf '%s\\n' '${line}'`].join("\n"));
  chmodSync(sh, 0o755);
  return sh;
}

  test("not_running when no app-server process exists", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [],
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("not_running");
    expect(status.processes).toEqual([]);
  });

  test("fresh when every app-server started after the catalog changed", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 2_000,
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("fresh");
  });

  test("stale when any app-server predates the catalog mtime", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [
        { pid: 42, commandLine: APP_SERVER_CMD },
        { pid: 43, commandLine: APP_SERVER_CMD },
      ],
      readStartMs: pid => (pid === 42 ? 500 : 3_000),
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("stale");
    expect(status.processes).toEqual([
      { pid: 42, startedAtMs: 500 },
      { pid: 43, startedAtMs: 3_000 },
    ]);
  });

  test("unknown when a start time is unreadable, and when the catalog is unreadable", () => {
    const noStart = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => null,
      catalogMtimeMs: () => 1_000,
    });
    expect(noStart.state).toBe("unknown");

    const noCatalog = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 500,
      catalogMtimeMs: () => null,
    });
    expect(noCatalog.state).toBe("unknown");
  });

  test("Windows request collection yields to the event loop while CIM enumeration is slow (#1852)", async () => {
    let releaseSnapshots: ((snapshots: Array<{ pid: number; commandLine: string }>) => void) | undefined;
    const snapshots = new Promise<Array<{ pid: number; commandLine: string }>>(resolve => {
      releaseSnapshots = resolve;
    });
    const collection = collectCodexAppServerCatalogStateForRequest({
      platform: "win32",
      listSnapshotsAsync: () => snapshots,
      readStartMsBatchAsync: async pids => new Map(pids.map(pid => [pid, 2_000])),
      catalogMtimeMs: () => 1_000,
    });

    const first = await Promise.race([
      collection.then(() => "collection"),
      new Promise<"timer">(resolve => setTimeout(() => resolve("timer"), 10)),
    ]);
    expect(first).toBe("timer");

    releaseSnapshots?.([{ pid: 42, commandLine: APP_SERVER_CMD }]);
    await expect(collection).resolves.toMatchObject({ state: "fresh" });
  });

  // The test above injects an ALREADY-async seam, so it stays green whether or not the
  // production default is async: reverting the default to `execFileSync` leaves every
  // assertion in it passing. It describes the intended design without guarding it.
  //
  // The one below guards it. It replaces the *executable* rather than the code under
  // test, so BOTH default PowerShell calls — process enumeration and start-time
  // discovery — run for real through their production wiring. A synchronous
  // implementation parks the event loop for the script's whole duration; an
  // asynchronous one does not. That difference is the entire content of #1852.
  test("the default Windows request path keeps the event loop alive through both PowerShell calls (#1852)", async () => {
    resetCodexAppServerCatalogStateCache();
    const dir = mkdtempSync(join(tmpdir(), "ocx-ps-fake-"));
    const fake = writeStallingFakePowerShell(dir, `42\t${APP_SERVER_CMD}\tCONTOSO\\jun`);
    setTrustedWindowsElevationExecutablesForTests({ powershell: fake });

    // Phase signal instead of a timer count. A callback tally has to pick a threshold
    // between "sync" and "async" observations, and `setInterval` makes no catch-up
    // guarantee — on a loaded runner a correct implementation can dip under any midpoint.
    // This asks a binary question instead: did event-loop work make progress WHILE the
    // child was running? A synchronous exec parks the loop, so the flag stays false no
    // matter how slow or fast the machine is.
    let loopRanDuringExec = false;
    const beat = setInterval(() => { loopRanDuringExec = true; }, 5);
    let status: Awaited<ReturnType<typeof collectCodexAppServerCatalogStateForRequest>>;
    try {
      status = await collectCodexAppServerCatalogStateForRequest({
        platform: "win32",
        catalogMtimeMs: () => 1_000,
        // Only the enumeration is exercised here; the start-time half has its own test.
        readStartMsBatchAsync: async pids => new Map(pids.map(pid => [pid, 2_000])),
      });
    } finally {
      clearInterval(beat);
      setTrustedWindowsElevationExecutablesForTests(null);
      rmSync(dir, { recursive: true, force: true });
      resetCodexAppServerCatalogStateCache();
    }

    // Without this a failed exec ("not_running") would look identical to a fast one.
    expect(status.processes.map(proc => proc.pid)).toEqual([42]);
    expect(loopRanDuringExec).toBe(true);
  });

  // The request path makes TWO PowerShell calls. The test above injects
  // `readStartMsBatchAsync` so it isolates the first one — which means reverting the
  // SECOND to a synchronous read slips past it. That second call is up to five seconds of
  // blocking when an app-server exists, so it needs its own oracle.
  test("the default Windows start-time discovery keeps the event loop alive (#1852)", async () => {
    resetCodexAppServerCatalogStateCache();
    const dir = mkdtempSync(join(tmpdir(), "ocx-ps-start-"));
    const fake = writeStallingFakePowerShell(dir, `42\t${APP_SERVER_CMD}\tCONTOSO\\jun`);
    setTrustedWindowsElevationExecutablesForTests({ powershell: fake });

    let loopRanDuringExec = false;
    const beat = setInterval(() => { loopRanDuringExec = true; }, 5);
    try {
      // No readStartMsBatchAsync override: the default start-time path must run for real.
      await collectCodexAppServerCatalogStateForRequest({
        platform: "win32",
        listSnapshotsAsync: async () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
        catalogMtimeMs: () => 1_000,
      });
    } finally {
      clearInterval(beat);
      setTrustedWindowsElevationExecutablesForTests(null);
      rmSync(dir, { recursive: true, force: true });
      resetCodexAppServerCatalogStateCache();
    }

    expect(loopRanDuringExec).toBe(true);
  });

  test("Windows request collection shares one in-flight refresh and its short cache (#1852)", async () => {
    resetCodexAppServerCatalogStateCache();
    let calls = 0;
    let now = 1_000;
    const io = {
      platform: "win32" as const,
      now: () => now,
      listSnapshotsAsync: async () => {
        calls += 1;
        await Bun.sleep(10);
        return [{ pid: 42, commandLine: APP_SERVER_CMD }];
      },
      readStartMsBatchAsync: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, 2_000])),
      catalogMtimeMs: () => 1_000,
    };

    const [first, joined] = await Promise.all([
      collectCodexAppServerCatalogStateForRequest(io),
      collectCodexAppServerCatalogStateForRequest(io),
    ]);
    expect(first.state).toBe("fresh");
    expect(joined).toBe(first);
    expect(calls).toBe(1);

    now += 4_999;
    expect((await collectCodexAppServerCatalogStateForRequest(io)).state).toBe("fresh");
    expect(calls).toBe(1);

    now += 2;
    expect((await collectCodexAppServerCatalogStateForRequest(io)).state).toBe("fresh");
    expect(calls).toBe(2);
    resetCodexAppServerCatalogStateCache();
  });

  test("cache invalidation cannot be undone by an older in-flight Windows refresh (#1852)", async () => {
    resetCodexAppServerCatalogStateCache();
    let calls = 0;
    let releaseFirst: ((snapshots: Array<{ pid: number; commandLine: string }>) => void) | undefined;
    const firstSnapshots = new Promise<Array<{ pid: number; commandLine: string }>>(resolve => {
      releaseFirst = resolve;
    });
    const io = {
      platform: "win32" as const,
      listSnapshotsAsync: async () => {
        calls += 1;
        if (calls === 1) return firstSnapshots;
        return [];
      },
      readStartMsBatchAsync: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, 2_000])),
      catalogMtimeMs: () => 1_000,
    };

    const staleFlight = collectCodexAppServerCatalogStateForRequest(io);
    resetCodexAppServerCatalogStateCache();
    releaseFirst?.([{ pid: 42, commandLine: APP_SERVER_CMD }]);
    // The awaiting request must NOT receive the pre-write `fresh`. It was true
    // before the invalidating write and is false after it, and `fresh` is the one
    // state that authorizes positive model guidance — so handing it back trades the
    // original hang for a wrong answer. `unknown` is what an invalidated
    // observation actually knows, and the guidance path already stays silent on it.
    await expect(staleFlight).resolves.toMatchObject({ state: "unknown" });

    await expect(collectCodexAppServerCatalogStateForRequest(io)).resolves.toMatchObject({
      state: "not_running",
    });
    expect(calls).toBe(2);
    resetCodexAppServerCatalogStateCache();
  });

  test("an invalidated in-flight refresh does not poison the next request (#1852)", async () => {
    // Companion to the case above: degrading the obsolete result to `unknown` must
    // not also suppress the NEXT observation, which is made after the write and is
    // therefore the one the caller should trust.
    resetCodexAppServerCatalogStateCache();
    let calls = 0;
    let releaseFirst: ((snapshots: Array<{ pid: number; commandLine: string }>) => void) | undefined;
    const firstSnapshots = new Promise<Array<{ pid: number; commandLine: string }>>(resolve => {
      releaseFirst = resolve;
    });
    const io = {
      platform: "win32" as const,
      listSnapshotsAsync: async () => {
        calls += 1;
        if (calls === 1) return firstSnapshots;
        return [{ pid: 43, commandLine: APP_SERVER_CMD }];
      },
      readStartMsBatchAsync: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, 2_000])),
      catalogMtimeMs: () => 1_000,
    };

    const obsolete = collectCodexAppServerCatalogStateForRequest(io);
    resetCodexAppServerCatalogStateCache();
    releaseFirst?.([{ pid: 42, commandLine: APP_SERVER_CMD }]);
    await expect(obsolete).resolves.toMatchObject({ state: "unknown" });

    await expect(collectCodexAppServerCatalogStateForRequest(io)).resolves.toMatchObject({
      state: "fresh",
    });
    expect(calls).toBe(2);
    resetCodexAppServerCatalogStateCache();
  });

  test("Windows request collection briefly caches failed CIM enumeration (#1852)", async () => {
    resetCodexAppServerCatalogStateCache();
    let calls = 0;
    let now = 1_000;
    const io = {
      platform: "win32" as const,
      now: () => now,
      listSnapshotsAsync: async () => {
        calls += 1;
        throw new Error("windows_enum_incomplete");
      },
      catalogMtimeMs: () => 1_000,
    };

    await expect(collectCodexAppServerCatalogStateForRequest(io)).resolves.toMatchObject({
      state: "unknown",
    });
    now += 10;
    await expect(collectCodexAppServerCatalogStateForRequest(io)).resolves.toMatchObject({
      state: "unknown",
    });
    // Failure is advisory and fail-closed, but caching it briefly prevents a
    // broken CIM provider from spawning one PowerShell process per request.
    expect(calls).toBe(1);

    now += 241;
    await expect(collectCodexAppServerCatalogStateForRequest(io)).resolves.toMatchObject({
      state: "unknown",
    });
    expect(calls).toBe(2);
    resetCodexAppServerCatalogStateCache();
  });

  test("unrelated processes never enter the comparison", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [
        { pid: 7, commandLine: "node worker.js codex app-server" },
        { pid: 8, commandLine: "/usr/bin/hermes-codex-bridge-mcp" },
      ],
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("not_running");
  });

  // The extraction that made the sentinel testable also silently dropped `owner` on
  // its first pass, and nothing failed — the field feeds ownership decisions elsewhere,
  // not the two states these tests assert. Pin the whole parsed row so a refactor of the
  // parse loop cannot quietly lose a field again.
  test("parsed rows keep every field the enumeration reports", () => {
    const rows = parseWindowsSnapshotOutput([
      "4321\tC:\\Program Files\\codex\\codex.exe app-server\tCONTOSO\\jun",
      "",
      "1\tinit\tCONTOSO\\jun",
      "9999\tcodex app-server\t",
    ].join("\r\n"));
    expect(rows).toEqual([
      { pid: 4321, commandLine: "C:\\Program Files\\codex\\codex.exe app-server", owner: "CONTOSO\\jun" },
    ]);
  });

  test("enumeration failure reports unknown, never not_running", () => {
    // On macOS the win32 enumeration path has no powershell.exe → it throws,
    // which must surface as unknown rather than "nothing is running".
    const status = collectCodexAppServerCatalogState({
      platform: process.platform === "win32" ? "linux" : "win32",
      catalogMtimeMs: () => 1_000,
    });
    if (process.platform === "win32") {
      // linux /proc is absent on Windows → same unknown outcome
      expect(status.state).toBe("unknown");
    } else {
      expect(status.state).toBe("unknown");
    }
  });

  test("equal start time and catalog mtime is conservatively stale", () => {
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => [{ pid: 42, commandLine: APP_SERVER_CMD }],
      readStartMs: () => 1_000,
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("stale");
  });
});

describe("Codex app-server process matching (#476)", () => {
  test("matches Codex app-server and code-mode-host command lines", () => {
    expect(isCodexAppServerCommandLine("codex app-server --listen unix:///tmp/codex.sock")).toBe(true);
    expect(isCodexAppServerCommandLine("/usr/local/bin/codex app-server proxy")).toBe(true);
    expect(isCodexAppServerCommandLine("C:\\Users\\a\\AppData\\codex.exe app-server --listen pipe")).toBe(true);
    expect(isCodexAppServerCommandLine("\"C:\\Program Files\\nodejs\\codex.exe\" app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("\"C:\\Program Files\\nodejs\\codex.cmd\" app-server --listen pipe")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --verbose app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex-code-mode-host --session 1")).toBe(true);
    expect(isCodexAppServerCommandLine("node /opt/codex-code-mode-host --session 1")).toBe(true);
  });

  test("matches official platform-baked Codex target-triple basenames", () => {
    expect(isCodexAppServerCommandLine(
      "/opt/codex/codex-x86_64-unknown-linux-musl app-server --listen unix:///tmp/c.sock",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "/Applications/Codex.app/Contents/Resources/codex-aarch64-apple-darwin app-server",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "C:\\Users\\a\\.codex\\bin\\codex-x86_64-pc-windows-msvc.exe app-server --listen pipe",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "\"C:\\Program Files\\Codex\\codex-aarch64-pc-windows-msvc.exe\" app-server",
    )).toBe(true);
    expect(isCodexAppServerCommandLine(
      "codex-x86_64-apple-darwin --profile prod app-server",
    )).toBe(true);
  });

  test("matches app-server after value-taking Codex global options", () => {
    expect(isCodexAppServerCommandLine("codex --enable js_repl app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --enable=js_repl app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --disable multi_agent_v2 app-server --listen unix://x")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --config model=gpt-5.4 app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -c model=gpt-5.4 app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --profile production app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -p production app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex -a never app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --ask-for-approval on-request app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --oss --local-provider ollama app-server")).toBe(true);
    expect(isCodexAppServerCommandLine("codex --add-dir /tmp app-server")).toBe(true);
    expect(isCodexAppServerCommandLine(
      "codex --enable js_repl --profile prod -c model=gpt-5.4 app-server --listen stdio://",
    )).toBe(true);
  });

  test("rejects unrelated processes and app-server / code-mode-host only in later arguments", () => {
    expect(isCodexAppServerCommandLine("hermes-codex-bridge-mcp --port 9")).toBe(false);
    expect(isCodexAppServerCommandLine("hermes-codex-x86_64-unknown-linux-gnu app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("node ./opencodex/src/cli/index.ts start")).toBe(false);
    expect(isCodexAppServerCommandLine("opencodex app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("/usr/bin/opencodex app-server")).toBe(false);
    // Broad codex-* tools without a Rust target-triple shape must stay unmatched.
    expect(isCodexAppServerCommandLine("codex-bridge app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("codex-helper-tool app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec 'hello'")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec \"debug app-server behavior\"")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec debug app-server behavior")).toBe(false);
    expect(isCodexAppServerCommandLine("codex exec app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("something-app-server-without-codex-bin")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex-code-mode-host")).toBe(false);
    expect(isCodexAppServerCommandLine("bash -c codex-code-mode-host")).toBe(false);
  });

  test("Windows candidate pre-filter matches quoted Install-path executables", () => {
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\nodejs\\codex.exe\" app-server",
    )).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\nodejs\\codex.cmd\" app-server --listen pipe",
    )).toBe(true);
    // Closing quote immediately after the executable basename.
    expect(isWindowsCodexCandidateCommandLine("codex.exe\" app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine("codex.cmd' app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine("codex app-server")).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "\"C:\\Program Files\\Codex\\codex-x86_64-pc-windows-msvc.exe\" app-server",
    )).toBe(true);
    expect(isWindowsCodexCandidateCommandLine(
      "C:\\Users\\a\\.codex\\bin\\codex-aarch64-pc-windows-msvc.exe app-server",
    )).toBe(true);
    // Stay narrow: incidental "opencodex" paths must not pay GetOwner.
    expect(isWindowsCodexCandidateCommandLine(
      "node C:\\Users\\a\\opencodex\\src\\cli\\index.ts start",
    )).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("opencodex app-server")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("hermes-codex-bridge-mcp")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("hermes-codex-x86_64-pc-windows-msvc.exe")).toBe(false);
    expect(isWindowsCodexCandidateCommandLine("codex-bridge app-server")).toBe(false);
  });

  test("listCodexAppServerProcesses filters injected snapshots", () => {
    const matched = listCodexAppServerProcesses({
      listSnapshots: () => [
        { pid: 11, commandLine: "hermes-codex-bridge-mcp" },
        { pid: 22, commandLine: "codex app-server --listen unix://x" },
        { pid: 22, commandLine: "codex app-server --listen unix://x" },
        { pid: 33, commandLine: "codex-code-mode-host" },
        { pid: 44, commandLine: "codex exec hi" },
        { pid: 55, commandLine: "codex exec \"debug app-server behavior\"" },
        { pid: 66, commandLine: "node worker.js codex-code-mode-host" },
      ],
    });
    expect(matched.map(process => process.pid)).toEqual([22, 33]);
  });

  test("restartCodexAppServers signals all first, shared wait deadline, no SIGKILL", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const waits: number[] = [];
    const alive = new Set([100, 200]);
    const snapshots = [
      { pid: 100, commandLine: "codex app-server" },
      { pid: 200, commandLine: "codex-code-mode-host" },
    ];
    let now = 1_000;
    const result = restartCodexAppServers(
      snapshots,
      {
        listSnapshots: () => snapshots,
        kill: (pid, signal) => {
          signals.push({ pid, signal });
          if (pid === 100) alive.delete(100);
        },
        isAlive: pid => alive.has(pid),
        waitExit: (pid, timeoutMs) => {
          waits.push(timeoutMs);
          now += 500;
          return !alive.has(pid);
        },
        now: () => now,
      },
    );
    expect(signals).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
    ]);
    // Shared deadline: second wait gets the remaining budget, not another full 2s.
    expect(waits).toEqual([2_000, 1_500]);
    expect(result.stopped).toEqual([100]);
    expect(result.surviving).toEqual([200]);
    expect(result.failed).toEqual([]);
  });

  test("restartCodexAppServers treats kill-throw on already-dead pid as stopped", () => {
    const result = restartCodexAppServers(
      [{ pid: 9, commandLine: "codex app-server" }],
      {
        listSnapshots: () => [{ pid: 9, commandLine: "codex app-server" }],
        kill: () => {
          throw new Error("ESRCH");
        },
        isAlive: () => false,
        waitExit: () => true,
      },
    );
    expect(result.stopped).toEqual([9]);
    expect(result.failed).toEqual([]);
    expect(result.surviving).toEqual([]);
  });

  test("restartCodexAppServers skips PIDs whose identity changed before signal", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = restartCodexAppServers(
      [{ pid: 42, commandLine: "codex app-server" }],
      {
        listSnapshots: () => [{ pid: 42, commandLine: "vim README.md" }],
        kill: (pid, signal) => {
          signals.push({ pid, signal });
        },
        isAlive: () => true,
        waitExit: () => false,
      },
    );
    expect(signals).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.surviving).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("restartCodexAppServers skips recycled PID that matches a different Codex process", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = restartCodexAppServers(
      [{ pid: 42, commandLine: "codex app-server --listen unix://old" }],
      {
        // Same PID, still Codex-shaped, but a different process identity.
        listSnapshots: () => [{ pid: 42, commandLine: "codex-code-mode-host --session 9" }],
        kill: (pid, signal) => {
          signals.push({ pid, signal });
        },
        isAlive: () => true,
        waitExit: () => false,
      },
    );
    expect(signals).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.surviving).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("afterCatalogWriteHandleAppServers warns by default and restarts when requested", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const snapshots = [{ pid: 7, commandLine: "codex app-server --listen unix://x" }];
    const io = {
      listSnapshots: () => snapshots,
      kill: () => {},
      isAlive: () => false,
      waitExit: () => true,
    };

    const warned = afterCatalogWriteHandleAppServers({
      restart: false,
      log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
      io,
    });
    expect(warned.warned).toBe(true);
    expect(errors[0]).toContain(formatStaleCodexAppServerWarning(warned.processes));
    expect(errors[0]).toContain("ocx sync --restart-codex");

    const restarted = afterCatalogWriteHandleAppServers({
      restart: true,
      log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
      io,
    });
    expect(restarted.warned).toBe(false);
    expect(restarted.restart?.stopped).toEqual([7]);
    expect(logs.some(line => line.includes("Stopping Codex app-server"))).toBe(true);
  });
});

describe("CLI /api sync wiring for stale app-servers (#476)", () => {
  const dispatchSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "dispatch.ts"), "utf8");
  const configRoutesSource = readFileSync(
    join(import.meta.dir, "..", "src", "server", "management", "config-routes.ts"),
    "utf8",
  );

  test("ocx sync only handles app-servers after a catalog/cache write and forwards --restart-codex", () => {
    const syncCase = dispatchSource.slice(dispatchSource.indexOf("sync: async"), dispatchSource.indexOf("v2: async"));
    expect(syncCase).toContain('includes("--restart-codex")');
    expect(syncCase).toContain("synced.catalogWritten || synced.cacheSynced");
    expect(syncCase).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCase).toContain("restart: restartCodex");
    expect(syncCase.indexOf("catalogWritten || synced.cacheSynced"))
      .toBeLessThan(syncCase.indexOf("afterCatalogWriteHandleAppServers"));
    // No-write path must not call the handler outside the gate.
    const gatedBlock = syncCase.slice(syncCase.indexOf("if (synced.catalogWritten"));
    expect(gatedBlock).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCase.replace(gatedBlock, "")).not.toContain("afterCatalogWriteHandleAppServers");
  });

  test("--restart-desktop-app is a separate opt-in that --restart-codex never implies (#2292)", () => {
    for (const [name, endMarker] of [["sync: async", "v2: async"], ['"sync-cache": async', "gui: async"]] as const) {
      const handler = dispatchSource.slice(dispatchSource.indexOf(name), dispatchSource.indexOf(endMarker));
      // Two independent flag reads. If the desktop restart were derived from
      // restartCodex, quitting the user's app would ride along on a flag whose
      // documented contract is app-server-only.
      expect(handler).toContain('includes("--restart-desktop-app")');
      expect(handler).toContain("if (restartDesktopApp) await handleDesktopAppRestart(console)");
      expect(handler).not.toContain("restartDesktopApp = restartCodex");
      // Gated behind the same real-write condition as the app-server handling.
      const desktopAt = handler.indexOf("restartDesktopApp) await handleDesktopAppRestart");
      expect(handler.indexOf("afterCatalogWriteHandleAppServers")).toBeLessThan(desktopAt);
    }
  });

  test("ocx sync-cache only handles app-servers after a successful models_cache write", () => {
    const syncCacheCase = dispatchSource.slice(
      dispatchSource.indexOf('"sync-cache": async'),
      dispatchSource.indexOf("gui: async"),
    );
    // The cache write now happens under the catalog serialization lock K, so the
    // gate reads the permitted writer's outcome instead of a bare boolean call.
    // The property under test is unchanged: app-servers are touched only after a
    // write actually landed, never on a refused/failed serialization attempt.
    expect(syncCacheCase).toContain("withCatalogWriteSerialization");
    // #1931: explicit sync-cache refreshes even when injection is OFF (side profiles).
    expect(syncCacheCase).toContain("invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, { allowWhenDesiredDisabled: true })");
    const gate = 'if (invalidated.kind === "completed" && invalidated.value)';
    expect(syncCacheCase).toContain(gate);
    expect(syncCacheCase).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCacheCase.indexOf(gate))
      .toBeLessThan(syncCacheCase.indexOf("afterCatalogWriteHandleAppServers"));
    const gatedBlock = syncCacheCase.slice(syncCacheCase.indexOf(gate));
    expect(gatedBlock).toContain("afterCatalogWriteHandleAppServers");
    expect(syncCacheCase.replace(gatedBlock, "")).not.toContain("afterCatalogWriteHandleAppServers");
  });

  test("POST /api/sync attaches staleAppServerHint only after a write and never enumerates processes", () => {
    const syncHandler = configRoutesSource.slice(
      configRoutesSource.indexOf('url.pathname === "/api/sync"'),
      configRoutesSource.indexOf('url.pathname === "/api/update/check"'),
    );
    expect(syncHandler).toContain("attachStaleAppServerHint(result)");
    expect(syncHandler).not.toContain("listCodexAppServerProcesses");
    expect(syncHandler).not.toContain("afterCatalogWriteHandleAppServers");
    expect(STALE_CODEX_APP_SERVER_HINT).toContain("ocx sync --restart-codex");
  });

  test("no-write sync responses omit staleAppServerHint", () => {
    const omitted = attachStaleAppServerHint({
      ok: true,
      catalogWritten: false,
      cacheSynced: false,
      message: "noop",
    });
    expect(omitted).toEqual({
      ok: true,
      catalogWritten: false,
      cacheSynced: false,
      message: "noop",
    });
    expect("staleAppServerHint" in omitted).toBe(false);
  });

  test("successful catalog or cache writes include the shared staleAppServerHint", () => {
    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: true,
      cacheSynced: false,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);

    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: false,
      cacheSynced: true,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);

    expect(attachStaleAppServerHint({
      ok: true,
      catalogWritten: true,
      cacheSynced: true,
    }).staleAppServerHint).toBe(STALE_CODEX_APP_SERVER_HINT);
  });
});

describe("process utility invocation source guards", () => {
  const processSource = readFileSync(
    join(import.meta.dir, "..", "src", "codex", "app-server-processes.ts"),
    "utf8",
  );

  test("pins every Darwin ps invocation to the system binary", () => {
    expect(processSource.match(/execFileSync\(\s*["']\/bin\/ps["']/g) ?? []).toHaveLength(6);
    expect(processSource).not.toMatch(/execFileSync\(\s*["']ps["']/);
  });
});

describe("Windows Win32_Process owner enumeration (#476)", () => {
  const processSource = readFileSync(
    join(import.meta.dir, "..", "src", "codex", "app-server-processes.ts"),
    "utf8",
  );

  test("PowerShell uses Invoke-CimMethod GetOwner and fails closed on ReturnValue", () => {
    expect(processSource).toContain(
      "Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop",
    );
    expect(processSource).toContain("$o.ReturnValue -ne 0");
    expect(processSource).toContain(".join(\"\\n\")");
    expect(processSource).not.toMatch(/\$o=\$_\.GetOwner\(\)/);
    // Shared candidate regex (optional closing quote after basename) drives -match.
    expect(processSource).toContain("WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source");
    expect(processSource).toContain("powerShellSingleQuotedIgnoreCaseMatch");
    expect(WINDOWS_CODEX_BASENAME_CANDIDATE_RE.source).toContain("['\"]?");
  });

  // The top-level Get-CimInstance sits under `$ErrorActionPreference='SilentlyContinue'`.
  // If it fails without `-ErrorAction Stop` and an outer catch, it emits nothing at all —
  // which is byte-identical to a healthy machine running no Codex process. The existing
  // coverage drives a *throwing* enumerator (by swapping `platform` so the real one fails
  // on a missing binary); the path below is the one that returns cleanly empty, and it is
  // the one that used to launder "we could not look" into "nothing is running".
  test("a top-level CIM failure emits the sentinel, so an empty read is never not_running", () => {
    const psCommand = { value: "" };
    expect(() => listWindowsSnapshots((command) => {
      psCommand.value = command;
      // What PowerShell actually prints when the outer catch fires.
      return "__OCX_ENUM_INCOMPLETE__\n";
    })).toThrow("windows_enum_incomplete");

    // The guard has to be on the top-level query itself, not only per-process.
    expect(psCommand.value).toContain("Get-CimInstance Win32_Process -ErrorAction Stop");
    expect(psCommand.value).toContain("} catch { \"__OCX_ENUM_INCOMPLETE__\" }");

    // And the collector must turn that throw into unknown, never not_running.
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => listWindowsSnapshots(() => "__OCX_ENUM_INCOMPLETE__\n"),
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("unknown");
  });

  test("a clean empty read still means not_running", () => {
    // The other half of the contract: no sentinel, no rows, nothing wrong — the
    // sentinel must not make every quiet machine look unreadable.
    expect(listWindowsSnapshots(() => "")).toEqual([]);
    expect(parseWindowsSnapshotOutput("")).toEqual([]);
    const status = collectCodexAppServerCatalogState({
      listSnapshots: () => listWindowsSnapshots(() => ""),
      catalogMtimeMs: () => 1_000,
    });
    expect(status.state).toBe("not_running");
  });

  test.skipIf(process.platform !== "win32")(
    "listWindowsSnapshots returns a current-user Codex-shaped process via real PowerShell enumeration",
    () => {
      // Keep a live process whose CommandLine contains a Codex basename token.
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile", "-NoLogo", "-NonInteractive",
          "-Command",
          "Start-Sleep -Seconds 45 # codex app-server integration-probe",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      try {
        expect(child.pid).toBeGreaterThan(1);
        // Brief settle so Win32_Process can observe the child. A loaded Windows
        // runner can also exhaust one CIM enumeration deadline, so tolerate one
        // transient empty result OR one thrown deadline (ETIMEDOUT propagates by
        // design) while keeping the production timeout unchanged.
        Bun.sleepSync(250);
        const enumerate = (): ReturnType<typeof listWindowsSnapshots> | undefined => {
          try {
            return listWindowsSnapshots();
          } catch {
            return undefined; // transient CIM deadline on a contended runner
          }
        };
        let snapshots = enumerate() ?? [];
        let match = snapshots.find(snapshot => snapshot.pid === child.pid);
        if (!match) {
          Bun.sleepSync(250);
          snapshots = enumerate() ?? [];
          match = snapshots.find(snapshot => snapshot.pid === child.pid);
        }
        if (!match) {
          Bun.sleepSync(1_000);
          snapshots = enumerate() ?? [];
          match = snapshots.find(snapshot => snapshot.pid === child.pid);
        }
        expect(match).toBeDefined();
        expect(match!.owner).toMatch(/\\/);
        expect(match!.commandLine.toLowerCase()).toContain("codex app-server");
        expect(snapshots.every(snapshot => (snapshot.owner?.trim().length ?? 0) > 0)).toBe(true);
      } finally {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
      }
    },
    { timeout: 35_000 },
  );
});

/*
 * #1046. Service startup rewrites the catalog and the models cache while an
 * app-server that booted earlier keeps its own in-memory model list, so the
 * picker shows a roster that no longer exists on disk. The startup path warns;
 * it must never signal, because a boot is not a user consenting to have an
 * in-flight turn interrupted.
 */
describe("warnIfStaleCodexAppServersAfterStartupWrite (#1046)", () => {
  const APP_SERVER_CMD = "/usr/local/bin/codex app-server";
  const collectErrors = () => {
    const errors: string[] = [];
    return { log: { error: (m?: unknown) => { errors.push(String(m)); } }, errors };
  };

  test("warns when an app-server predates the catalog write", () => {
    const { log, errors } = collectErrors();
    const result = warnIfStaleCodexAppServersAfterStartupWrite({
      log,
      io: {
        listSnapshots: () => [{ pid: 4242, commandLine: APP_SERVER_CMD }],
        readStartMs: () => 1_000,
        catalogMtimeMs: () => 2_000,
      },
    });
    expect(result.warned).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("4242");
  });

  test("stays quiet for fresh, not_running, and unknown", () => {
    const fresh = collectErrors();
    expect(warnIfStaleCodexAppServersAfterStartupWrite({
      log: fresh.log,
      io: {
        listSnapshots: () => [{ pid: 1, commandLine: APP_SERVER_CMD }],
        readStartMs: () => 3_000,
        catalogMtimeMs: () => 1_000,
      },
    }).warned).toBe(false);

    const none = collectErrors();
    expect(warnIfStaleCodexAppServersAfterStartupWrite({
      log: none.log,
      io: { listSnapshots: () => [], catalogMtimeMs: () => 1_000 },
    }).warned).toBe(false);

    const unknown = collectErrors();
    expect(warnIfStaleCodexAppServersAfterStartupWrite({
      log: unknown.log,
      io: {
        listSnapshots: () => [{ pid: 2, commandLine: APP_SERVER_CMD }],
        readStartMs: () => null,
        catalogMtimeMs: () => 1_000,
      },
    }).warned).toBe(false);

    expect([...fresh.errors, ...none.errors, ...unknown.errors]).toEqual([]);
  });

  /*
   * The masking risk this layer has to defend against, stated honestly.
   *
   * `collectCodexAppServerCatalogState` memoizes for 5s, but ONLY when every io
   * field is defaulted (`fullyDefault`). That has two consequences:
   *
   * - Production startup runs on the default path, so a `fresh` reading taken
   *   before the catalog write CAN be replayed after it, and the helper drops the
   *   memo first for exactly that reason.
   * - Any test that injects io bypasses the cache, so it cannot reproduce the
   *   masking and would pass with or without the reset. Writing one anyway would
   *   be a test that looks like proof and is not.
   *
   * So this asserts the mechanism the fix depends on — that a defaulted read is
   * memoized and an explicit invalidation clears it — rather than pretending to
   * exercise a path the seam makes unreachable. The helper's own call to the
   * invalidation is verified by reading it, not by a test that cannot fail.
   */
  test("a defaulted read is memoized, and invalidation is what clears it", () => {
    resetCodexAppServerCatalogStateCache();
    const first = collectCodexAppServerCatalogState();
    const second = collectCodexAppServerCatalogState();
    // Same object identity: the second call served the memo rather than recomputing.
    expect(second).toBe(first);

    resetCodexAppServerCatalogStateCache();
    expect(collectCodexAppServerCatalogState()).not.toBe(first);
  });

  /*
   * An `unknown` reading is a failure to observe, not an observation. Serving it for
   * the full window means one transient enumeration failure suppresses guidance for
   * every call in that window and the retry that would have succeeded never runs.
   *
   * Scope: this asserts the POLICY the cache gate consults. The gate itself only
   * engages on a fully-defaulted call — injecting `now` would make the call
   * non-default and bypass the memo entirely — so there is no seam to drive a clock
   * through, and no test here proves the gate reads this function. That is why it is
   * one function rather than an inline ternary.
   */
  test("an unknown reading is cached far more briefly than a real one", () => {
    expect(catalogStateTtlMs("unknown")).toBeLessThan(catalogStateTtlMs("fresh"));
    expect(catalogStateTtlMs("unknown")).toBeLessThan(catalogStateTtlMs("not_running"));
    expect(catalogStateTtlMs("fresh")).toBe(catalogStateTtlMs("stale"));
    expect(catalogStateTtlMs("unknown")).toBeGreaterThan(0);
  });

  /*
   * The assertion that would catch a future refactor pointing startup at
   * `afterCatalogWriteHandleAppServers({ restart: true })`, which SIGTERMs matching
   * processes and says so in its own log line.
   */
  test("never signals a process", () => {
    const killed: number[] = [];
    warnIfStaleCodexAppServersAfterStartupWrite({
      io: {
        listSnapshots: () => [{ pid: 999, commandLine: APP_SERVER_CMD }],
        readStartMs: () => 1_000,
        catalogMtimeMs: () => 2_000,
        kill: pid => { killed.push(pid); },
      },
    });
    expect(killed).toEqual([]);
  });

  test("a discovery failure is swallowed so startup still comes up", () => {
    const { log, errors } = collectErrors();
    expect(warnIfStaleCodexAppServersAfterStartupWrite({
      log,
      io: { listSnapshots: () => { throw new Error("ps unavailable"); } },
    }).warned).toBe(false);
    expect(errors).toEqual([]);
  });
});

describe("platform termination ladder", () => {
  const target = { pid: 4242, commandLine: "/opt/codex app-server" };
  const snapshots = () => [{ pid: 4242, commandLine: "/opt/codex app-server" }];

  // The Windows branch is driven by an injected platform, so the resolver cannot
  // assert a real System32 path on this host. Override it exactly as the
  // elevation suite does rather than loosening the production resolver.
  beforeEach(() => {
    setTrustedWindowsElevationExecutablesForTests({
      taskkill: "C:\\Windows\\System32\\taskkill.exe",
    });
  });
  afterEach(() => setTrustedWindowsElevationExecutablesForTests(null));

  test("Windows uses taskkill /T /F and never falls through to a signal", () => {
    // process.kill(SIGTERM) on Windows is already an unconditional terminate of
    // one process; /T adds the child cleanup it lacks.
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const signals: number[] = [];
    restartCodexAppServers([target], {
      platform: "win32",
      listSnapshots: snapshots,
      execFile: (file, args) => { execCalls.push({ file, args }); },
      processKill: pid => { signals.push(pid); },
      isAlive: () => false,
      waitExit: () => true,
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.args).toEqual(["/PID", "4242", "/T", "/F"]);
    expect(execCalls[0]!.file.toLowerCase()).toContain("taskkill");
    expect(signals).toEqual([]);
  });

  test("a failing taskkill falls back to the previous behavior", () => {
    // The branch that keeps a Windows regression from being worse than the code
    // it replaced.
    const signals: Array<{ pid: number; signal: string }> = [];
    restartCodexAppServers([target], {
      platform: "win32",
      listSnapshots: snapshots,
      execFile: () => { throw new Error("taskkill unavailable"); },
      processKill: (pid, signal) => { signals.push({ pid, signal }); },
      isAlive: () => false,
      waitExit: () => true,
    });

    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  test("Linux keeps SIGTERM only, with no exec and no SIGKILL", () => {
    // procfs enumeration is the Linux path; termination must stay unchanged
    // there, because a second harder signal asks a consent a click did not give.
    const execCalls: string[] = [];
    const signals: Array<{ pid: number; signal: string }> = [];
    restartCodexAppServers([target], {
      platform: "linux",
      listSnapshots: snapshots,
      execFile: file => { execCalls.push(file); },
      processKill: (pid, signal) => { signals.push({ pid, signal }); },
      isAlive: () => false,
      waitExit: () => true,
    });

    expect(execCalls).toEqual([]);
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(signals.some(entry => entry.signal === "SIGKILL")).toBe(false);
  });

  test("macOS behaves like Linux", () => {
    const execCalls: string[] = [];
    const signals: Array<{ pid: number; signal: string }> = [];
    restartCodexAppServers([target], {
      platform: "darwin",
      listSnapshots: snapshots,
      execFile: file => { execCalls.push(file); },
      processKill: (pid, signal) => { signals.push({ pid, signal }); },
      isAlive: () => false,
      waitExit: () => true,
    });

    expect(execCalls).toEqual([]);
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });
});

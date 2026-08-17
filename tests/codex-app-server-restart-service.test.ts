/**
 * Dashboard-driven Codex app-server restart service (#1046 follow-up).
 *
 * Every branch is driven through CodexRestartServiceIo rather than module mocks:
 * an untestable version of this code would terminate the developer's own Codex
 * app-servers when the suite runs.
 *
 * Plan: devlog/_fin/260815_gui_codex_restart/010_phase1_backend_endpoint.md
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  performCodexRestart,
  readCodexAppServerState,
  resetCodexRestartInFlightForTests,
} from "../src/codex/app-server-restart-service";
import type { CodexRestartServiceIo } from "../src/codex/app-server-restart-service";
import type { CodexAppServerProcess } from "../src/codex/app-server-processes";
import { isCodexRestartResponse } from "../src/lib/codex-restart-contract";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

function proc(pid: number, commandLine = `/opt/codex app-server --pid ${pid}`): CodexAppServerProcess {
  return { pid, commandLine };
}

/** Base io: nothing real runs. Each test overrides only what it drives. */
function baseIo(overrides: CodexRestartServiceIo = {}): CodexRestartServiceIo {
  return {
    syncCatalog: async () => true,
    listenPort: () => 41999,
    resetStateCache: () => {},
    collectState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
    listProcesses: () => [],
    processIo: { isAlive: () => false },
    restart: () => ({ requested: [], stopped: [], surviving: [], failed: [] }),
    readStartMs: pids => new Map(pids.map(pid => [pid, 1])),
    ...overrides,
  };
}

beforeEach(() => {
  resetCodexRestartInFlightForTests();
});

describe("performCodexRestart", () => {
  test("stops every stale app-server and reports code=stopped", async () => {
    const signalled: number[] = [];
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }, { pid: 200, startedAtMs: 2 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100), proc(200)],
      readStartMs: () => new Map([[100, 1], [200, 2]]),
      restart: targets => {
        for (const target of targets) signalled.push(target.pid);
        return { requested: [100, 200], stopped: [100, 200], surviving: [], failed: [] };
      },
    }));

    expect(signalled).toEqual([100, 200]);
    expect(result.code).toBe("stopped");
    expect(result.success).toBe(true);
    expect(result.stopped).toEqual([100, 200]);
    expect(result.stateBefore).toBe("stale");
  });

  test("reports nothing_running without signalling when no app-server is up", async () => {
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      restart: () => {
        restarted = true;
        return { requested: [], stopped: [], surviving: [], failed: [] };
      },
    }));

    expect(result.code).toBe("nothing_running");
    expect(result.success).toBe(true);
    expect(restarted).toBe(false);
  });

  test("an unknown classifier reading signals NOTHING", async () => {
    // The branch that matters most: enumeration failure must never be read as
    // "nothing was running", and must never cause a blind kill (#857).
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({ state: "unknown", processes: [], catalogMtimeMs: null }),
      restart: () => {
        restarted = true;
        return { requested: [], stopped: [], surviving: [], failed: [] };
      },
    }));

    expect(result.code).toBe("enumeration_unavailable");
    expect(result.stateBefore).toBe("unknown");
    expect(restarted).toBe(false);
    expect(result.requested).toEqual([]);
  });

  test("a fresh classifier reading signals nothing", async () => {
    let listed = false;
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "fresh",
        processes: [{ pid: 100, startedAtMs: 20 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => {
        listed = true;
        return [proc(100)];
      },
      restart: () => {
        restarted = true;
        return { requested: [100], stopped: [100], surviving: [], failed: [] };
      },
    }));

    expect(listed).toBe(false);
    expect(restarted).toBe(false);
    expect(result.code).toBe("nothing_running");
    expect(result.stateBefore).toBe("fresh");
    expect(result.requested).toEqual([]);
  });

  test("a mixed reading signals only stale app-servers, including the equality boundary", async () => {
    let received: CodexAppServerProcess[] = [];
    await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [
          { pid: 100, startedAtMs: 5 },
          { pid: 200, startedAtMs: 20 },
          { pid: 300, startedAtMs: 10 },
        ],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100), proc(200), proc(300)],
      readStartMs: () => new Map([[100, 5], [200, 20], [300, 10]]),
      restart: targets => {
        received = [...targets];
        return { requested: [100, 300], stopped: [100, 300], surviving: [], failed: [] };
      },
    }));

    expect(received.map(entry => entry.pid)).toEqual([100, 300]);
  });

  test("a survivor makes the result partially_stopped and unsuccessful", async () => {
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }, { pid: 200, startedAtMs: 2 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100), proc(200)],
      readStartMs: () => new Map([[100, 1], [200, 2]]),
      restart: () => ({ requested: [100, 200], stopped: [100], surviving: [200], failed: [] }),
    }));

    expect(result.code).toBe("partially_stopped");
    expect(result.success).toBe(false);
    expect(result.surviving).toEqual([200]);
  });

  test("a helper stop stays unsettled while the pid is still alive", async () => {
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 1]]),
      processIo: { isAlive: () => true },
      restart: () => ({ requested: [100], stopped: [100], surviving: [], failed: [] }),
    }));

    expect(result).toMatchObject({
      success: false,
      code: "partially_stopped",
      requested: [100],
      stopped: [],
      surviving: [100],
      failed: [],
    });
  });

  test("a target that exits between classification and signalling is not credited", async () => {
    // Race: the classifier saw a stale server, but it exited on its own before we
    // re-listed. Claiming "stopped" here would take credit for work we did not do.
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [],
      restart: () => {
        restarted = true;
        return { requested: [], stopped: [], surviving: [], failed: [] };
      },
    }));

    expect(result.code).toBe("nothing_running");
    expect(result.success).toBe(true);
    expect(restarted).toBe(false);
  });

  test("a failed second enumeration keeps a live stale target unsettled", async () => {
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [],
      processIo: { isAlive: () => true },
      restart: () => {
        restarted = true;
        return { requested: [100], stopped: [100], surviving: [], failed: [] };
      },
    }));

    expect(restarted).toBe(false);
    expect(result).toMatchObject({
      success: false,
      stateBefore: "stale",
      code: "partially_stopped",
      requested: [100],
      stopped: [],
      surviving: [100],
      failed: [100],
    });
  });

  test("only classified pids are signalled, and they carry a real command line", async () => {
    // The identity bridge: the classifier returns { pid, startedAtMs } with no
    // command line, so the service must re-list to get one. A live app-server the
    // classifier did not flag must not be signalled.
    let received: CodexAppServerProcess[] = [];
    await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }, { pid: 200, startedAtMs: 2 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(200), proc(900)],
      readStartMs: () => new Map([[200, 2], [900, 7]]),
      restart: targets => {
        received = [...targets];
        return { requested: [200], stopped: [200], surviving: [], failed: [] };
      },
    }));

    expect(received.map(entry => entry.pid)).toEqual([200]);
    expect(received[0]?.commandLine).toContain("app-server");
  });

  test("the LIVE listen port reaches the catalog sync", async () => {
    // config.port names the preferred port; after a fallback start the bound port
    // differs, and syncing the preferred one points Codex at a dead listener.
    let syncedPort: number | undefined = -1;
    await performCodexRestart(baseIo({
      listenPort: () => 45123,
      syncCatalog: async port => {
        syncedPort = port;
        return true;
      },
    }));

    expect(syncedPort).toBe(45123);
  });

  test("a failed catalog sync still lets the restart proceed", async () => {
    const result = await performCodexRestart(baseIo({
      syncCatalog: async () => {
        throw new Error("catalog write failed");
      },
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 1]]),
      restart: () => ({ requested: [100], stopped: [100], surviving: [], failed: [] }),
    }));

    expect(result.synced).toBe(false);
    expect(result.code).toBe("stopped");
  });

  test("no command line or OS error text reaches the response body", async () => {
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100, "/opt/private-marker/codex app-server")],
      restart: () => ({
        requested: [100],
        stopped: [],
        surviving: [100],
        failed: [{ pid: 100, error: "EPERM: /opt/private-marker/Library/private" }],
      }),
    }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-marker");
    expect(serialized).not.toContain("EPERM");
    expect(serialized).not.toContain("app-server");
    expect(result.failed).toEqual([100]);
  });

  test("a pid recycled DURING signalling is refused at the last moment", async () => {
    // The window restartCodexAppServers cannot close by itself: it compares
    // pid+command-line immediately before SIGTERM, and a replacement app-server
    // from the same install has both. Here the start time changes between the
    // service's pre-check and the signal itself, which is exactly the recycled-pid
    // case, and the guard must refuse rather than kill the replacement.
    const signalled: number[] = [];
    let startReads = 0;
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1_000 }],
        catalogMtimeMs: 5_000,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: pids => {
        startReads += 1;
        // First read (the pre-check) still sees the classified process; by the
        // time the signalling loop re-reads, the pid belongs to a newer process.
        const startedAtMs = startReads === 1 ? 1_000 : 9_999;
        return new Map(pids.map(pid => [pid, startedAtMs] as const));
      },
      processIo: {
        kill: pid => {
          signalled.push(pid);
        },
        isAlive: () => true,
        waitExit: () => false,
        listSnapshots: () => [{ pid: 100, commandLine: "/opt/codex app-server --pid 100" }],
      },
    });

    // Nothing was signalled, and the refusal is reported rather than swallowed.
    expect(signalled).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.failed).toEqual([100]);
    expect(result.success).toBe(false);
    expect(result.code).toBe("partially_stopped");
    // The failure text never reaches the response body.
    expect(JSON.stringify(result)).not.toContain("identity changed");
  });

  test("every response satisfies the shared runtime guard", async () => {
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      restart: () => ({ requested: [100], stopped: [100], surviving: [], failed: [] }),
    }));

    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });
});

describe("readCodexAppServerState", () => {
  test("reports the classifier verdict and a running count", () => {
    const state = readCodexAppServerState({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 1, startedAtMs: 1 }, { pid: 2, startedAtMs: 2 }],
        catalogMtimeMs: 10,
      }),
    });

    expect(state).toEqual({ state: "stale", runningCount: 2 });
  });

  test("passes unknown through instead of guessing not_running", () => {
    const state = readCodexAppServerState({
      collectState: () => ({ state: "unknown", processes: [], catalogMtimeMs: null }),
    });

    expect(state).toEqual({ state: "unknown", runningCount: 0 });
  });
});

describe("identity and concurrency protection", () => {
  test("a recycled pid with an identical command line is NOT signalled", async () => {
    // The reviewer's reproduction: the classified process exits and a NEW Codex
    // app-server takes its pid. Same pid, same command line — pid+cmdline is not
    // an identity, so the start time has to settle it.
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 4242, startedAtMs: 1_000 }],
        catalogMtimeMs: 5_000,
      }),
      listProcesses: () => [proc(4242)],
      // Same pid, later start time: a different process wearing the same pid.
      readStartMs: () => new Map([[4242, 9_000]]),
      restart: () => {
        restarted = true;
        return { requested: [4242], stopped: [4242], surviving: [], failed: [] };
      },
    }));

    expect(restarted).toBe(false);
    expect(result).toMatchObject({
      success: false,
      code: "partially_stopped",
      requested: [4242],
      stopped: [],
      surviving: [4242],
      failed: [4242],
    });
  });

  test("a matching start time still lets the real target through", async () => {
    let received: number[] = [];
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 4242, startedAtMs: 1_000 }],
        catalogMtimeMs: 5_000,
      }),
      listProcesses: () => [proc(4242)],
      readStartMs: () => new Map([[4242, 1_000]]),
      restart: targets => {
        received = targets.map(entry => entry.pid);
        return { requested: [4242], stopped: [4242], surviving: [], failed: [] };
      },
    }));

    expect(received).toEqual([4242]);
    expect(result.code).toBe("stopped");
  });

  test("an unreadable start time refuses to signal rather than guessing", async () => {
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 4242, startedAtMs: 1_000 }],
        catalogMtimeMs: 5_000,
      }),
      listProcesses: () => [proc(4242)],
      readStartMs: () => new Map([[4242, null]]),
      restart: () => {
        restarted = true;
        return { requested: [], stopped: [], surviving: [], failed: [] };
      },
    }));

    expect(restarted).toBe(false);
    expect(result).toMatchObject({
      success: false,
      code: "partially_stopped",
      requested: [4242],
      stopped: [],
      surviving: [4242],
      failed: [4242],
    });
  });

  test("an invalid start in a stale classifier result remains unresolved", async () => {
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 4242, startedAtMs: null }],
        catalogMtimeMs: 5_000,
      }),
      listProcesses: () => [proc(4242)],
      restart: () => {
        restarted = true;
        return { requested: [], stopped: [], surviving: [], failed: [] };
      },
    }));

    expect(restarted).toBe(false);
    expect(result).toMatchObject({
      success: false,
      code: "partially_stopped",
      requested: [4242],
      stopped: [],
      surviving: [4242],
      failed: [4242],
    });
  });

  test("unknown WITH known processes signals nothing", async () => {
    // The classifier returns unknown-with-processes when the catalog mtime or a
    // start time is unreadable. It has not established that anything is stale, so
    // signalling would kill a possibly-current app-server on a guess.
    let restarted = false;
    const result = await performCodexRestart(baseIo({
      collectState: () => ({
        state: "unknown",
        processes: [{ pid: 100, startedAtMs: 1 }, { pid: 200, startedAtMs: null }],
        catalogMtimeMs: null,
      }),
      listProcesses: () => [proc(100), proc(200)],
      readStartMs: () => new Map([[100, 1], [200, 2]]),
      restart: () => {
        restarted = true;
        return { requested: [100, 200], stopped: [100, 200], surviving: [], failed: [] };
      },
    }));

    expect(restarted).toBe(false);
    expect(result.code).toBe("enumeration_unavailable");
    expect(result.stateBefore).toBe("unknown");
  });

  test("overlapping requests share one restart instead of signalling twice", async () => {
    let restartCalls = 0;
    let releaseSync: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseSync = resolve; });
    const io = baseIo({
      syncCatalog: async () => {
        await gate;
        return true;
      },
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 1]]),
      restart: () => {
        restartCalls += 1;
        return { requested: [100], stopped: [100], surviving: [], failed: [] };
      },
    });

    const first = performCodexRestart(io);
    const second = performCodexRestart(io);
    releaseSync!();
    const [a, b] = await Promise.all([first, second]);

    expect(restartCalls).toBe(1);
    expect(a).toBe(b);
    expect(a.code).toBe("stopped");
  });

  test("the latch clears so a later request runs again", async () => {
    let restartCalls = 0;
    const io = baseIo({
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 1]]),
      restart: () => {
        restartCalls += 1;
        return { requested: [100], stopped: [100], surviving: [], failed: [] };
      },
    });

    await performCodexRestart(io);
    await performCodexRestart(io);

    expect(restartCalls).toBe(2);
  });
});

describe("last-moment identity gate (through the real restart helper)", () => {
  // These cases deliberately do NOT stub `restart`. The window being closed lives
  // inside restartCodexAppServers' own signalling loop, so a test that stubs the
  // helper proves nothing about it.
  const stale = () => ({
    state: "stale" as const,
    processes: [{ pid: 4242, startedAtMs: 1_000 }],
    catalogMtimeMs: 5_000,
  });

  test("a pid recycled between the service check and the signal is NOT killed", async () => {
    const killed: number[] = [];
    let startReads = 0;
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: stale,
      listProcesses: () => [proc(4242)],
      // First read (service-level filter) matches the classified start time; the
      // second read happens inside the helper's signalling loop, by which point a
      // replacement process holds the pid.
      readStartMs: pids => {
        startReads += 1;
        return new Map(pids.map(pid => [pid, startReads === 1 ? 1_000 : 9_000]));
      },
      processIo: {
        listSnapshots: () => [{ pid: 4242, commandLine: "/opt/codex app-server --pid 4242" }],
        kill: pid => { killed.push(pid); },
        isAlive: () => true,
        waitExit: () => false,
      },
    });

    expect(killed).toEqual([]);
    expect(result.stopped).toEqual([]);
    // Nothing was signalled and the caller is told so, rather than being handed a
    // false "stopped".
    expect(result.success).toBe(false);
    expect(result.code).toBe("partially_stopped");
    expect(result.failed).toEqual([4242]);
  });

  test("a stable pid is signalled through the same path", async () => {
    const killed: number[] = [];
    const startReadTimeouts: Array<number | undefined> = [];
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: stale,
      listProcesses: () => [proc(4242)],
      readStartMs: (pids, timeoutMs) => {
        startReadTimeouts.push(timeoutMs);
        return new Map(pids.map(pid => [pid, 1_000]));
      },
      processIo: {
        listSnapshots: () => [{ pid: 4242, commandLine: "/opt/codex app-server --pid 4242" }],
        kill: pid => { killed.push(pid); },
        isAlive: () => false,
        waitExit: () => true,
      },
    });

    expect(killed).toEqual([4242]);
    expect(startReadTimeouts).toEqual([undefined, 1_500]);
    expect(result.code).toBe("stopped");
    expect(result.success).toBe(true);
  });

  test("a live target omitted by the helper's final re-list remains unsettled", async () => {
    const killed: number[] = [];
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: stale,
      listProcesses: () => [proc(4242)],
      readStartMs: pids => new Map(pids.map(pid => [pid, 1_000])),
      processIo: {
        listSnapshots: () => [],
        kill: pid => { killed.push(pid); },
        isAlive: () => true,
        waitExit: () => false,
      },
    });

    expect(killed).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      code: "partially_stopped",
      requested: [4242],
      stopped: [],
      surviving: [4242],
      failed: [],
    });
  });

  test("the service identity guard preserves Windows taskkill tree cleanup", async () => {
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const signals: number[] = [];
    setTrustedWindowsElevationExecutablesForTests({
      taskkill: "C:\\Windows\\System32\\taskkill.exe",
    });
    try {
      const result = await performCodexRestart({
        syncCatalog: async () => true,
        listenPort: () => 41999,
        resetStateCache: () => {},
        collectState: stale,
        listProcesses: () => [proc(4242)],
        readStartMs: pids => new Map(pids.map(pid => [pid, 1_000])),
        processIo: {
          platform: "win32",
          listSnapshots: () => [proc(4242)],
          execFile: (file, args) => { execCalls.push({ file, args }); },
          processKill: pid => { signals.push(pid); },
          isAlive: () => false,
          waitExit: () => true,
        },
      });

      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]!.args).toEqual(["/PID", "4242", "/T", "/F"]);
      expect(signals).toEqual([]);
      expect(result.code).toBe("stopped");
    } finally {
      setTrustedWindowsElevationExecutablesForTests(null);
    }
  });

  test("a failed taskkill rechecks identity before the Windows signal fallback", async () => {
    const signals: number[] = [];
    let startReads = 0;
    setTrustedWindowsElevationExecutablesForTests({
      taskkill: "C:\\Windows\\System32\\taskkill.exe",
    });
    try {
      const result = await performCodexRestart({
        syncCatalog: async () => true,
        listenPort: () => 41999,
        resetStateCache: () => {},
        collectState: stale,
        listProcesses: () => [proc(4242)],
        readStartMs: pids => {
          startReads += 1;
          const startedAtMs = startReads < 3 ? 1_000 : 2_000;
          return new Map(pids.map(pid => [pid, startedAtMs]));
        },
        processIo: {
          platform: "win32",
          listSnapshots: () => [proc(4242)],
          execFile: () => { throw new Error("taskkill unavailable"); },
          processKill: pid => { signals.push(pid); },
          isAlive: () => true,
          waitExit: () => false,
        },
      });

      expect(startReads).toBe(3);
      expect(signals).toEqual([]);
      expect(result).toMatchObject({
        success: false,
        code: "partially_stopped",
        requested: [4242],
        stopped: [],
        surviving: [4242],
        failed: [4242],
      });
    } finally {
      setTrustedWindowsElevationExecutablesForTests(null);
    }
  });

  test("an unreadable start time at signal time refuses the signal", async () => {
    const killed: number[] = [];
    let startReads = 0;
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: stale,
      listProcesses: () => [proc(4242)],
      readStartMs: pids => {
        startReads += 1;
        return new Map(pids.map(pid => [pid, startReads === 1 ? 1_000 : null]));
      },
      processIo: {
        listSnapshots: () => [{ pid: 4242, commandLine: "/opt/codex app-server --pid 4242" }],
        kill: pid => { killed.push(pid); },
        isAlive: () => true,
        waitExit: () => false,
      },
    });

    expect(killed).toEqual([]);
    expect(result.failed).toEqual([4242]);
  });

  test("the identity error never reaches the response body", async () => {
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: stale,
      listProcesses: () => [proc(4242)],
      readStartMs: (() => {
        let reads = 0;
        return (pids: readonly number[]) => {
          reads += 1;
          return new Map(pids.map(pid => [pid, reads === 1 ? 1_000 : 9_000]));
        };
      })(),
      processIo: {
        listSnapshots: () => [{ pid: 4242, commandLine: "/opt/codex app-server --pid 4242" }],
        isAlive: () => true,
        waitExit: () => false,
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("identity changed");
    expect(serialized).not.toContain("CodexAppServerIdentityChanged");
    expect(result.failed).toEqual([4242]);
  });
});

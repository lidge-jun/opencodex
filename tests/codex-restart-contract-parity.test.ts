import { describe, expect, test } from "bun:test";
import { performCodexRestart, resetCodexRestartInFlightForTests } from "../src/codex/app-server-restart-service";
import { isCodexRestartResponse } from "../src/lib/codex-restart-contract";

/**
 * The GUI rejects a response that fails isCodexRestartResponse, so an invariant
 * the service can actually violate would surface as "the proxy returned an
 * unexpected response" instead of the real outcome. Every branch the service can
 * return is checked against the guard here, in one place, so tightening either
 * side cannot silently break the other.
 */
const proc = (pid: number) => ({ pid, commandLine: `/opt/codex app-server --pid ${pid}` });

describe("every service response satisfies the shared contract guard", () => {
  test("stopped", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "stale", processes: [{ pid: 100, startedAtMs: 1 }], catalogMtimeMs: 10 }),
      listProcesses: () => [proc(100)],
      readStartMs: pids => new Map(pids.map(pid => [pid, 1])),
      restart: () => ({ requested: [100], stopped: [100], surviving: [], failed: [] }),
    });
    expect(result.code).toBe("stopped");
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("nothing_running", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      listProcesses: () => [],
      readStartMs: () => new Map(),
      restart: () => ({ requested: [], stopped: [], surviving: [], failed: [] }),
    });
    expect(result.code).toBe("nothing_running");
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("nothing_running with fresh app-servers", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => false,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({
        state: "fresh",
        processes: [{ pid: 100, startedAtMs: 20 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 20]]),
      restart: () => ({ requested: [100], stopped: [100], surviving: [], failed: [] }),
    });
    expect(result.code).toBe("nothing_running");
    expect(result.stateBefore).toBe("fresh");
    expect(result.requested).toEqual([]);
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("nothing_running via the exited-before-signal race", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "stale", processes: [{ pid: 100, startedAtMs: 1 }], catalogMtimeMs: 10 }),
      listProcesses: () => [],
      processIo: { isAlive: () => false },
      readStartMs: () => new Map(),
      restart: () => ({ requested: [], stopped: [], surviving: [], failed: [] }),
    });
    expect(result.code).toBe("nothing_running");
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("enumeration_unavailable", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "unknown", processes: [], catalogMtimeMs: null }),
      listProcesses: () => [],
      readStartMs: () => new Map(),
      restart: () => ({ requested: [], stopped: [], surviving: [], failed: [] }),
    });
    expect(result.code).toBe("enumeration_unavailable");
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("an unverifiable stale target remains contract-valid and unsettled", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "stale", processes: [{ pid: 100, startedAtMs: 1 }], catalogMtimeMs: 10 }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, null]]),
      restart: () => ({ requested: [], stopped: [], surviving: [], failed: [] }),
    });
    expect(result).toMatchObject({
      success: false,
      stateBefore: "stale",
      code: "partially_stopped",
      surviving: [100],
      failed: [100],
    });
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("partially_stopped with a survivor", async () => {
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({
        state: "stale",
        processes: [{ pid: 100, startedAtMs: 1 }, { pid: 200, startedAtMs: 2 }],
        catalogMtimeMs: 10,
      }),
      listProcesses: () => [proc(100), proc(200)],
      readStartMs: () => new Map([[100, 1], [200, 2]]),
      restart: () => ({ requested: [100, 200], stopped: [100], surviving: [200], failed: [] }),
    });
    expect(result.code).toBe("partially_stopped");
    expect(result.success).toBe(false);
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("partially_stopped where a kill threw and nothing stopped", async () => {
    // This is the shape the identity guard produces: kill refuses, the helper
    // records a failure, and both surviving and failed carry the pid.
    resetCodexRestartInFlightForTests();
    const result = await performCodexRestart({
      syncCatalog: async () => true,
      listenPort: () => 41999,
      resetStateCache: () => {},
      collectState: () => ({ state: "stale", processes: [{ pid: 100, startedAtMs: 1 }], catalogMtimeMs: 10 }),
      listProcesses: () => [proc(100)],
      readStartMs: () => new Map([[100, 1]]),
      restart: () => ({
        requested: [100],
        stopped: [],
        surviving: [100],
        failed: [{ pid: 100, error: "identity changed" }],
      }),
    });
    expect(result.code).toBe("partially_stopped");
    expect(result.failed).toEqual([100]);
    expect(isCodexRestartResponse(JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  test("the guard rejects impossible code and classifier-state pairs", () => {
    const base = {
      success: true,
      stateBefore: "stale",
      synced: true,
      requested: [100],
      stopped: [100],
      surviving: [],
      failed: [],
      code: "stopped",
    } as const;
    const invalid = [
      { ...base, stateBefore: "fresh" },
      { ...base, stateBefore: "not_running", code: "partially_stopped", success: false, stopped: [], surviving: [100] },
      { ...base, stateBefore: "stale", code: "enumeration_unavailable", stopped: [] },
      { ...base, stateBefore: "unknown", code: "nothing_running", requested: [], stopped: [] },
      { ...base, stopped: [] },
      { ...base, requested: [100, 100], stopped: [100, 100] },
      { ...base, requested: [100, 200], stopped: [100] },
      { ...base, requested: [], stopped: [100] },
      { ...base, code: "nothing_running", requested: [100], stopped: [] },
      {
        ...base,
        success: false,
        code: "partially_stopped",
        stopped: [100],
        surviving: [100],
      },
      {
        ...base,
        success: false,
        code: "partially_stopped",
        stopped: [],
        surviving: [100],
        failed: [200],
      },
    ];
    for (const response of invalid) expect(isCodexRestartResponse(response)).toBe(false);
    expect(isCodexRestartResponse({
      ...base,
      stateBefore: "fresh",
      code: "nothing_running",
      requested: [],
      stopped: [],
    })).toBe(true);
    expect(isCodexRestartResponse({
      ...base,
      success: false,
      code: "partially_stopped",
      requested: [100, 200],
      stopped: [100],
      surviving: [200],
      failed: [200],
    })).toBe(true);
  });
});

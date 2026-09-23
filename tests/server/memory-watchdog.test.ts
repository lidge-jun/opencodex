/**
 * RSS memory watchdog (#314 WP3): ring bound, rate-limited warn, idempotent
 * start, singleton accessor, and the /api/system/memory endpoint shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  getActiveMemoryWatchdog,
  observedMemoryCounter,
  startMemoryWatchdog,
  type MemorySampleBase,
} from "../../src/server/memory-watchdog";
import { handleManagementAPI } from "../../src/server/management-api";
import { selectEagerPath } from "../../src/lib/bun-stream-caps";
import type { OcxConfig } from "../../src/types";
import {
  appOwnedBytesSnapshot,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../../src/lib/app-owned-memory";
import { registerDefaultAppOwnedMemoryStores } from "../../src/lib/app-owned-memory-stores";
import { appendDebugLogLine, resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import { resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

afterEach(() => {
  getActiveMemoryWatchdog()?.stop();
  resetAppOwnedMemoryForTests();
  resetDebugLogBufferForTests();
  resetUsageAggregateCacheForTests();
});

function sampleAt(at: number, rssMb: number, externalMb = 1, arrayBuffersMb = 1): MemorySampleBase {
  return {
    at,
    rss: rssMb * 1024 * 1024,
    heapUsed: 1000,
    heapTotal: 2000,
    external: externalMb * 1024 * 1024,
    arrayBuffers: arrayBuffersMb * 1024 * 1024,
  };
}

describe("startMemoryWatchdog", () => {
  test("ring never exceeds ringSize and keeps the newest samples", async () => {
    let t = 0;
    const wd = startMemoryWatchdog({
      intervalMs: 1,
      ringSize: 5,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    const snap = wd.snapshot();
    expect(snap.samples.length).toBeLessThanOrEqual(5);
    expect(snap.samples.length).toBeGreaterThan(0);
    const ats = snap.samples.map(s => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats); // newest kept, ordered
  });

  test("threshold warn fires once per rate-limit window and never below threshold", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 600), // above threshold every tick, clock ~frozen vs 30min window
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 600MB (rss)");
    expect(warns[0]).toContain("500MB");
    // No paths/hostnames in the warn line.
    expect(warns[0]).not.toContain("/Users/");
    expect(warns[0]).not.toContain("C:\\");
  });

  test("threshold warn uses external and ArrayBuffers when RSS is below threshold (#509)", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 100, 600, 300),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 600MB (external)");

    const snap = getActiveMemoryWatchdog()!.snapshot();
    expect(snap.observedMetric).toBe("external");
    expect(snap.observedBytes).toBe(600 * 1024 * 1024);

    getActiveMemoryWatchdog()?.stop();
    warns.length = 0;
    t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 100, 300, 700),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 700MB (arrayBuffers)");
  });

  test("observedMemoryCounter uses max, not a sum", () => {
    expect(observedMemoryCounter(sampleAt(1, 100, 90, 80))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "rss",
    });
    expect(observedMemoryCounter(sampleAt(1, 10, 100, 90))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "external",
    });
    expect(observedMemoryCounter(sampleAt(1, 10, 90, 100))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "arrayBuffers",
    });
  });

  test("below-threshold samples never warn", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(warns).toEqual([]);
  });

  test("start is idempotent: the previous instance is stopped and replaced", () => {
    const first = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    const second = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    expect(getActiveMemoryWatchdog()).toBe(second);
    expect(getActiveMemoryWatchdog()).not.toBe(first);
    second.stop();
    expect(getActiveMemoryWatchdog()).toBeNull();
  });

  test("stop() of a superseded instance does not clear the active singleton", () => {
    const first = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    const second = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    first.stop(); // already superseded — must not null out `second`
    expect(getActiveMemoryWatchdog()).toBe(second);
  });
});

describe("GET /api/system/memory", () => {
  test("returns runtime identity, memory scalars, gate decision, and sliced watchdog samples", async () => {
    let t = 1000;
    startMemoryWatchdog({
      intervalMs: 1,
      ringSize: 200,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
	    const body = await res!.json() as {
	      pid: number; bunVersion: string; platform: string; rss: number;
	      heapUsed: number; external: number; arrayBuffers: number; observedBytes: number; observedMetric: string;
	      jscHeap: { heapSize: number } | null;
	      responseState: {
	        count: number; residentCount: number; spillStubCount: number; tombstoneCount: number;
	        totalBytes: number; spillPayloadBytes: number; largestBytes: number; oldestAgeMs: number;
	        spillWrites: number; spillWriteFailures: number; spillReadFailures: number;
	        spillWriteStatus: "initial" | "healthy" | "degraded";
	        spillWriteConsecutiveFailures: number;
	        spillLastWriteFailureCode: string | null;
	        spillLastWriteFailureOrigin: string | null;
	        spillAclRetryReturnedTimeouts: number;
	        spillAclTimeoutMemoRefusals: number;
	        spillLastWriteFailureAt: number | null;
	        spillLastWriteSuccessAt: number | null;
	        replayScopeMismatchDrops: number;
	      };
	      appOwnedBytes: ReturnType<typeof appOwnedBytesSnapshot>;
	      inspectionCounters: {
	        frameBufferHighWaterBytes: number; completedItemsMaxCount: number; frameCapOverflows: number;
	        itemCapEvictions: number; postCancelDrainStops: number;
	      };
	      streamMode: string; eagerRelay: unknown;
	      watchdog: { samples: unknown[]; warnThresholdBytes: number; observedBytes: number; observedMetric: string } | null;
	      activeTurnCount: number; isDraining: boolean;
	    };
    expect(body.pid).toBe(process.pid);
    expect(body.bunVersion).toBe(Bun.version);
	    expect(body.rss).toBeGreaterThan(0);
	    expect(body.heapUsed).toBeGreaterThan(0);
	    expect(body.external).toBeGreaterThanOrEqual(0);
	    expect(body.arrayBuffers).toBeGreaterThanOrEqual(0);
	    expect(body.observedBytes).toBeGreaterThan(0);
	    expect(["rss", "external", "arrayBuffers"]).toContain(body.observedMetric);
	    expect(body.jscHeap?.heapSize).toBeGreaterThan(0);
    // responseState is a scalar-only continuation-store attribution block: numbers plus fixed
    // enum/null fields (no paths, messages, tokens, or account identifiers).
    // The exact count is pinned on purpose: a new field must be reviewed for privacy safety
    // before it reaches this surface. 20 after #3522 added failure origins and counters.
    expect(Object.keys(body.responseState)).toHaveLength(20);
    const {
      spillWriteStatus,
      spillLastWriteFailureCode,
      spillLastWriteFailureOrigin,
      spillLastWriteFailureAt,
      spillLastWriteSuccessAt,
      ...numericResponseState
    } = body.responseState;
    expect(Object.values(numericResponseState)
      .every(value => typeof value === "number" && Number.isFinite(value))).toBe(true);
    expect(["initial", "healthy", "degraded"]).toContain(spillWriteStatus);
    expect(spillLastWriteFailureOrigin === null || [
      "retry_returned_timeout", "timeout_memo_refusal",
    ].includes(spillLastWriteFailureOrigin)).toBe(true);
    expect(spillLastWriteFailureCode === null || [
      "EACLRETRYEXHAUSTED", "ETIMEDOUT", "EACCES", "ENOSPC", "EFBIG",
      "EIO", "ECAPACITY", "ELOOP", "EUNKNOWN",
    ].includes(spillLastWriteFailureCode)).toBe(true);
    expect(spillLastWriteFailureAt === null || Number.isFinite(spillLastWriteFailureAt)).toBe(true);
    expect(spillLastWriteSuccessAt === null || Number.isFinite(spillLastWriteSuccessAt)).toBe(true);
    expect(body.responseState.count).toBeGreaterThanOrEqual(0);
    expect(body.appOwnedBytes).toEqual({
      budgetBytes: expect.any(Number),
      retainedBytes: expect.any(Number),
      evictableBytes: expect.any(Number),
      pinnedBytes: expect.any(Number),
      overBudgetBytes: expect.any(Number),
      stores: expect.any(Object),
      observedInFlight: expect.any(Object),
      enforcement: {
        runs: expect.any(Number),
        entriesDemoted: expect.any(Number),
        bytesReleased: expect.any(Number),
        noEvictableCandidate: expect.any(Number),
        snapshotFailures: expect.any(Number),
        oldestAtContractViolations: expect.any(Number),
      },
    });
    expect(body.inspectionCounters).toEqual({
      frameBufferHighWaterBytes: expect.any(Number),
      completedItemsMaxCount: expect.any(Number),
      frameCapOverflows: expect.any(Number),
      itemCapEvictions: expect.any(Number),
      postCancelDrainStops: expect.any(Number),
    });
    expect(body.streamMode).toBe("auto");
    // This route has no rewrite context and reports the selector's effective
    // no-rewrite baseline on win32/darwin, null elsewhere.
    expect(body.eagerRelay).toEqual(selectEagerPath(process.platform, false, "auto"));
	    expect(body.watchdog).not.toBeNull();
	    expect(body.watchdog!.samples.length).toBeLessThanOrEqual(60);
	    expect(typeof body.watchdog!.observedBytes).toBe("number");
	    expect(["rss", "external", "arrayBuffers"]).toContain(body.watchdog!.observedMetric);
	    expect(typeof body.activeTurnCount).toBe("number");
	    expect(body.activeTurnCount).toBeGreaterThanOrEqual(0);
	    expect(typeof body.isDraining).toBe("boolean");
	  });

  test("watchdog null when no instance is running", async () => {
    getActiveMemoryWatchdog()?.stop();
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const res = await handleManagementAPI(req, new URL(req.url), config());
    const body = await res!.json() as { watchdog: unknown };
    expect(body.watchdog).toBeNull();
  });

  test("serializes only an allowlisted Bun runtime provenance, omitting it otherwise (#848)", async () => {
    const inherited = process.env.OCX_BUN_RUNTIME_SOURCE;
    const read = async (): Promise<{ bunRuntimeSource?: unknown; bunRevision?: unknown }> => {
      const req = new Request("http://127.0.0.1:10100/api/system/memory");
      const res = await handleManagementAPI(req, new URL(req.url), config());
      return await res!.json() as { bunRuntimeSource?: unknown; bunRevision?: unknown };
    };
    try {
      // The env-marker matrix itself — every allowlisted source, the pair contract,
      // a mismatched recorded path, and absent or unrecognized markers — is exercised
      // directly against the serialization target in
      // tests/ci-workflows/bun-runtime.test.ts ("reportedBunRuntimeSource (#848
      // launch-time provenance)"), with assertions identical to the ones this test
      // used to route through eight full memory snapshots (~600 ms each on the
      // shared CI runners, over this test's own deadline twice in unrelated PRs).
      // What only this test can still prove is the wiring: the route answers THIS
      // field from THAT function. One read per wire shape is the whole cost of that.
      process.env.OCX_BUN_RUNTIME_SOURCE = "bundled";
      process.env.OCX_BUN_RUNTIME_PATH = process.execPath;
      const reported = await read();
      expect(reported.bunRuntimeSource).toBe("bundled");
      expect(typeof reported.bunRevision).toBe("string");

      // Without the marker pair the field is absent, never a guessed value.
      delete process.env.OCX_BUN_RUNTIME_SOURCE;
      delete process.env.OCX_BUN_RUNTIME_PATH;
      expect((await read()).bunRuntimeSource).toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.OCX_BUN_RUNTIME_SOURCE;
      else process.env.OCX_BUN_RUNTIME_SOURCE = inherited;
      delete process.env.OCX_BUN_RUNTIME_PATH;
    }
  });

  test("GET system memory includes privacy-safe appOwnedBytes scalars", async () => {
    registerDefaultAppOwnedMemoryStores();
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const body = await (await handleManagementAPI(req, new URL(req.url), config()))!.json() as {
      appOwnedBytes: ReturnType<typeof appOwnedBytesSnapshot>;
    };
    expect(Object.keys(body.appOwnedBytes.stores).sort()).toEqual([
      "antigravity_replay", "claude_debug", "crash_ring", "cursor_blobs", "image_normalize",
      "injection_debug", "model_cache", "native_control_replay", "provider_debug", "request_log", "responses_continuation",
      "usage_snapshot", "usage_summary", "vision_descriptions",
    ]);
    expect(Object.values(body.appOwnedBytes.stores).flatMap(snapshot => Object.values(snapshot))
      .every(value => value === null || typeof value === "number")).toBe(true);
    expect(body.appOwnedBytes.observedInFlight).toEqual({});
  });

  test("GET system memory does not load prune serialize or evict retained stores", async () => {
    let snapshots = 0;
    let evictions = 0;
    registerRetainedStore({
      id: "observe_only",
      category: "logs",
      snapshot: () => {
        snapshots += 1;
        return { count: 1, bytes: 1, evictableBytes: 1, pinnedBytes: 0, oldestAt: 1 };
      },
      evictOldest: () => { evictions += 1; return 1; },
    });
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    await handleManagementAPI(req, new URL(req.url), config());
    expect(snapshots).toBe(1);
    expect(evictions).toBe(0);
  });

  test("payload contains no dynamic store keys paths ids or diagnostic text", async () => {
    registerDefaultAppOwnedMemoryStores();
    const privatePath = ["", "Users", "alice", "private"].join("/");
    appendDebugLogLine(`secret-diagnostic ${privatePath} prompt-text model/provider-id`);
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const response = await handleManagementAPI(req, new URL(req.url), config());
    const wire = await response!.text();
    expect(wire).not.toContain("secret-diagnostic");
    expect(wire).not.toContain(privatePath);
    expect(wire).not.toContain("prompt-text");
    expect(wire).not.toContain("model/provider-id");
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";

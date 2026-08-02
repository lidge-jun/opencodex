import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appOwnedBytesSnapshot,
  APP_OWNED_WORST_CASE_PINNED_BYTES,
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  registerObservedBuffer,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
  type AppOwnedRetainedCategory,
  type RetainedStoreSnapshot,
} from "../src/lib/app-owned-memory";
import { CURSOR_BLOB_MAX_TOTAL_BYTES } from "../src/adapters/cursor/native-exec";
import { MAX_STORED_RESPONSE_BYTES } from "../src/responses/state";
import { IMAGE_NORMALIZE_CACHE_MAX_BYTES } from "../src/adapters/anthropic-image-normalize";
import { VISION_DESCRIPTION_CACHE_MAX_BYTES } from "../src/vision";
import { ANTIGRAVITY_REPLAY_MAX_TOTAL_BYTES } from "../src/adapters/google-antigravity-replay";
import {
  clearRequestLogsForTests,
  evictOldestRequestLogForBudget,
  hydrateRequestLogsFromDisk,
  requestLogEntryFromPersistedUsage,
  requestLogRetainedStoreSnapshot,
} from "../src/server/request-log";
import {
  clearModelCache,
  evictOldestModelCacheForBudget,
  modelCacheRetainedStoreSnapshot,
  setCached,
} from "../src/codex/model-cache";
import type { PersistedUsageEntry } from "../src/usage/log";
import { registerDefaultAppOwnedObservedBuffers } from "../src/lib/app-owned-memory-stores";

interface Row { bytes: number; at: number; pinned?: boolean }

function registerRows(
  id: string,
  category: AppOwnedRetainedCategory,
  rows: Row[],
  order: string[],
  behavior: "normal" | "zero" | "throw" = "normal",
): void {
  registerRetainedStore({
    id,
    category,
    snapshot(): RetainedStoreSnapshot {
      const evictable = rows.filter(row => !row.pinned);
      return {
        count: rows.length,
        bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
        evictableBytes: evictable.reduce((sum, row) => sum + row.bytes, 0),
        pinnedBytes: rows.filter(row => row.pinned).reduce((sum, row) => sum + row.bytes, 0),
        oldestAt: evictable.reduce<number | null>((oldest, row) => oldest === null ? row.at : Math.min(oldest, row.at), null),
      };
    },
    evictOldest() {
      order.push(id);
      if (behavior === "throw") throw new Error("owner failed");
      if (behavior === "zero") return 0;
      let oldestIndex = -1;
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index]!.pinned) continue;
        if (oldestIndex < 0 || rows[index]!.at < rows[oldestIndex]!.at) oldestIndex = index;
      }
      if (oldestIndex < 0) return 0;
      return rows.splice(oldestIndex, 1)[0]!.bytes;
    },
  });
}

beforeEach(() => {
  resetAppOwnedMemoryForTests();
  clearRequestLogsForTests();
  clearModelCache();
});
afterEach(() => {
  resetAppOwnedMemoryForTests();
  clearRequestLogsForTests();
  clearModelCache();
});

describe("app-owned retained memory", () => {
  test("independent store caps keep worst-case pinned headroom below the hard ceiling", () => {
    const boundedStoreBytes = CURSOR_BLOB_MAX_TOTAL_BYTES
      + MAX_STORED_RESPONSE_BYTES
      + IMAGE_NORMALIZE_CACHE_MAX_BYTES
      + VISION_DESCRIPTION_CACHE_MAX_BYTES
      + ANTIGRAVITY_REPLAY_MAX_TOTAL_BYTES;
    expect(boundedStoreBytes).toBeLessThan(APP_OWNED_WORST_CASE_PINNED_BYTES);
  });

  test("snapshot is observe-only and never calls an eviction callback", () => {
    const order: string[] = [];
    registerRows("logs", "logs", [{ bytes: 4, at: 1 }], order);
    expect(appOwnedBytesSnapshot().retainedBytes).toBe(4);
    expect(order).toEqual([]);
  });

  test("replacement registration cannot double-count one store id", () => {
    registerRows("same", "logs", [{ bytes: 4, at: 1 }], []);
    registerRows("same", "logs", [{ bytes: 7, at: 2 }], []);
    expect(appOwnedBytesSnapshot()).toMatchObject({ retainedBytes: 7, evictableBytes: 7 });
    expect(Object.keys(appOwnedBytesSnapshot().stores)).toEqual(["same"]);
  });

  test("exact budget boundary performs no demotion", () => {
    const order: string[] = [];
    registerRows("logs", "logs", [{ bytes: 4, at: 1 }], order);
    configureAppOwnedMemoryBudget(4);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual([]);
  });

  test("under-budget enforcement snapshots each retained owner only once", () => {
    let snapshots = 0;
    registerRetainedStore({
      id: "constant_time",
      category: "logs",
      snapshot: () => {
        snapshots += 1;
        return { count: 1, bytes: 4, evictableBytes: 4, pinnedBytes: 0, oldestAt: 1 };
      },
      evictOldest: () => 0,
    });
    configureAppOwnedMemoryBudget(4);
    expect(enforceAppOwnedMemoryBudget().retainedBytes).toBe(4);
    expect(snapshots).toBe(1);
  });

  test("eviction refreshes only the owner that was demoted", () => {
    const snapshotCalls = new Map<string, number>();
    const order: string[] = [];
    const registerCounted = (id: string, bytes: number, at: number): void => {
      let retained = bytes;
      registerRetainedStore({
        id,
        category: "logs",
        snapshot: () => {
          snapshotCalls.set(id, (snapshotCalls.get(id) ?? 0) + 1);
          return {
            count: retained > 0 ? 1 : 0,
            bytes: retained,
            evictableBytes: retained,
            pinnedBytes: 0,
            oldestAt: retained > 0 ? at : null,
          };
        },
        evictOldest: () => {
          order.push(id);
          const released = retained;
          retained = 0;
          return released;
        },
      });
    };
    registerCounted("old", 1, 1);
    registerCounted("untouched", 4, 2);
    configureAppOwnedMemoryBudget(4);
    expect(enforceAppOwnedMemoryBudget().retainedBytes).toBe(4);
    expect(order).toEqual(["old"]);
    expect(snapshotCalls).toEqual(new Map([["old", 2], ["untouched", 1]]));
  });

  test("one byte over budget demotes oldest log before newer log", () => {
    const order: string[] = [];
    const old = [{ bytes: 1, at: 1 }];
    const fresh = [{ bytes: 4, at: 2 }];
    registerRows("old", "logs", old, order);
    registerRows("fresh", "logs", fresh, order);
    configureAppOwnedMemoryBudget(4);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["old"]);
  });

  test("equal oldestAt ties evict the earlier registered owner first", () => {
    const order: string[] = [];
    registerRows("first", "logs", [{ bytes: 2, at: 1 }], order);
    registerRows("second", "logs", [{ bytes: 2, at: 1 }], order);
    registerRows("first", "logs", [{ bytes: 2, at: 1 }], order);
    configureAppOwnedMemoryBudget(2);

    enforceAppOwnedMemoryBudget();

    expect(order).toEqual(["first"]);
  });

  test("category order beats cross-category timestamp order", () => {
    const order: string[] = [];
    registerRows("cache", "caches", [{ bytes: 5, at: 1 }], order);
    registerRows("log", "logs", [{ bytes: 5, at: 10 }], order);
    configureAppOwnedMemoryBudget(5);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["log"]);
  });

  test("cache demotion starts only after logs and rings have no candidates", () => {
    const order: string[] = [];
    registerRows("request_log", "logs", [{ bytes: 2, at: 1 }], order);
    registerRows("provider_debug", "logs", [{ bytes: 2, at: 2 }], order);
    registerRows("cache", "caches", [{ bytes: 2, at: 0 }], order);
    configureAppOwnedMemoryBudget(1);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["request_log", "provider_debug", "cache"]);
  });

  test("local blobs demote before continuation and pinned remote bytes remain", () => {
    const order: string[] = [];
    registerRows("cursor_blobs", "blobs", [
      { bytes: 3, at: 1 },
      { bytes: 5, at: 0, pinned: true },
    ], order);
    registerRows("responses_continuation", "continuation", [{ bytes: 3, at: -1 }], order);
    configureAppOwnedMemoryBudget(8);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["cursor_blobs"]);
    expect(appOwnedBytesSnapshot()).toMatchObject({ retainedBytes: 8, pinnedBytes: 5 });
  });

  test("continuation is the final demotion category and uses durable spill callback", () => {
    const order: string[] = [];
    registerRows("cache", "caches", [{ bytes: 2, at: 2 }], order);
    registerRows("responses_continuation", "continuation", [{ bytes: 2, at: 1 }], order);
    configureAppOwnedMemoryBudget(0);
    enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["cache", "responses_continuation"]);
  });

  test("single retained entry over budget is demoted even when it is the only entry", () => {
    const order: string[] = [];
    registerRows("only", "logs", [{ bytes: 10, at: 1 }], order);
    configureAppOwnedMemoryBudget(9);
    expect(enforceAppOwnedMemoryBudget().retainedBytes).toBe(0);
    expect(order).toEqual(["only"]);
  });

  test("pinned-only saturation reports honest overBudgetBytes and noEvictableCandidate", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    registerRows("pinned", "blobs", [{ bytes: 10, at: 1, pinned: true }], []);
    configureAppOwnedMemoryBudget(5);
    const snapshot = enforceAppOwnedMemoryBudget();
    expect(snapshot).toMatchObject({ retainedBytes: 10, pinnedBytes: 10, overBudgetBytes: 5 });
    expect(snapshot.enforcement.noEvictableCandidate).toBe(1);
    enforceAppOwnedMemoryBudget();
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  test("zero-release and throwing callbacks cannot spin or hide over-budget bytes", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const order: string[] = [];
    registerRows("zero", "logs", [{ bytes: 2, at: 1 }], order, "zero");
    registerRows("throw", "logs", [{ bytes: 2, at: 2 }], order, "throw");
    configureAppOwnedMemoryBudget(0);
    const snapshot = enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["zero", "throw"]);
    expect(snapshot).toMatchObject({ retainedBytes: 4, overBudgetBytes: 4 });
    expect(snapshot.enforcement.noEvictableCandidate).toBe(1);
    warning.mockRestore();
  });

  test("throwing snapshot reports zero owner scalars and increments snapshotFailures", () => {
    registerRetainedStore({
      id: "throwing_retained",
      category: "logs",
      snapshot: () => { throw new Error("retained snapshot failed"); },
      evictOldest: () => 0,
    });
    registerObservedBuffer({
      id: "throwing_observed",
      category: "translator",
      snapshot: () => { throw new Error("observed snapshot failed"); },
    });

    const snapshot = appOwnedBytesSnapshot();

    expect(snapshot.stores.throwing_retained).toEqual({
      count: 0,
      bytes: 0,
      evictableBytes: 0,
      pinnedBytes: 0,
      oldestAt: null,
    });
    expect(snapshot.observedInFlight.throwing_observed).toEqual({
      currentBytes: 0,
      highWaterBytes: 0,
      active: 0,
    });
    expect(snapshot.enforcement.snapshotFailures).toBe(2);
  });

  test("evictable bytes with null oldestAt increments oldestAtContractViolations and skips the owner", () => {
    const order: string[] = [];
    registerRetainedStore({
      id: "invalid_oldest",
      category: "logs",
      snapshot: () => ({ count: 1, bytes: 3, evictableBytes: 3, pinnedBytes: 0, oldestAt: null }),
      evictOldest: () => { order.push("invalid_oldest"); return 3; },
    });
    registerRows("valid_oldest", "logs", [{ bytes: 2, at: 1 }], order);
    configureAppOwnedMemoryBudget(3);

    const snapshot = enforceAppOwnedMemoryBudget();

    expect(order).toEqual(["valid_oldest"]);
    expect(snapshot.retainedBytes).toBe(3);
    expect(snapshot.enforcement.oldestAtContractViolations).toBe(1);
  });

  test("continuation replacement during enforcement is non-reentrant and counts one demotion", () => {
    let retained = 4;
    let callbacks = 0;
    let nestedRuns = -1;
    registerRetainedStore({
      id: "responses_continuation",
      category: "continuation",
      snapshot: () => ({
        count: retained > 0 ? 1 : 0,
        bytes: retained,
        evictableBytes: retained,
        pinnedBytes: 0,
        oldestAt: retained > 0 ? 1 : null,
      }),
      evictOldest: () => {
        callbacks += 1;
        nestedRuns = enforceAppOwnedMemoryBudget().enforcement.runs;
        const released = retained;
        retained = 0;
        return released;
      },
    });
    configureAppOwnedMemoryBudget(0);

    const snapshot = enforceAppOwnedMemoryBudget();

    expect(callbacks).toBe(1);
    expect(nestedRuns).toBe(1);
    expect(snapshot.enforcement).toMatchObject({ runs: 1, entriesDemoted: 1, bytesReleased: 4 });
  });

  test("replacement and eviction byte accounting remains exact across all hooks", () => {
    const order: string[] = [];
    for (const [index, category] of (["logs", "caches", "blobs", "continuation"] as const).entries()) {
      registerRows(category, category, [{ bytes: index + 1, at: index }], order);
    }
    registerRows("caches", "caches", [{ bytes: 10, at: 1 }], order);
    expect(appOwnedBytesSnapshot().retainedBytes).toBe(1 + 10 + 3 + 4);
    configureAppOwnedMemoryBudget(0);
    const snapshot = enforceAppOwnedMemoryBudget();
    expect(snapshot.retainedBytes).toBe(0);
    expect(snapshot.enforcement.bytesReleased).toBe(18);
  });

  test("translator and serialized-tail observations never invoke budget eviction", () => {
    const order: string[] = [];
    registerRows("logs", "logs", [{ bytes: 1, at: 1 }], order);
    registerObservedBuffer({ id: "translator", category: "translator", snapshot: () => ({ currentBytes: 100, highWaterBytes: 200, active: 1 }) });
    registerObservedBuffer({ id: "tails", category: "serialized_tails", snapshot: () => ({ currentBytes: 300, highWaterBytes: 400, active: 2 }) });
    configureAppOwnedMemoryBudget(1);
    const snapshot = enforceAppOwnedMemoryBudget();
    expect(order).toEqual([]);
    expect(snapshot.observedInFlight).toEqual({
      translator: { currentBytes: 100, highWaterBytes: 200, active: 1 },
      tails: { currentBytes: 300, highWaterBytes: 400, active: 2 },
    });
  });

  test("all four 050 observed ids appear in observedInFlight with the 040 scalar shape", () => {
    registerDefaultAppOwnedObservedBuffers();
    const observed = appOwnedBytesSnapshot().observedInFlight;
    expect(Object.keys(observed).sort()).toEqual([
      "grok_apply_flight",
      "image_fulfillment_tail",
      "oauth_mutation_tail",
      "translator_buffers",
    ]);
    for (const snapshot of Object.values(observed)) {
      expect(Object.keys(snapshot).sort()).toEqual(["active", "currentBytes", "highWaterBytes"]);
    }
  });

  test("budget decrease enforces synchronously in the documented order", () => {
    const order: string[] = [];
    registerRows("log", "logs", [{ bytes: 2, at: 2 }], order);
    registerRows("cache", "caches", [{ bytes: 2, at: 1 }], order);
    configureAppOwnedMemoryBudget(4);
    enforceAppOwnedMemoryBudget();
    configureAppOwnedMemoryBudget(0);
    const snapshot = enforceAppOwnedMemoryBudget();
    expect(order).toEqual(["log", "cache"]);
    expect(snapshot.retainedBytes).toBe(0);
  });

  test("request-log and model-cache owners account UTF-8 replacement and oldest deletion exactly", () => {
    const persisted: PersistedUsageEntry = {
      requestId: "req-한글",
      timestamp: 10,
      provider: "provider-🙂",
      model: "model-🙂",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
    };
    hydrateRequestLogsFromDisk(() => [persisted]);
    const projected = requestLogEntryFromPersistedUsage(persisted);
    const requestBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    expect(requestLogRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: requestBytes });
    expect(evictOldestRequestLogForBudget()).toBe(requestBytes);
    expect(requestLogRetainedStoreSnapshot()).toMatchObject({ count: 0, bytes: 0 });

    setCached("provider-🙂", [{ id: "model-🙂", provider: "provider-🙂", displayName: "모델🙂" }], 10);
    const firstBytes = Buffer.byteLength("provider-🙂", "utf8")
      + Buffer.byteLength(JSON.stringify([{ id: "model-🙂", provider: "provider-🙂", displayName: "모델🙂" }]), "utf8");
    expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: firstBytes });
    setCached("provider-🙂", [{ id: "replacement", provider: "provider-🙂", displayName: "교체" }], 20);
    const replacementBytes = Buffer.byteLength("provider-🙂", "utf8")
      + Buffer.byteLength(JSON.stringify([{ id: "replacement", provider: "provider-🙂", displayName: "교체" }]), "utf8");
    expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: replacementBytes, oldestAt: 20 });
    expect(evictOldestModelCacheForBudget()).toBe(replacementBytes);
    expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 0, bytes: 0 });
  });
});

/**
 * Store-level coverage for the connection-owned replay scope
 * (src/responses/state/connection-scope.ts): an opaque, memory-only namespace the
 * /v1/responses WebSocket upgrade mints for an unidentified loopback caller.
 *
 * The guarantees exercised here are the ones the design owes and nothing more:
 * the handle cannot be forged by shape, it binds to the handshake thread, it
 * never grants context-principal or data-plane authority, scoped state never
 * reaches the snapshot or the spill machinery — not even through the pending
 * publication seam, a superseded foreign ref, an atomic swap, or an
 * unserializable write — and release wipes the scope's entries so a late write
 * always refuses. Persistent snapshot writes elsewhere in this suite prove only
 * payload/scope exclusion: the debounced snapshot itself still runs for the
 * durable entries that legitimately share the file.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import {
  configureAppOwnedMemoryBudget, DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  enforceAppOwnedMemoryBudget, registerRetainedStore,
} from "../../src/lib/app-owned-memory";
import {
  clearResponseStateForTests, clearResponseStateMemoryForTests, expandPreviousResponseInput,
  rememberResponseState, previousResponseReplayFailure, runPendingResponseStatePersistForTests,
  setResponseStateByteCapForTests, setSpilledResponseByteCapForTests, flushResponseState, markBodyNonPersistable,
  evictOldestResponseContinuationForBudget, responseContinuationRetainedStoreSnapshot, responseStateMetrics,
  responseStatePersistPendingForTests, setResponseStatePersistAttemptHookForTests,
  sweepExpiredResponseStates, RESPONSE_TTL_MS,
  mintConnectionReplayScope, connectionReplayScopeLive, connectionReplayScopeForThread,
  connectionReplayScopeOwnerKey, releaseConnectionReplayScope,
  type ConnectionReplayScope, type ResidentResponseState,
} from "../../src/responses/state";
import {
  CONNECTION_REPLAY_SCOPE_TTL_MS,
  MAX_CONNECTION_SCOPE_ENTRIES,
} from "../../src/responses/state/connection-scope";
import {
  flushPendingResponseSpillsForTests,
  pendingResponseSpillMetricsForTests,
  queuePendingResponseSpill,
  replaceWithPendingResponseSpill,
} from "../../src/responses/state/spill-queue";
import { isContextPrincipalCurrent } from "../../src/server/auth-cors";
import { CODEX_WS_ID_MAX_BYTES } from "../../src/server/responses/codex-ws-correlation";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const ownerB = "b".repeat(64);
const ownerC = "c".repeat(64);

let release: () => void;
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-conn-scope-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearResponseStateForTests();
});
afterEach(() => {
  setResponseStateByteCapForTests(null);
  setSpilledResponseByteCapForTests(null);
  release();
  try { clearResponseStateForTests(); } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

function mintScope(thread = "own-a"): { scope: ConnectionReplayScope; key: string } {
  const scope = mintConnectionReplayScope(thread);
  expect(scope).toBeDefined();
  const key = connectionReplayScopeOwnerKey(scope);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  return { scope: scope!, key: key! };
}

function output(text: string) {
  return [{ type: "message", role: "assistant", content: text }];
}

function scopedRemember(id: string, scope: ConnectionReplayScope, key: string, text = "private synthetic task", thread = "own-a"): void {
  rememberResponseState({ input: [] }, { id, output: output(text) }, undefined,
    { clientThreadId: thread, replayOwnerKey: key, connectionScope: scope });
}

function replay(id: string, thread?: string, ownerKey?: string | null): Record<string, unknown> {
  return expandPreviousResponseInput({ previous_response_id: id, input: [] }, thread, ownerKey) as Record<string, unknown>;
}

function snapshotText(): string {
  const file = join(getConfigDir(), "responses-state.json");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function spillDirText(): string {
  const dir = join(getConfigDir(), "responses-state-spill");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).join("\n");
}

test("a scope binds to the handshake thread and a cast literal is never live", () => {
  expect(mintConnectionReplayScope(undefined)).toBeUndefined();
  expect(mintConnectionReplayScope("   ")).toBeUndefined();
  const { scope, key } = mintScope();
  expect(connectionReplayScopeLive(scope)).toBe(true);
  expect(connectionReplayScopeForThread(scope, "own-a")).toBe(scope);
  expect(connectionReplayScopeForThread(scope, "own-b")).toBeUndefined();
  expect(connectionReplayScopeForThread(scope, undefined)).toBeUndefined();
  // The handle carries no readable authority: no enumerable fields, no serialized shape.
  expect(Object.keys(scope)).toEqual([]);
  expect(JSON.stringify(scope)).toBe("{}");
  // A structurally identical literal holds no record: forgery by shape is refused everywhere.
  const forged = { ownerKey: key, ownThread: "own-a", closed: false, entryIds: new Set() } as unknown as ConnectionReplayScope;
  expect(connectionReplayScopeLive(forged)).toBe(false);
  expect(connectionReplayScopeForThread(forged, "own-a")).toBeUndefined();
  expect(connectionReplayScopeOwnerKey(forged)).toBeUndefined();
  const empty = {} as ConnectionReplayScope;
  expect(connectionReplayScopeLive(empty)).toBe(false);
});

test("the minted key is not a context principal and grants no data-plane authority", () => {
  const cfg = { apiKeys: [{ id: "a", key: "synthetic-a" }] } as OcxConfig;
  const { key } = mintScope();
  expect(isContextPrincipalCurrent(key, cfg)).toBe(false);
});

test("scoped retention replays only to the same key and thread", () => {
  const { scope, key } = mintScope();
  scopedRemember("resp-scope-a", scope, key);
  expect(JSON.stringify(replay("resp-scope-a", "own-a", key).input)).toContain("private synthetic task");
  expect(previousResponseReplayFailure(replay("resp-scope-a", "own-a", ownerB))?.reason).toBe("scope_mismatch");
  expect(previousResponseReplayFailure(replay("resp-scope-a", "own-a", null))?.reason).toBe("scope_mismatch");
  expect(previousResponseReplayFailure(replay("resp-scope-a", "own-b", key))?.reason).toBe("scope_mismatch");
});

test("a scoped write is refused for a foreign key or a foreign thread", () => {
  const { scope, key } = mintScope();
  // The scope handle attached to a write carrying a different owner's key: refused.
  rememberResponseState({ input: [] }, { id: "resp-foreign-key", output: output("leak") }, undefined,
    { clientThreadId: "own-a", replayOwnerKey: ownerB, connectionScope: scope });
  const wrongKey = { previous_response_id: "resp-foreign-key", input: [] };
  expect(expandPreviousResponseInput(wrongKey, "own-a", ownerB)).toBe(wrongKey);
  // The scope handle attached to a write on another thread: refused.
  rememberResponseState({ input: [] }, { id: "resp-foreign-thread", output: output("leak") }, undefined,
    { clientThreadId: "own-b", replayOwnerKey: key, connectionScope: scope });
  const wrongThread = { previous_response_id: "resp-foreign-thread", input: [] };
  expect(expandPreviousResponseInput(wrongThread, "own-b", key)).toBe(wrongThread);
});

test("releasing the scope drops its entries and refuses the late in-flight write", () => {
  const { scope, key } = mintScope();
  scopedRemember("resp-live", scope, key);
  expect(JSON.stringify(replay("resp-live", "own-a", key).input)).toContain("private synthetic task");
  releaseConnectionReplayScope(scope);
  // Entries owned by the closed scope are gone; the same key cannot resurrect them.
  const gone = { previous_response_id: "resp-live", input: [] };
  expect(expandPreviousResponseInput(gone, "own-a", key)).toBe(gone);
  // A write that had already captured the scope refuses at the liveness check.
  scopedRemember("resp-late", scope, key);
  const late = { previous_response_id: "resp-late", input: [] };
  expect(expandPreviousResponseInput(late, "own-a", key)).toBe(late);
  // Release is idempotent and a foreign scope's entries are untouched.
  releaseConnectionReplayScope(scope);
  const second = mintScope();
  scopedRemember("resp-second", second.scope, second.key);
  releaseConnectionReplayScope(scope);
  expect(JSON.stringify(replay("resp-second", "own-a", second.key).input)).toContain("private synthetic task");
});

test("an expired scope is dead at mint time and refuses writes", () => {
  const scope = mintConnectionReplayScope("own-a", Date.now() - CONNECTION_REPLAY_SCOPE_TTL_MS - 1);
  expect(scope).toBeDefined();
  expect(connectionReplayScopeLive(scope)).toBe(false);
  expect(connectionReplayScopeForThread(scope, "own-a")).toBeUndefined();
  const key = connectionReplayScopeOwnerKey(scope)!;
  scopedRemember("resp-expired", scope!, key);
  const body = { previous_response_id: "resp-expired", input: [] };
  expect(expandPreviousResponseInput(body, "own-a", key)).toBe(body);
});

test("the entry cap drops the scope's oldest retained response", () => {
  const { scope, key } = mintScope();
  for (let i = 0; i < MAX_CONNECTION_SCOPE_ENTRIES + 1; i++) {
    scopedRemember("resp-cap-" + i, scope, key, "payload-" + i);
  }
  const evicted = { previous_response_id: "resp-cap-0", input: [] };
  expect(expandPreviousResponseInput(evicted, "own-a", key)).toBe(evicted);
  const newest = "resp-cap-" + MAX_CONNECTION_SCOPE_ENTRIES;
  expect(JSON.stringify(replay(newest, "own-a", key).input)).toContain("payload-" + MAX_CONNECTION_SCOPE_ENTRIES);
  expect(JSON.stringify(replay("resp-cap-1", "own-a", key).input)).toContain("payload-1");
});

test("the shared entry cap drops a scoped response before deleting a keyed spill", async () => {
  const { scope, key } = mintScope();
  setResponseStateByteCapForTests(2048);
  rememberResponseState({ input: [] }, { id: "resp-keyed-spill", output: output("keyed spill payload ".repeat(256)) },
    undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
  await flushPendingResponseSpillsForTests();
  expect(responseStateMetrics().spillStubCount).toBe(1);
  setResponseStateByteCapForTests(null);
  for (let i = 1; i < 1000; i++) {
    rememberResponseState({ input: [] }, { id: `resp-keyed-${i}`, output: output("keyed") }, undefined,
      { clientThreadId: "own-b", replayOwnerKey: ownerB });
  }
  expect(responseStateMetrics().count).toBe(1000);
  scopedRemember("resp-scoped-over-count", scope, key);
  expect(responseStateMetrics().count).toBe(1000);
  expect(spillDirText()).toContain("keyed spill payload");
  expect(JSON.stringify(replay("resp-keyed-spill", "own-b", ownerB).input)).toContain("keyed spill payload");
  expect(replay("resp-scoped-over-count", "own-a", key).input).toEqual([]);
});

function registerResponseBudget(): () => void {
  const unregister = registerRetainedStore({
    id: "responses_continuation",
    category: "continuation",
    snapshot: responseContinuationRetainedStoreSnapshot,
    evictOldest: evictOldestResponseContinuationForBudget,
  });
  return () => {
    unregister();
    configureAppOwnedMemoryBudget(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES);
  };
}

test("scoped admission declines without reclaiming keyed state under the process budget", async () => {
  const restore = registerResponseBudget();
  try {
    const { scope, key } = mintScope();
    setResponseStateByteCapForTests(2048);
    rememberResponseState({ input: [] }, { id: "resp-keyed-spill", output: output("keyed spill ".repeat(512)) },
      undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
    await flushPendingResponseSpillsForTests();
    setResponseStateByteCapForTests(null);
    rememberResponseState({ input: [] }, { id: "resp-keyed-resident", output: output("keyed resident ".repeat(256)) },
      undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
    await flushResponseState();
    const spillBefore = spillDirText();
    expect(spillBefore).toContain("keyed spill");
    expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 1 });
    configureAppOwnedMemoryBudget(responseContinuationRetainedStoreSnapshot().bytes);

    scopedRemember("resp-scoped-over-budget", scope, key);

    expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 1 });
    expect(replay("resp-scoped-over-budget", "own-a", key).input).toEqual([]);
    expect(pendingResponseSpillMetricsForTests().count).toBe(0);
    expect(spillDirText()).toBe(spillBefore);
    expect(JSON.stringify(replay("resp-keyed-resident", "own-b", ownerB).input)).toContain("keyed resident");
    expect(JSON.stringify(replay("resp-keyed-spill", "own-b", ownerB).input)).toContain("keyed spill");
    expect(responseStatePersistPendingForTests()).toBe(false);
  } finally {
    restore();
  }
});

test("declined cold scoped admission leaves durable rows unavailable to the process budget sweep", async () => {
  const restore = registerResponseBudget();
  try {
    const durable = output("keyed snapshot payload ".repeat(512));
    rememberResponseState({ input: [] }, { id: "resp-keyed-cold", output: durable }, undefined,
      { clientThreadId: "own-b", replayOwnerKey: ownerB });
    await flushResponseState();
    const snapshotBefore = snapshotText();
    expect(snapshotBefore).toContain("keyed snapshot payload");
    clearResponseStateMemoryForTests();
    configureAppOwnedMemoryBudget(1024);

    const { scope, key } = mintScope();
    scopedRemember("resp-scoped-cold", scope, key);
    enforceAppOwnedMemoryBudget();

    expect(responseStateMetrics()).toMatchObject({ count: 0, totalBytes: 0, spillWrites: 0 });
    expect(pendingResponseSpillMetricsForTests().count).toBe(0);
    expect(responseStatePersistPendingForTests()).toBe(false);
    await flushResponseState();
    expect(snapshotText()).toBe(snapshotBefore);
    expect(spillDirText()).toBe("");
    expect(replay("resp-keyed-cold", "own-b", ownerB).input).toEqual(durable);
    expect(replay("resp-scoped-cold", "own-a", key).input).toEqual([]);
  } finally {
    restore();
  }
});

test("the first scoped response replays after restart with an expired snapshot at the entry cap", () => {
  const at = Date.now();
  const cutoff = at - RESPONSE_TTL_MS;
  const clock = spyOn(Date, "now").mockReturnValue(at);
  try {
    const durable = { createdAt: cutoff, clientThreadId: "own-b", replayOwnerKey: ownerB, items: output("durable") };
    const expired = { ...durable, createdAt: cutoff - 1 };
    writeFileSync(join(getConfigDir(), "responses-state.json"), JSON.stringify({
      version: 2,
      states: [["resp-durable", durable], ...Array.from({ length: 999 }, (_, i) => [`resp-expired-${i}`, expired])],
    }));

    const { scope, key } = mintScope();
    scopedRemember("resp-scoped-after-restart", scope, key, "fresh response");
    const { count } = responseStateMetrics();

    expect(replay("resp-scoped-after-restart", "own-a", key).input).toEqual(output("fresh response"));
    expect(count).toBe(2);
    expect(replay("resp-durable", "own-b", ownerB).input).toEqual(durable.items);
    expect(responseStatePersistPendingForTests()).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

test("the first scoped write leaves durable spill maintenance to the sweep", async () => {
  setResponseStateByteCapForTests(2048);
  rememberResponseState({ input: [] }, { id: "resp-keyed-restart", output: output("durable ".repeat(512)) },
    undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
  await flushResponseState();
  const spillBefore = spillDirText();
  expect(spillBefore).toContain("durable");
  clearResponseStateMemoryForTests();
  setSpilledResponseByteCapForTests(1);

  const { scope, key } = mintScope();
  scopedRemember("resp-scoped-after-restart", scope, key);

  expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 1 });
  expect(spillDirText()).toBe(spillBefore);
  expect(responseStatePersistPendingForTests()).toBe(false);
  sweepExpiredResponseStates();
  expect(spillDirText()).toBe("");
  expect(responseStatePersistPendingForTests()).toBe(true);
});

test("scoped admission reclaims shared process headroom from another scope", () => {
  const restore = registerResponseBudget();
  try {
    const older = mintScope();
    const newer = mintScope();
    scopedRemember("resp-old", older.scope, older.key);
    const initialBytes = responseContinuationRetainedStoreSnapshot().bytes;
    configureAppOwnedMemoryBudget(initialBytes);
    scopedRemember("resp-new", newer.scope, newer.key);

    expect(responseContinuationRetainedStoreSnapshot().bytes).toBe(initialBytes);
    expect(replay("resp-old", "own-a", older.key).input).toEqual([]);
    expect(replay("resp-new", "own-a", newer.key).input).toEqual(output("private synthetic task"));
    expect(responseStatePersistPendingForTests()).toBe(false);
  } finally {
    restore();
  }
});

test("scoped admission applies the socket cap before reclaiming from other scopes", () => {
  const restore = registerResponseBudget();
  try {
    const first = mintScope();
    const second = mintScope();
    scopedRemember("resp-other", first.scope, first.key);
    for (let i = 0; i < MAX_CONNECTION_SCOPE_ENTRIES; i++) {
      scopedRemember(`resp-cap-${i}`, second.scope, second.key, "same");
    }
    configureAppOwnedMemoryBudget(responseContinuationRetainedStoreSnapshot().bytes);
    scopedRemember("resp-cap-64", second.scope, second.key, "x");

    expect(replay("resp-cap-0", "own-a", second.key).input).toEqual([]);
    expect(replay("resp-cap-64", "own-a", second.key).input).toEqual(output("x"));
    expect(replay("resp-other", "own-a", first.key).input).toEqual(output("private synthetic task"));
  } finally {
    restore();
  }
});

test("declined scoped admission preserves planned socket and shared evictions", () => {
  const restore = registerResponseBudget();
  try {
    rememberResponseState({ input: [] }, { id: "resp-keyed", output: output("k".repeat(4096)) }, undefined,
      { clientThreadId: "own-b", replayOwnerKey: ownerB });
    const other = mintScope();
    const incoming = mintScope();
    scopedRemember("resp-other", other.scope, other.key, "other socket");
    for (let i = 0; i < MAX_CONNECTION_SCOPE_ENTRIES; i++) {
      scopedRemember(`resp-cap-${i}`, incoming.scope, incoming.key, `payload-${i}`);
    }
    const before = responseContinuationRetainedStoreSnapshot();
    configureAppOwnedMemoryBudget(before.bytes);

    // The candidate fits alone, but even evicting every scoped entry cannot fit it beside the keyed row.
    scopedRemember("resp-scoped-too-large", incoming.scope, incoming.key, "x".repeat(before.bytes - 1024));

    expect(replay("resp-scoped-too-large", "own-a", incoming.key).input).toEqual([]);
    expect(replay("resp-other", "own-a", other.key).input).toEqual(output("other socket"));
    expect(replay("resp-cap-0", "own-a", incoming.key).input).toEqual(output("payload-0"));
    expect(responseContinuationRetainedStoreSnapshot()).toEqual(before);
  } finally {
    restore();
  }
});

test("process budget eviction prefers a scoped resident over an older keyed resident", () => {
  const restore = registerResponseBudget();
  const at = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(at);
  try {
    rememberResponseState({ input: [] }, { id: "resp-older-keyed", output: output("keyed ".repeat(512)) },
      undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
    const keyedBytes = responseContinuationRetainedStoreSnapshot().bytes;
    clock.mockReturnValue(at + 1);
    const { scope, key } = mintScope();
    scopedRemember("resp-newer-scoped", scope, key);
    configureAppOwnedMemoryBudget(keyedBytes);

    expect(enforceAppOwnedMemoryBudget().retainedBytes).toBe(keyedBytes);
    expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 0 });
    expect(replay("resp-newer-scoped", "own-a", key).input).toEqual([]);
    expect(JSON.stringify(replay("resp-older-keyed", "own-b", ownerB).input)).toContain("keyed");
  } finally {
    clock.mockRestore();
    restore();
  }
});

test("the shared entry cap can prune a legacy empty response id", () => {
  rememberResponseState({ input: [] }, { id: "", output: output("legacy") });
  expect(responseStateMetrics().count).toBe(1);
  for (let i = 0; i < 1000; i++) {
    rememberResponseState({ input: [] }, { id: `resp-legacy-${i}`, output: output("legacy") });
  }
  expect(responseStateMetrics().count).toBe(1000);
  expect(JSON.stringify(replay("resp-legacy-0").input)).toContain("legacy");
});

test("scoped retention refuses an empty response id", () => {
  const { scope, key } = mintScope();
  scopedRemember("", scope, key);
  expect(responseStateMetrics().count).toBe(0);
});

test("scoped retention bounds response IDs by UTF-8 byte length", () => {
  const { scope, key } = mintScope();
  const atLimit = "é".repeat(CODEX_WS_ID_MAX_BYTES / 2);
  scopedRemember(atLimit, scope, key);
  const overLimit = atLimit + "x";
  scopedRemember(overLimit, scope, key);
  expect(replay(overLimit, "own-a", key).input).toEqual([]);
  expect(JSON.stringify(replay(atLimit, "own-a", key).input)).toContain("private synthetic task");
});

test("rejected scoped writes do not use up the retained-entry cap", () => {
  const { scope, key } = mintScope();
  setResponseStateByteCapForTests(2048);
  scopedRemember("resp-kept", scope, key);
  for (let i = 0; i < MAX_CONNECTION_SCOPE_ENTRIES; i++) {
    scopedRemember(`resp-too-large-${i}`, scope, key, "oversized payload ".repeat(256));
  }
  expect(responseStateMetrics().count).toBe(1);
  expect(JSON.stringify(replay("resp-kept", "own-a", key).input)).toContain("private synthetic task");
});

test("eviction frees the scoped slot even when it removes a later insertion", () => {
  const { scope, key } = mintScope();
  const epoch = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(epoch + 1);
  try {
    scopedRemember("resp-kept", scope, key);
    // A clock correction makes later inserts older by timestamp for the app memory budget.
    clock.mockReturnValue(epoch);
    for (let i = 0; i < MAX_CONNECTION_SCOPE_ENTRIES; i++) {
      scopedRemember(`resp-evicted-${i}`, scope, key);
      expect(evictOldestResponseContinuationForBudget()).toBeGreaterThan(0);
    }
    expect(responseStateMetrics().count).toBe(1);
    expect(JSON.stringify(replay("resp-kept", "own-a", key).input)).toContain("private synthetic task");
  } finally {
    clock.mockRestore();
  }
});

test("a live connection scope never reaches the snapshot file", async () => {
  const { scope, key } = mintScope();
  scopedRemember("resp-conn-only", scope, key);
  // Still replayable from memory — only persistence is forbidden.
  expect(JSON.stringify(replay("resp-conn-only", "own-a", key).input)).toContain("private synthetic task");
  await flushResponseState();
  await runPendingResponseStatePersistForTests();
  expect(snapshotText()).not.toContain("resp-conn-only");
  expect(snapshotText()).not.toContain(key);
  expect(snapshotText()).not.toContain("private synthetic task");
});

test("scoped mutations leave the active durable snapshot revision stable", async () => {
  const { scope, key } = mintScope();
  setResponseStateByteCapForTests(2048);
  rememberResponseState({ input: [] }, { id: "resp-durable", output: output("old generation ".repeat(512)) },
    undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
  await flushResponseState();
  rememberResponseState({ input: [] }, { id: "resp-durable", output: output("new generation ".repeat(512)) },
    undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
  await flushPendingResponseSpillsForTests();
  expect(spillDirText()).toContain("old generation");
  expect(spillDirText()).toContain("new generation");
  setResponseStatePersistAttemptHookForTests(() => {
    scopedRemember("resp-while-persisting", scope, key);
    releaseConnectionReplayScope(scope);
  });

  await runPendingResponseStatePersistForTests();

  expect(snapshotText()).toContain("resp-durable");
  expect(snapshotText()).not.toContain("resp-while-persisting");
  expect(responseStatePersistPendingForTests()).toBe(false);
  expect(spillDirText()).not.toContain("old generation");
  expect(spillDirText()).toContain("new generation");
});

test("the expiry sweep schedules persistence only when it prunes durable rows", async () => {
  const at = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(at);
  try {
    const { scope, key } = mintScope();
    scopedRemember("resp-scoped-expiry", scope, key);
    expect(responseStatePersistPendingForTests()).toBe(false);
    clock.mockReturnValue(at + 60_000);
    rememberResponseState({ input: [] }, { id: "resp-durable-expiry", output: output("durable") },
      undefined, { clientThreadId: "own-b", replayOwnerKey: ownerB });
    await runPendingResponseStatePersistForTests();
    const scopedDeadline = at + Math.min(RESPONSE_TTL_MS + 1, CONNECTION_REPLAY_SCOPE_TTL_MS);

    expect(sweepExpiredResponseStates(scopedDeadline)).toBe(1);
    expect(responseStatePersistPendingForTests()).toBe(false);
    expect(sweepExpiredResponseStates(at + 60_000 + RESPONSE_TTL_MS + 1)).toBe(1);
    expect(responseStatePersistPendingForTests()).toBe(true);
    await runPendingResponseStatePersistForTests();
    expect(snapshotText()).not.toContain("resp-durable-expiry");
  } finally {
    clock.mockRestore();
  }
});

test("byte pressure deletes connection-owned state instead of spilling it to disk", async () => {
  const { scope, key } = mintScope();
  // A durable entry that fits under the cap after the connection entry is gone.
  rememberResponseState({ input: [] }, { id: "resp-durable", output: output("durable task") }, undefined,
    { clientThreadId: "own-b", replayOwnerKey: ownerB });
  // The connection entry is the oldest memory-only resident; pruning must delete it
  // outright rather than demoting it through the spill path.
  rememberResponseState({ input: [] }, { id: "resp-conn", output: output("conn payload ".repeat(60)) }, undefined,
    { clientThreadId: "own-a", replayOwnerKey: key, connectionScope: scope });
  setResponseStateByteCapForTests(600);
  rememberResponseState({ input: [] }, { id: "resp-trigger", output: output("trigger") }, undefined,
    { clientThreadId: "own-c", replayOwnerKey: ownerC });
  const gone = { previous_response_id: "resp-conn", input: [] };
  expect(expandPreviousResponseInput(gone, "own-a", key)).toBe(gone);
  await flushResponseState();
  await runPendingResponseStatePersistForTests();
  await flushPendingResponseSpillsForTests();
  // Neither the durable snapshot nor any spill file holds the connection payload or its key.
  expect(snapshotText() + spillDirText()).not.toContain("conn payload");
  expect(snapshotText() + spillDirText()).not.toContain(key);
  // The durable entry's own retention policy is unchanged.
  expect(JSON.stringify(replay("resp-durable", "own-b", ownerB).input)).toContain("durable task");
});

test("an unmeasurable connection write leaves no tombstone and no snapshot trace", async () => {
  const { scope, key } = mintScope();
  // A BigInt item cannot be measured by JSON.stringify: the durable path would install a
  // spill-failed tombstone (persisted id+timestamp); the scoped path must drop silently.
  rememberResponseState({ input: [] }, { id: "resp-unserial", output: [{ type: "message", content: 1n }] }, undefined,
    { clientThreadId: "own-a", replayOwnerKey: key, connectionScope: scope });
  const body = { previous_response_id: "resp-unserial", input: [] };
  expect(expandPreviousResponseInput(body, "own-a", key)).toBe(body);
  expect(previousResponseReplayFailure(body)).toBeUndefined();
  await runPendingResponseStatePersistForTests();
  expect(snapshotText()).not.toContain("resp-unserial");
  // Control: the durable path really does leave a replay-visible tombstone.
  rememberResponseState({ input: [] }, { id: "resp-durable-dead", output: [{ type: "message", content: 2n }] }, undefined,
    { clientThreadId: "own-b", replayOwnerKey: ownerB });
  expect(previousResponseReplayFailure(replay("resp-durable-dead", "own-b", ownerB))?.reason).toBe("spill_failed");
});

test("the pending-spill intake refuses a connection-owned candidate reached directly", async () => {
  const { key } = mintScope();
  const connCandidate: ResidentResponseState = {
    kind: "resident", connectionOwned: true, createdAt: Date.now(),
    clientThreadId: "own-a", replayOwnerKey: key,
    items: [{ type: "message", content: "conn payload" }], sizeBytes: 256,
  };
  queuePendingResponseSpill("resp-direct-queue", connCandidate);
  replaceWithPendingResponseSpill("resp-direct-pending", connCandidate, undefined);
  const foreign: ResidentResponseState = {
    kind: "resident", createdAt: Date.now(),
    clientThreadId: "own-b", replayOwnerKey: ownerB,
    items: [{ type: "message", content: "foreign" }], sizeBytes: 128,
  };
  // A live foreign entry is never displaced by a scoped write.
  expect(replaceWithPendingResponseSpill("resp-foreign-slot", connCandidate, foreign)).toBe(false);
  expect(pendingResponseSpillMetricsForTests().count).toBe(0);
  await flushPendingResponseSpillsForTests();
  await runPendingResponseStatePersistForTests();
  expect(snapshotText() + spillDirText()).not.toContain("conn payload");
});

test("refusing a scoped spill candidate preserves a foreign resident and its pending publication", async () => {
  const { key } = mintScope();
  rememberResponseState({ input: [] }, { id: "resp-foreign-resident", output: output("foreign retained task") }, undefined,
    { clientThreadId: "own-b", replayOwnerKey: ownerB });
  const foreign: ResidentResponseState = {
    kind: "resident", createdAt: Date.now(), clientThreadId: "own-b", replayOwnerKey: ownerB,
    items: output("foreign queued task"), sizeBytes: 256,
  };
  queuePendingResponseSpill("resp-foreign-resident", foreign);
  const before = pendingResponseSpillMetricsForTests();
  const candidate: ResidentResponseState = {
    kind: "resident", connectionOwned: true, createdAt: Date.now(),
    clientThreadId: "own-a", replayOwnerKey: key, items: output("connection payload"), sizeBytes: 256,
  };
  queuePendingResponseSpill("resp-foreign-resident", candidate);
  expect(pendingResponseSpillMetricsForTests()).toEqual(before);
  expect(JSON.stringify(replay("resp-foreign-resident", "own-b", ownerB).input)).toContain("foreign retained task");
  await flushPendingResponseSpillsForTests();
  expect(JSON.stringify(replay("resp-foreign-resident", "own-b", ownerB).input)).toContain("foreign retained task");
  expect(snapshotText() + spillDirText()).not.toContain("connection payload");
});

test("a superseded foreign publication for the same id cannot pull a scoped write to disk", async () => {
  const { key } = mintScope();
  const foreignCandidate: ResidentResponseState = {
    kind: "resident", createdAt: Date.now(),
    clientThreadId: "own-b", replayOwnerKey: ownerB,
    items: [{ type: "message", content: "foreign durable payload" }], sizeBytes: 256,
  };
  // The off-invariant window the sink must survive: a foreign pending publication still
  // exists for the id while the scoped write lands on the same slot.
  queuePendingResponseSpill("resp-shared", foreignCandidate);
  expect(pendingResponseSpillMetricsForTests().count).toBeGreaterThan(0);
  const connCandidate: ResidentResponseState = {
    kind: "resident", connectionOwned: true, createdAt: Date.now(),
    clientThreadId: "own-a", replayOwnerKey: key,
    items: [{ type: "message", content: "conn payload" }], sizeBytes: 256,
  };
  // The scoped candidate lands resident and is never queued behind the foreign job.
  expect(replaceWithPendingResponseSpill("resp-shared", connCandidate, undefined)).toBe(true);
  const pending = pendingResponseSpillMetricsForTests();
  queuePendingResponseSpill("resp-shared", connCandidate);
  expect(pendingResponseSpillMetricsForTests()).toEqual(pending);
  await flushPendingResponseSpillsForTests();
  await runPendingResponseStatePersistForTests();
  const disk = snapshotText() + spillDirText();
  expect(disk).not.toContain("conn payload");
  expect(disk).not.toContain(key);
  // The connection entry remains replayable from memory — memory-only, not deleted.
  expect(JSON.stringify(replay("resp-shared", "own-a", key).input)).toContain("conn payload");
});

test("a non-persistable body stays unstored even inside a live scope", () => {
  const { scope, key } = mintScope();
  const request = { input: [] } as Record<string, unknown>;
  markBodyNonPersistable(request);
  rememberResponseState(request, { id: "resp-secret", output: output("encrypted recovery material") }, undefined,
    { clientThreadId: "own-a", replayOwnerKey: key, connectionScope: scope });
  const body = { previous_response_id: "resp-secret", input: [] };
  expect(expandPreviousResponseInput(body, "own-a", key)).toBe(body);
});

test("legacy callers without a key still cannot read a bound connection entry", () => {
  const { scope, key } = mintScope();
  scopedRemember("resp-bound", scope, key);
  expect(previousResponseReplayFailure(replay("resp-bound", "own-a", undefined))?.reason).toBe("scope_mismatch");
  clearResponseStateMemoryForTests();
  const body = { previous_response_id: "resp-bound", input: [] };
  expect(expandPreviousResponseInput(body, "own-a", key)).toBe(body);
});

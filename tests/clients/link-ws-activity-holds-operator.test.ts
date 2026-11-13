import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Lane T5d3a: the operator's view and clear of link WebSocket activity holds (design T4 section 5, owner decision D8).

const LINKS = ["lnk_aaaaaaaaaaaaaaaa", "lnk_bbbbbbbbbbbbbbbb"];
const [A, B] = LINKS as [string, string];
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-link-holds-op-")); });
afterEach(() => { if (dir) removeTreeWithRetry(dir); dir = ""; });

type Deps = Parameters<typeof createActivityHolds>[0];
function store(overrides: Partial<Deps> = {}) {
  const holds = createActivityHolds({ dir, linkIds: () => LINKS, limits: LINK_WS_LIMITS, now: () => 1_800_000_000_000, ...overrides });
  holds.start();
  return holds;
}
const persisted = () => JSON.parse(readFileSync(join(dir, "activity-holds.json"), "utf8")) as { links: Record<string, unknown> };

describe("summary: what the operator sees", () => {
  test("a link without holds has no summary", () => {
    expect(store().summary(A)).toBeNull();
  });

  test("each hold names its reasons and counts, and nothing hashed leaves the store", () => {
    const holds = store();
    holds.arm();
    const thread = holds.threadHash("thread-a");
    holds.add(A, { threadHash: thread, pendingKeys: ["k1", "k2"], runningMarks: 0, untracked: false });
    holds.add(A, { threadHash: thread, pendingKeys: [], runningMarks: 1, marks: [{ n: 2, inputHmac: "h", turnRef: "t" }], untracked: false });
    holds.add(A, { threadHash: null, pendingKeys: ["k3"], runningMarks: 0, untracked: true });
    const summary = holds.summary(A)!;
    expect(summary.unknown).toBeNull();
    expect(summary.holds).toEqual([
      { since: 1_800_000_000_000, reasons: ["pending-results"], pendingResults: 2, runningTurns: 0, runningUnknown: 0 },
      { since: 1_800_000_000_000, reasons: ["running-turn", "running-unknown"], pendingResults: 0, runningTurns: 1, runningUnknown: 1 },
      { since: 1_800_000_000_000, reasons: ["pending-results", "untracked", "no-thread"], pendingResults: 1, runningTurns: 0, runningUnknown: 0 },
    ]);
    expect(JSON.stringify(summary)).not.toContain(thread);
  });

  test("an unknown link names its reason", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    expect(store().summary(B)).toEqual({ holds: [], unknown: "crash" });
  });
});

describe("clear (D8)", () => {
  test("clears one link durably and leaves the other", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    const holds = store();
    expect(holds.clear(A)).toEqual({ ok: true, cleared: { holds: [], unknown: "crash" } });
    expect(holds.count(A)).toBe(0);
    expect(holds.count(B)).toBe(1);
    expect(Object.keys(persisted().links)).toEqual([B]);
    expect(store().count(A)).toBe(0);
  });

  test("a failed write clears nothing: the holds stay in memory and on disk", () => {
    let fail = false;
    const holds = store({ writeHooks: { beforeRename(_t, target) { if (fail && target.endsWith("activity-holds.json")) throw new Error("EIO"); } } });
    holds.arm();
    holds.add(A, { threadHash: null, pendingKeys: ["k1"], runningMarks: 0, untracked: true });
    fail = true;
    expect(holds.clear(A)).toEqual({ ok: false, reason: "write-failed" });
    expect(holds.count(A)).toBe(1);
    expect(Object.keys(persisted().links)).toEqual([A]);
  });

  test("after a recovery that could not list the links, clearing one link works once they can be listed", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    let readable = false;
    const holds = store({ linkIds: () => (readable ? LINKS : null) });
    expect(holds.count(A)).toBe(1);
    expect(holds.clear(A)).toEqual({ ok: false, reason: "links-unreadable" });
    expect(holds.count(A)).toBe(1);
    readable = true;
    expect(holds.clear(A)).toEqual({ ok: true, cleared: { holds: [], unknown: "crash" } });
    expect(holds.count(A)).toBe(0);
    expect(holds.count(B)).toBe(1);
    expect(store().summary(B)).toEqual({ holds: [], unknown: "crash" });
    // The cleared link stays clear across a fresh start; the other link stays held (T5d3a-R1-02).
    const fresh = store();
    expect(fresh.count(A)).toBe(0);
    expect(fresh.count(B)).toBe(1);
  });

  const clearWhoseDirectorySyncFails = () => {
    const first = store();
    first.arm();
    first.add(A, { threadHash: null, pendingKeys: ["k1"], runningMarks: 0, untracked: true });
    expect(first.stop()).toBe(true);
    // A graceful restart: the fence is clean and the hold was loaded from disk.
    // The clear's write lands and then its directory sync fails; the best-effort restore then fails before its rename.
    let renamedHolds = false;
    let holdWrites = 0;
    const holds = store({ writeHooks: {
      beforeRename(_t, target) { if (target.endsWith("activity-holds.json") && ++holdWrites > 1) throw new Error("EIO"); },
      afterRename(target) { if (target.endsWith("activity-holds.json")) renamedHolds = true; },
      syncDir() { if (renamedHolds) { renamedHolds = false; throw new Error("EIO on directory fsync"); } },
    } });
    expect(holds.count(A)).toBe(1);
    expect(holds.clear(A)).toEqual({ ok: false, reason: "write-failed" });
    expect(holds.count(A)).toBe(1);
    // The process dies here: the next start must not see the link as idle.
    expect(store().count(A)).toBeGreaterThan(0);
  };

  test("a clear whose directory sync fails after the rename keeps the link held across a restart (T5d3a-R1-01)", clearWhoseDirectorySyncFails);

  test("the same failure is injected where no directory is synced (Windows), so the seam runs on every platform", () => {
    // durableWrite skips the real chmod and directory fsync on win32; the durability seam must still run there.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try { clearWhoseDirectorySyncFails(); } finally { Object.defineProperty(process, "platform", platform); }
  });

  test("the same failure while link sockets have run in this process keeps the link held too (fence already running)", () => {
    let failing = false;
    const holds = store({ writeHooks: { beforeRename(_t, target) { if (failing && target.endsWith("activity-holds.json")) throw new Error("EIO"); } } });
    holds.arm();
    holds.add(A, { threadHash: null, pendingKeys: ["k1"], runningMarks: 0, untracked: true });
    failing = true;
    expect(holds.clear(A)).toEqual({ ok: false, reason: "write-failed" });
    expect(holds.count(A)).toBe(1);
    expect(store().count(A)).toBeGreaterThan(0);
  });

  test("a successful clear after a graceful restart leaves the fence clean, so other links are not marked unknown", () => {
    const first = store();
    first.arm();
    first.add(A, { threadHash: null, pendingKeys: ["k1"], runningMarks: 0, untracked: true });
    first.add(B, { threadHash: null, pendingKeys: ["k2"], runningMarks: 0, untracked: true });
    expect(first.stop()).toBe(true);
    expect(store().clear(A)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "clean" });
    const fresh = store();
    expect(fresh.count(A)).toBe(0);
    expect(fresh.summary(B)).toMatchObject({ unknown: null });
  });

  // T5d3a-R2-01: the durable holds write is the commit point. Whatever then happens to the clean-fence write, the
  // answer matches what a fresh start (or a crash at that boundary) sees.
  const gracefulPair = () => {
    const first = store();
    first.arm();
    first.add(A, { threadHash: null, pendingKeys: ["k1"], runningMarks: 0, untracked: true });
    first.add(B, { threadHash: null, pendingKeys: ["k2"], runningMarks: 0, untracked: true });
    expect(first.stop()).toBe(true);
  };

  test("the clean fence lands but its directory sync fails, and a holds restore would fail: the clear is committed and stays so (T5d3a-R2-01)", () => {
    gracefulPair();
    let fenceWrites = 0;
    let renamedClean = false;
    let holdWrites = 0;
    const holds = store({ writeHooks: {
      beforeRename(_t, target) { if (target.endsWith("activity-holds.json") && ++holdWrites > 1) throw new Error("EIO"); },
      afterRename(target) { if (target.endsWith("ws-run-state.json") && ++fenceWrites === 2) renamedClean = true; },
      syncDir() { if (renamedClean) { renamedClean = false; throw new Error("EIO on directory fsync"); } },
    } });
    expect(holds.clear(A)).toMatchObject({ ok: true });
    expect(holds.count(A)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "clean" });
    const fresh = store();
    expect(fresh.count(A)).toBe(0);
    expect(fresh.count(B)).toBe(1);
  });

  test("the clean fence fails before its rename (or the process dies there): the fence stays running and the next start keeps every link held", () => {
    gracefulPair();
    let fenceWrites = 0;
    const holds = store({ writeHooks: { beforeRename(_t, target) { if (target.endsWith("ws-run-state.json") && ++fenceWrites === 2) throw new Error("EIO"); } } });
    expect(holds.clear(A)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "running" });
    const fresh = store();
    expect(fresh.count(A)).toBeGreaterThan(0);
    expect(fresh.count(B)).toBeGreaterThan(0);
  });

  test("clearing a link without holds is a no-op success that writes nothing", () => {
    const holds = store();
    expect(holds.clear(A)).toEqual({ ok: true, cleared: null });
  });
});

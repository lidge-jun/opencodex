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
  });

  test("clearing a link without holds is a no-op success that writes nothing", () => {
    const holds = store();
    expect(holds.clear(A)).toEqual({ ok: true, cleared: null });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

// Lane T5d1: durable activity holds and the crash fence for Remote Link WebSockets (design T4 section 5).

const LINKS = ["lnk_aaaaaaaaaaaaaaaa", "lnk_bbbbbbbbbbbbbbbb"];
const [A, B] = LINKS as [string, string];
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-link-holds-")); });
afterEach(() => { if (dir) removeTreeWithRetry(dir); dir = ""; });

function store(overrides: Partial<Parameters<typeof createActivityHolds>[0]> = {}) {
  const holds = createActivityHolds({ dir, linkIds: () => LINKS, ...overrides });
  holds.start();
  return holds;
}

const hold = (holds: ReturnType<typeof store>, thread = "thread-a", keys = ["k1", "k2"], extra: { runningMarks?: number; untracked?: boolean; threadHash?: string | null } = {}) => ({
  threadHash: extra.threadHash === undefined ? holds.threadHash(thread) : extra.threadHash, pendingKeys: keys, runningMarks: extra.runningMarks ?? 0, untracked: extra.untracked ?? false,
});

describe("fence and inertness", () => {
  test("a Home that never armed the fence reads and writes nothing", () => {
    const holds = store();
    expect(holds.count(A)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("arm writes running, a graceful stop writes clean, and the next start has no holds", () => {
    const holds = store();
    expect(holds.arm()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "running" });
    expect(holds.stop()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "clean" });
    expect(store().count(A)).toBe(0);
  });

  test("a failed fence write refuses arming and leaves no fence", () => {
    const holds = store({ writeHooks: { beforeRename(_t, target) { if (target.endsWith("ws-run-state.json")) throw new Error("disk full"); } } });
    expect(holds.arm()).toBe(false);
    expect(existsSync(join(dir, "ws-run-state.json"))).toBe(false);
  });

  test("a running or unreadable fence at start makes every link unknown, even with an older valid idle holds file", () => {
    for (const fence of ['{"version":1,"state":"running"}', "not json"]) {
      writeFileSync(join(dir, "activity-holds.json"), JSON.stringify({ version: 1, keyId: null, links: {} }));
      writeFileSync(join(dir, "ws-run-state.json"), fence);
      const holds = store();
      expect(LINKS.map(link => holds.describe(link).unknown)).toEqual(["crash", "crash"]);
      expect(holds.count(A)).toBe(1);
    }
  });

  test("crash evidence is persisted and the fence cleaned, so unknown holds survive a later clean restart until cleared", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    store();
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "clean" });
    const again = store();
    expect(again.describe(B).unknown).toBe("crash");
    expect(again.clear(B)).toBe(true);
    expect(store().count(B)).toBe(0);
    expect(store().describe(A).unknown).toBe("crash");
  });

  test("a corrupt holds file with a clean fence makes every link unknown", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"clean"}');
    writeFileSync(join(dir, "activity-holds.json"), "{broken");
    const holds = store();
    expect(LINKS.map(link => holds.describe(link).unknown)).toEqual(["unreadable", "unreadable"]);
  });
});

describe("holds", () => {
  test("a hold survives a graceful restart and counts in flight", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds));
    expect(holds.count(A)).toBe(1);
    expect(holds.count(B)).toBe(0);
    holds.stop();
    expect(store().count(A)).toBe(1);
  });

  test("returning every pending result on the same own thread releases it; a sibling thread or a partial return does not", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds));
    holds.observe(A, holds.threadHash("thread-b"), ["k1", "k2"]);
    expect(holds.count(A)).toBe(1);
    holds.observe(B, holds.threadHash("thread-a"), ["k1", "k2"]);
    expect(holds.count(A)).toBe(1);
    holds.observe(A, holds.threadHash("thread-a"), ["k1"]);
    expect(holds.count(A)).toBe(1);
    holds.observe(A, holds.threadHash("thread-a"), ["k2"]);
    expect(holds.count(A)).toBe(0);
  });

  test("untracked, unkeyed or running-marked holds need the operator", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds, "thread-a", ["k1"], { untracked: true }));
    holds.add(A, hold(holds, "thread-a", ["k1"], { threadHash: null }));
    holds.add(A, hold(holds, "thread-a", ["k1"], { runningMarks: 1 }));
    holds.observe(A, holds.threadHash("thread-a"), ["k1"]);
    expect(holds.count(A)).toBe(3);
    expect(holds.clear(A)).toBe(true);
    expect(holds.count(A)).toBe(0);
  });

  test("a failed hold write keeps the hold in memory and marks the link unknown; stop does not write clean", () => {
    let fail = false;
    const holds = store({ writeHooks: { beforeRename(_t, target) { if (fail && target.endsWith("activity-holds.json")) throw new Error("EIO"); } } });
    holds.arm();
    fail = true;
    holds.add(A, hold(holds));
    expect(holds.count(A)).toBe(2);
    expect(holds.describe(A).unknown).toBe("write-failed");
    expect(holds.stop()).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "running" });
  });

  test("overflow marks the link unknown instead of dropping a hold", () => {
    const holds = store();
    holds.arm();
    for (let index = 0; index <= LINK_WS_LIMITS.holdsPerLink; index += 1) holds.add(A, hold(holds, "thread-" + index));
    expect(holds.describe(A).unknown).toBe("overflow");
    expect(holds.describe(A).holds).toBe(LINK_WS_LIMITS.holdsPerLink);
  });

  test("replacing the reference key turns keyed holds into an unknown hold", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds));
    holds.stop();
    writeFileSync(join(dir, "activity-ref-key"), "f".repeat(64));
    const again = store();
    expect(again.describe(A)).toEqual({ holds: 0, unknown: "key-rotated" });
  });

  test("removing a link deletes its holds", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds));
    holds.removeLink(A);
    expect(holds.count(A)).toBe(0);
    holds.stop();
    expect(store().count(A)).toBe(0);
  });
});

describe("crash points (SIGKILL)", () => {
  test.each([
    ["during the fence write", "during-fence-write", null],
    ["after the fence write", "after-fence-write", "crash"],
    ["during a hold write", "during-hold-write", "crash"],
    ["after the holds write, before clean", "after-holds-before-clean", "crash"],
  ] as const)("killed %s, the Home comes back as the design requires", async (_label, point, expected) => {
    writeFileSync(join(dir, "activity-holds.json"), JSON.stringify({ version: 1, keyId: null, links: {} }));
    const child = Bun.spawn(["bun", repoPath("tests/fixtures/link-ws-holds-crash.ts")], { cwd: repoPath(), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write(JSON.stringify({ dir, point, links: LINKS }));
    child.stdin.end();
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const holds = store();
    // Killed before the fence landed, no link upgrade could have been admitted, so nothing was in flight.
    expect(LINKS.map(link => holds.describe(link).unknown)).toEqual([expected, expected]);
  });
});


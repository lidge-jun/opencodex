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
  const holds = createActivityHolds({ dir, linkIds: () => LINKS, limits: LINK_WS_LIMITS, ...overrides });
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
    expect(again.clear(B).ok).toBe(true);
    expect(store().count(B)).toBe(0);
    expect(store().describe(A).unknown).toBe("crash");
  });

  test("a start that cannot persist the crash evidence leaves the fence running, so the next start still sees it", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    const failing = store({ writeHooks: { beforeRename(_t, target) { if (target.endsWith("activity-holds.json")) throw new Error("EIO"); } } });
    expect(failing.describe(A).unknown).toBe("crash");
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "running" });
    expect(store().describe(B).unknown).toBe("crash");
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
    holds.observe(A, holds.threadHash("thread-b"), ["k1", "k2"], holds.sequence());
    expect(holds.count(A)).toBe(1);
    holds.observe(B, holds.threadHash("thread-a"), ["k1", "k2"], holds.sequence());
    expect(holds.count(A)).toBe(1);
    holds.observe(A, holds.threadHash("thread-a"), ["k1"], holds.sequence());
    expect(holds.count(A)).toBe(1);
    holds.observe(A, holds.threadHash("thread-a"), ["k2"], holds.sequence());
    expect(holds.count(A)).toBe(0);
  });

  test("untracked, unkeyed or running-marked holds need the operator", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds, "thread-a", ["k1"], { untracked: true }));
    holds.add(A, hold(holds, "thread-a", ["k1"], { threadHash: null }));
    holds.add(A, hold(holds, "thread-a", ["k1"], { runningMarks: 1 }));
    holds.observe(A, holds.threadHash("thread-a"), ["k1"], holds.sequence());
    expect(holds.count(A)).toBe(3);
    expect(holds.clear(A).ok).toBe(true);
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

describe("crash points (abrupt termination)", () => {
  test.each([
    ["during the fence write", "during-fence-write", null],
    ["after the fence write", "after-fence-write", "crash"],
    ["during a hold write", "during-hold-write", "crash"],
    ["after the holds write, before clean", "after-holds-before-clean", "crash"],
  ] as const)("killed %s, the Home comes back as the design requires", async (_label, point, expected) => {
    writeFileSync(join(dir, "activity-holds.json"), JSON.stringify({ version: 1, keyId: null, links: {} }));
    const child = Bun.spawn(["bun", repoPath("tests/fixtures/link-ws-holds-crash.ts")], { cwd: repoPath(), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    child.stdin.write(JSON.stringify({ dir, point, links: LINKS }));
    child.stdin.end();
    const [exitCode, reached] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // Exactly the point and nothing after it: the fixture's exit handler (an orderly exit) never ran.
    expect(reached).toBe(point);
    // Windows has no signals: the same kill is TerminateProcess, reported as a nonzero exit code.
    if (process.platform === "win32") { expect(child.signalCode).toBeNull(); expect(exitCode).not.toBe(0); }
    else expect(child.signalCode).toBe("SIGKILL");
    const holds = store();
    // Killed before the fence landed, no link upgrade could have been admitted, so nothing was in flight.
    expect(LINKS.map(link => holds.describe(link).unknown)).toEqual([expected, expected]);
  });
});

describe("review round 1 (T5d1-R1-01, -02, -04)", () => {
  test("a directory sync that fails makes arming fail and stop report failure", () => {
    let failSync = false;
    const holds = store({ writeHooks: { syncDir() { if (failSync) throw new Error("EIO on directory fsync"); } } });
    failSync = true;
    expect(holds.arm()).toBe(false);
    failSync = false;
    expect(holds.arm()).toBe(true);
    holds.add(A, hold(holds));
    failSync = true;
    expect(holds.stop()).toBe(false);
  });

  test("crash recovery that cannot list the links keeps every link unknown and the fence running", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    const blind = createActivityHolds({ dir, linkIds: () => null, limits: LINK_WS_LIMITS });
    blind.start();
    expect(blind.count(A)).toBe(1);
    expect(blind.count("lnk_cccccccccccccccc")).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "running" });
    expect(store().describe(A).unknown).toBe("crash");
  });

  test("a reference key that cannot be loaded or replaced does not fail startup; the links stay unknown and the fence running", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"clean"}');
    writeFileSync(join(dir, "activity-holds.json"), JSON.stringify({ version: 1, keyId: "0123456789abcdef", links: { [A]: { holds: [{ threadHash: "aa", pendingKeys: ["k"], runningMarks: 0, untracked: false, createdAt: 1 }], unknown: null } } }));
    const holds = createActivityHolds({ dir, linkIds: () => LINKS, limits: LINK_WS_LIMITS, writeHooks: { beforeRename(_t, target) { if (target.endsWith("activity-ref-key")) throw new Error("EROFS"); } } });
    expect(() => holds.start()).not.toThrow();
    expect(holds.describe(A).unknown).toBe("key-unavailable");
    expect(holds.count(B)).toBe(1);
  });

  test("a stored hold without a marks field, kept while the reference key is unavailable, is read by the status paths without throwing (#8607)", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"clean"}');
    writeFileSync(join(dir, "activity-holds.json"), JSON.stringify({ version: 1, keyId: "0123456789abcdef", links: { [A]: { holds: [{ threadHash: null, pendingKeys: [], runningMarks: 1, untracked: false, createdAt: 1 }], unknown: null } } }));
    const holds = createActivityHolds({ dir, linkIds: () => LINKS, limits: LINK_WS_LIMITS, writeHooks: { beforeRename(_t, target) { if (target.endsWith("activity-ref-key")) throw new Error("EROFS"); } } });
    holds.start();
    expect(holds.describe(A).unknown).toBe("key-unavailable");
    expect(() => holds.summary(A)).not.toThrow();
    expect(holds.summary(A)?.holds).toHaveLength(1);
    expect(holds.hasMarks(A)).toBe(false);
    expect(holds.count(A)).toBeGreaterThan(0);
  });

});

describe("review round 2 (T5d1-R2-01)", () => {
  test("an all-links unknown state survives arm and a graceful stop; a readable restart still sees every link unknown", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    let readable = false;
    const holds = createActivityHolds({ dir, linkIds: () => (readable ? LINKS : null), limits: LINK_WS_LIMITS });
    holds.start();
    expect(holds.arm()).toBe(true);
    holds.stop();
    readable = true;
    const again = store();
    expect(LINKS.map(link => again.describe(link).unknown)).toEqual(["crash", "crash"]);
  });

  test("a graceful stop that can list the links again writes them unknown and then cleans", () => {
    writeFileSync(join(dir, "ws-run-state.json"), '{"version":1,"state":"running"}');
    let readable = false;
    const holds = createActivityHolds({ dir, linkIds: () => (readable ? LINKS : null), limits: LINK_WS_LIMITS });
    holds.start();
    holds.arm();
    readable = true;
    expect(holds.stop()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "ws-run-state.json"), "utf8"))).toMatchObject({ state: "clean" });
    expect(store().describe(A).unknown).toBe("crash");
  });
});
describe("T5g: a request settles only holds that existed when it began (final review area b, finding 1)", () => {
  test("a newer hold with a reused result key survives the late acceptance of an older request", () => {
    const holds = store();
    holds.arm();
    holds.add(A, hold(holds, "thread-a", ["k-reused"]));
    const began = holds.sequence();
    // Another socket of the same thread is cut later, waiting for a new call that reuses the id.
    holds.add(A, hold(holds, "thread-a", ["k-reused"]));
    holds.observe(A, holds.threadHash("thread-a"), ["k-reused"], began);
    expect(holds.count(A)).toBe(1);
    // A request that began after both may settle the newer one.
    holds.observe(A, holds.threadHash("thread-a"), ["k-reused"], holds.sequence());
    expect(holds.count(A)).toBe(0);
  });
});
describe("T5g: a write that fails before the rename leaves no temporary file (final review area b, P3)", () => {
  test("the temporary file is removed when the content write or its fsync throws", () => {
    const holds = store({ writeHooks: { afterOpen() { throw new Error("ENOSPC"); } } });
    expect(holds.arm()).toBe(false);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});
describe("T5g: request-log refs are not comparable across links (final review area c, note)", () => {
  test("the same thread id gives different refs on two links, and the same ref on one link", () => {
    const holds = store();
    expect(holds.logRef("thread", A, "thread-x")).not.toBe(holds.logRef("thread", B, "thread-x"));
    expect(holds.logRef("thread", A, "thread-x")).toBe(holds.logRef("thread", A, "thread-x"));
    expect(holds.logRef("thread", A, "thread-x")).not.toBe(holds.logRef("thread", A, "thread-y"));
    expect(holds.logRef("turn", A, "turn-1")).not.toBe(holds.logRef("turn", B, "turn-1"));
    // The link id and the id are separate fields, so no pair of them can collide by concatenation.
    expect(holds.logRef("thread", A, "x")).not.toBe(holds.logRef("thread", A + "x", ""));
  });
});

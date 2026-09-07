import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResetCreditAutoRedeemer,
  planAutoRedeem,
  resolveResetCreditAutoRedeemSettings,
  type ResetCredit,
} from "../../src/codex/reset-credit-auto-redeem";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { readConfigGeneration } from "../../src/config";

const T0 = Date.parse("2026-09-02T10:00:00Z");
const MIN = 60_000;
const credit = (expiresInMin: number, grantedAt = "2026-09-01T00:00:00Z"): ResetCredit => ({
  granted_at: grantedAt,
  expires_at: new Date(T0 + expiresInMin * MIN).toISOString(),
});

/** Fake clock + manual timer: fire() runs the pending timer at its due time. */
function harness(opts: { credits: () => ResetCredit[]; enabled?: () => boolean; lead?: number; journalFile: string; accountId?: string; consumeCode?: string; consumeThrows?: boolean; consume?: (id: string) => Promise<{ code: string }> }) {
  let now = T0;
  let pending: { fn: () => void; at: number } | null = null;
  const consumed: string[] = [];
  const logs: string[] = [];
  let inspects = 0;
  const redeemer = createResetCreditAutoRedeemer({
    accountId: opts.accountId ?? "acct-main",
    settings: () => ({ enabled: opts.enabled ? opts.enabled() : true, leadTimeMinutes: opts.lead ?? 10 }),
    inspect: async () => { inspects += 1; return { credits: opts.credits() }; },
    consume: async id => {
      if (opts.consumeThrows) throw new Error("socket hangup");
      consumed.push(id);
      if (opts.consume) return opts.consume(id);
      return { code: opts.consumeCode ?? "reset" };
    },
    now: () => now,
    setTimer: (fn, ms) => { pending = { fn, at: now + ms }; return 1; },
    clearTimer: () => { pending = null; },
    journalFile: opts.journalFile,
    log: line => logs.push(line),
  });
  return {
    redeemer, consumed, logs,
    inspects: () => inspects,
    pendingAt: () => pending?.at ?? null,
    advanceAndFire: async () => { if (!pending) throw new Error("no timer"); now = pending.at; const fn = pending.fn; pending = null; fn(); await new Promise(r => setTimeout(r, 5)); },
    setNow: (t: number) => { now = t; },
  };
}

let dir = "";
let oldHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-auto-redeem-"));
  oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = dir;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(dir);
});

describe("reset-credit auto-redeem settings + plan (#822)", () => {
  test("default off; malformed reads as off; lead time clamped", () => {
    expect(resolveResetCreditAutoRedeemSettings({}).enabled).toBe(false);
    expect(resolveResetCreditAutoRedeemSettings({ resetCreditAutoRedeem: { enabled: false, leadTimeMinutes: 5 } }).enabled).toBe(false);
    expect(resolveResetCreditAutoRedeemSettings({ resetCreditAutoRedeem: { enabled: true } })).toEqual({ enabled: true, leadTimeMinutes: 10 });
    expect(resolveResetCreditAutoRedeemSettings({ resetCreditAutoRedeem: { enabled: true, leadTimeMinutes: 500 } }).leadTimeMinutes).toBe(60);
  });

  test("plans the soonest future credit and ignores unparseable or expired ones", () => {
    const settings = { enabled: true, leadTimeMinutes: 10 };
    expect(planAutoRedeem(T0, [], settings)).toBeNull();
    expect(planAutoRedeem(T0, [{ granted_at: "x", expires_at: "not a date" }, credit(-5)], settings)).toBeNull();
    const plan = planAutoRedeem(T0, [credit(120), credit(30, "2026-08-31T00:00:00Z"), credit(60)], settings)!;
    expect(plan.grantedAt).toBe("2026-08-31T00:00:00Z");
    expect(plan.dueAt).toBe(T0 + 20 * MIN);
    expect(planAutoRedeem(T0, [credit(30)], { enabled: false, leadTimeMinutes: 10 })).toBeNull();
  });
});

describe("reset-credit auto-redeemer runtime (#822)", () => {
  test("schedules at expiry minus lead, re-reads before dispatch, journals the request id first", async () => {
    const journalFile = join(dir, "j.json");
    const h = harness({ credits: () => [credit(30)], journalFile });
    expect(await h.redeemer.tick()).toEqual({ kind: "scheduled", dueAt: T0 + 20 * MIN });
    // Sleeps are capped at 15 min so a laptop sleep re-checks instead of trusting a stale plan.
    expect(h.pendingAt()).toBe(T0 + 15 * MIN);
    expect(h.consumed).toHaveLength(0);
    await h.advanceAndFire();
    expect(h.consumed).toHaveLength(0);
    expect(h.pendingAt()).toBe(T0 + 20 * MIN);
    await h.advanceAndFire();
    expect(h.consumed).toHaveLength(1);
    // initial + intermediate re-check + (plan + pre-dispatch re-read) on the due tick
    expect(h.inspects()).toBe(4);
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: Array<{ redeemRequestId: string; state: string }> };
    expect(journal.entries[0]!.redeemRequestId).toBe(h.consumed[0]!);
    expect(journal.entries[0]!.state).toBe("settled");
    expect(h.logs.join("\n")).not.toContain("acct-main");
  });

  test("a credit redeemed by hand (gone on refresh) is skipped without a consume", async () => {
    const journalFile = join(dir, "j.json");
    let list = [credit(30)];
    const h = harness({ credits: () => list, journalFile });
    await h.redeemer.tick();
    list = [];
    h.setNow(T0 + 20 * MIN);
    // With the credit gone the plan is empty: nothing to protect, and nothing consumed.
    expect(await h.redeemer.tick()).toEqual({ kind: "nothing-to-protect" });
    expect(h.consumed).toHaveLength(0);
  });

  test("disabling before dispatch skips; a different credit identity is not redeemed with the old plan", async () => {
    const journalFile = join(dir, "j.json");
    let enabled = true;
    let list = [credit(30)];
    const h = harness({ credits: () => list, enabled: () => enabled, journalFile });
    await h.redeemer.tick();
    enabled = false;
    h.setNow(T0 + 20 * MIN);
    expect(await h.redeemer.tick()).toEqual({ kind: "disabled" });
    enabled = true;
    // Replaced by a later credit: nothing is due yet, so no consume.
    list = [credit(300, "2026-09-02T09:00:00Z")];
    expect((await h.redeemer.tick()).kind).toBe("scheduled");
    expect(h.consumed).toHaveLength(0);
  });

  test("an uncertain consume keeps the same request id across a simulated restart", async () => {
    const journalFile = join(dir, "j.json");
    const crashy = harness({ credits: () => [credit(30)], journalFile, consumeThrows: true });
    crashy.setNow(T0 + 20 * MIN);
    const first = await crashy.redeemer.tick();
    expect(first.kind).toBe("ambiguous");
    const id = (first as { redeemRequestId: string }).redeemRequestId;
    expect(JSON.parse(readFileSync(journalFile, "utf8")).entries[0].state).toBe("dispatched");

    // New process, same journal: the replay reuses the journaled id and settles it.
    const resumed = harness({ credits: () => [credit(30)], journalFile, consumeCode: "already_redeemed" });
    resumed.setNow(T0 + 21 * MIN);
    const second = await resumed.redeemer.tick();
    expect(second).toEqual({ kind: "dispatched", code: "already_redeemed", redeemRequestId: id });
    expect(resumed.consumed).toEqual([id]);

    // Settled: a third tick with the credit still listed does not spend again.
    expect(await resumed.redeemer.tick()).toEqual({ kind: "skipped", reason: "credit-gone" });
    expect(resumed.consumed).toEqual([id]);
  });

  test("a manual redeem racing between the planning read and the pre-dispatch read is caught", async () => {
    const journalFile = join(dir, "j.json");
    let reads = 0;
    const h = harness({ credits: () => { reads += 1; return reads === 1 ? [credit(30)] : []; }, journalFile });
    h.setNow(T0 + 20 * MIN);
    expect(await h.redeemer.tick()).toEqual({ kind: "skipped", reason: "credit-gone" });
    expect(h.consumed).toHaveLength(0);
  });

  test("settling a delayed consume preserves a peer's settled journal entry", async () => {
    const journalFile = join(dir, "j.json");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a = harness({ credits: () => [credit(30)], journalFile, accountId: "acct-a", consume: async () => {
      entered();
      await gate;
      return { code: "reset" };
    } });
    const b = harness({ credits: () => [credit(30)], journalFile, accountId: "acct-b" });
    a.setNow(T0 + 20 * MIN);
    b.setNow(T0 + 20 * MIN);
    const first = a.redeemer.tick();
    try {
      await Promise.race([started, first.then(() => { throw new Error("first consume was not entered"); })]);
      expect((await b.redeemer.tick()).kind).toBe("dispatched");
    } finally {
      release();
      await first;
    }
    expect((await first).kind).toBe("dispatched");
    const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries as Array<{ redeemRequestId: string; state: string }>;
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.redeemRequestId).sort()).toEqual([...a.consumed, ...b.consumed].sort());
    expect(entries.every(entry => entry.state === "settled")).toBe(true);
    expect((await b.redeemer.tick()).kind).toBe("skipped");
    expect(b.consumed).toHaveLength(1);
  });

  test("a separate SQLite writer blocks reservation before any consume", async () => {
    const journalFile = join(dir, "j.json");
    const h = harness({ credits: () => [credit(30)], journalFile });
    h.setNow(T0 + 20 * MIN);
    expect(readConfigGeneration().kind).toBe("ready");
    const holder = new Database(join(dir, "config-mutation.sqlite"), { readwrite: true, create: false });
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      expect((await h.redeemer.tick()).kind).toBe("error");
      expect(h.consumed).toHaveLength(0);
      expect(existsSync(journalFile)).toBe(false);
      expect(h.pendingAt()).toBe(T0 + 20 * MIN + 1_000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    h.setNow(T0 + 20 * MIN + 1_000);
    expect((await h.redeemer.tick()).kind).toBe("dispatched");
    expect(h.consumed).toHaveLength(1);
    const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].redeemRequestId).toBe(h.consumed[0]);
    expect(entries[0].state).toBe("settled");
  });

  test("a peer that observes a settled credit keeps checking for future credits", async () => {
    const journalFile = join(dir, "j.json");
    const first = harness({ credits: () => [credit(30)], journalFile });
    const peer = harness({ credits: () => [credit(30)], journalFile });
    first.setNow(T0 + 20 * MIN);
    peer.setNow(T0 + 20 * MIN);
    expect((await first.redeemer.tick()).kind).toBe("dispatched");
    expect((await peer.redeemer.tick()).kind).toBe("skipped");
    expect(peer.consumed).toHaveLength(0);
    expect(peer.pendingAt()).toBe(T0 + 35 * MIN);
  });

  test("settlement contention keeps the reserved request id for a later retry", async () => {
    const journalFile = join(dir, "j.json");
    let holder: Database | null = null;
    let attempts = 0;
    const h = harness({ credits: () => [credit(30)], journalFile, consume: async () => {
      if (attempts++ === 0) {
        holder = new Database(join(dir, "config-mutation.sqlite"), { readwrite: true, create: false });
        holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      }
      return { code: "reset" };
    } });
    h.setNow(T0 + 20 * MIN);
    try {
      expect((await h.redeemer.tick()).kind).toBe("error");
      const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe("dispatched");
      expect(entries[0].redeemRequestId).toBe(h.consumed[0]);
      expect(h.pendingAt()).toBe(T0 + 20 * MIN + 1_000);
    } finally {
      if (holder) {
        (holder as Database).exec("ROLLBACK");
        (holder as Database).close();
      }
    }
    h.setNow(T0 + 20 * MIN + 1_000);
    expect((await h.redeemer.tick()).kind).toBe("dispatched");
    expect(h.consumed).toHaveLength(2);
    expect(h.consumed[0]).toBe(h.consumed[1]);
    expect(JSON.parse(readFileSync(journalFile, "utf8")).entries[0].state).toBe("settled");
  });

  test("journal retention uses the redeemer's injected clock", async () => {
    const start = Date.parse("2000-01-01T00:00:00Z");
    const journalFile = join(dir, "j.json");
    const h = harness({ journalFile, credits: () => [{
      granted_at: "1999-12-31T00:00:00Z",
      expires_at: new Date(start + 30 * MIN).toISOString(),
    }] });
    h.setNow(start + 20 * MIN);
    expect((await h.redeemer.tick()).kind).toBe("dispatched");
    const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].updatedAt).toBe(start + 20 * MIN);
  });

  test("a persistent reservation write failure uses the idle retry interval", async () => {
    const journalFile = join(dir, "journal-directory");
    mkdirSync(journalFile);
    const h = harness({ credits: () => [credit(30)], journalFile });
    h.setNow(T0 + 20 * MIN);
    expect((await h.redeemer.tick()).kind).toBe("error");
    expect(h.consumed).toHaveLength(0);
    expect(h.pendingAt()).toBe(T0 + 35 * MIN);
  });

  for (const changedReservation of ["missing", "replaced"]) {
    test(`settlement rejects a ${changedReservation} reservation without overwriting it`, async () => {
      const journalFile = join(dir, "j.json");
      let replacement = "";
      const h = harness({ credits: () => [credit(30)], journalFile, consume: async () => {
        const journal = JSON.parse(readFileSync(journalFile, "utf8"));
        if (changedReservation === "missing") journal.entries = [];
        else journal.entries[0].redeemRequestId = "replacement-request";
        replacement = JSON.stringify(journal);
        writeFileSync(journalFile, replacement);
        return { code: "reset" };
      } });
      h.setNow(T0 + 20 * MIN);
      const outcome = await h.redeemer.tick();
      expect(outcome).toEqual({ kind: "error", message: "auto-redeem journal reservation changed before settlement" });
      expect(h.consumed).toHaveLength(1);
      expect(readFileSync(journalFile, "utf8")).toBe(replacement);
      expect(h.pendingAt()).toBe(T0 + 35 * MIN);
    });
  }

  test("stop clears the timer", async () => {
    const h = harness({ credits: () => [credit(30)], journalFile: join(dir, "j.json") });
    await h.redeemer.tick();
    expect(h.pendingAt()).not.toBeNull();
    h.redeemer.stop();
    expect(h.pendingAt()).toBeNull();
  });
});

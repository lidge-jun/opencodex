import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResetCreditAutoRedeemer,
  planAutoRedeem,
  resolveResetCreditAutoRedeemSettings,
  type ResetCredit,
} from "../src/codex/reset-credit-auto-redeem";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const T0 = Date.parse("2026-09-02T10:00:00Z");
const MIN = 60_000;
const credit = (expiresInMin: number, grantedAt = "2026-09-01T00:00:00Z"): ResetCredit => ({
  granted_at: grantedAt,
  expires_at: new Date(T0 + expiresInMin * MIN).toISOString(),
});

/** Fake clock + manual timer: fire() runs the pending timer at its due time. */
function harness(opts: { credits: () => ResetCredit[]; enabled?: () => boolean; lead?: number; journalFile: string; consumeCode?: string; consumeThrows?: boolean }) {
  let now = T0;
  let pending: { fn: () => void; at: number } | null = null;
  const consumed: string[] = [];
  const logs: string[] = [];
  let inspects = 0;
  const redeemer = createResetCreditAutoRedeemer({
    accountId: "acct-main",
    settings: () => ({ enabled: opts.enabled ? opts.enabled() : true, leadTimeMinutes: opts.lead ?? 10 }),
    inspect: async () => { inspects += 1; return { credits: opts.credits() }; },
    consume: async id => {
      if (opts.consumeThrows) throw new Error("socket hangup");
      consumed.push(id);
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
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-auto-redeem-")); });
afterEach(() => { removeTreeWithRetry(dir); });

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

  test("stop clears the timer", async () => {
    const h = harness({ credits: () => [credit(30)], journalFile: join(dir, "j.json") });
    await h.redeemer.tick();
    expect(h.pendingAt()).not.toBeNull();
    h.redeemer.stop();
    expect(h.pendingAt()).toBeNull();
  });
});

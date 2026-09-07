import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResetCreditAutoRedeemer,
  planAutoRedeem,
  resolveResetCreditAutoRedeemSettings,
  type ResetCredit,
} from "../../src/codex/reset-credit-auto-redeem";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
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
    // The timer synchronously installs inFlight; join that tick instead of sleeping.
    advanceAndFire: async () => { if (!pending) throw new Error("no timer"); now = pending.at; const fn = pending.fn; pending = null; fn(); return await redeemer.tick(); },
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
  test("a disabled tick creates neither a journal nor a mutation coordinator", async () => {
    const journalFile = join(dir, "reset-credit-auto-redeem.json");
    expect(readdirSync(dir)).toEqual([]);
    const h = harness({ credits: () => [credit(30)], enabled: () => false, journalFile });
    h.setNow(T0 + 20 * MIN);
    expect(await h.redeemer.tick()).toEqual({ kind: "disabled" });
    expect(h.inspects()).toBe(0);
    expect(h.consumed).toHaveLength(0);
    expect(h.pendingAt()).toBeNull();
    expect(existsSync(journalFile)).toBe(false);
    expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

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

  test("a SQLite reader blocks COMMIT after reservation publication and retries the same id", async () => {
    const journalFile = join(dir, "j.json");
    const databaseFile = join(dir, "config-mutation.sqlite");
    expect(existsSync(databaseFile)).toBe(false);
    const reader = new Database(databaseFile, { create: true });
    const h = harness({ credits: () => [credit(30)], journalFile });
    h.setNow(T0 + 20 * MIN);
    let reservationId = "";
    try {
      // No readConfigGeneration pre-initialization: the coordinator's first acquisition
      // must write its schema, so COMMIT needs an exclusive rollback-journal lock.
      reader.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0");
      reader.exec("BEGIN; CREATE TABLE reader_fixture (value INTEGER); INSERT INTO reader_fixture VALUES (1); COMMIT");
      expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(reader.query("SELECT name FROM sqlite_master WHERE name = 'config_generation'").all()).toEqual([]);
      reader.exec("BEGIN");
      // BEGIN alone holds no read lock. This SELECT materializes the read transaction.
      expect(reader.query("SELECT value FROM reader_fixture").all()).toEqual([{ value: 1 }]);
      expect(reader.inTransaction).toBe(true);
      const outcome = await h.redeemer.tick();
      expect(outcome).toEqual({ kind: "error", message: expect.stringMatching(/database (?:is|table is) locked/i) });
      expect(h.consumed).toHaveLength(0);
      // An acquisition failure cannot publish this row: the callback ran before COMMIT failed.
      const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe("dispatched");
      reservationId = entries[0].redeemRequestId;
      expect(reservationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(h.pendingAt()).toBe(T0 + 20 * MIN + 1_000);
    } finally {
      try { if (reader.inTransaction) reader.exec("ROLLBACK"); } finally { reader.close(); }
    }
    expect(await h.advanceAndFire()).toEqual({ kind: "dispatched", code: "reset", redeemRequestId: reservationId });
    expect(h.consumed).toEqual([reservationId]);
    const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].redeemRequestId).toBe(reservationId);
    expect(entries[0].state).toBe("settled");
  });

  test("two processes reserve one durable id before either consume settles", async () => {
    const journalFile = join(dir, "j.json");
    const moduleUrl = pathToFileURL(repoPath("src/codex/reset-credit-auto-redeem.ts")).href;
    const deadline = performance.now() + 25_000;
    const markerPath = (name: string) => join(dir, name + ".json");
    const publish = (name: string) => {
      const path = markerPath(name);
      const temporary = path + "." + process.pid + ".tmp";
      writeFileSync(temporary, JSON.stringify({ pid: process.pid }));
      renameSync(temporary, path);
    };
    const launch = (worker: string) => {
      const source = `
        import { existsSync, writeFileSync, renameSync } from "node:fs";
        import { join } from "node:path";
        import { createResetCreditAutoRedeemer } from ${JSON.stringify(moduleUrl)};
        const home = ${JSON.stringify(dir)};
        const worker = ${JSON.stringify(worker)};
        const deadline = performance.now() + 20_000;
        const marker = name => join(home, name + ".json");
        const publish = (name, value) => {
          const path = marker(name);
          const temporary = path + "." + process.pid + ".tmp";
          writeFileSync(temporary, JSON.stringify({ ...value, pid: process.pid }));
          renameSync(temporary, path);
        };
        const waitFor = async name => {
          while (!existsSync(marker(name))) {
            if (performance.now() >= deadline) throw new Error("timed out waiting for " + name);
            await Bun.sleep(10);
          }
        };
        const consumes = [];
        const retries = [];
        let scheduledMs = null;
        const redeemer = createResetCreditAutoRedeemer({
          accountId: "acct-process-fixture",
          journalFile: ${JSON.stringify(journalFile)},
          settings: () => ({ enabled: true, leadTimeMinutes: 10 }),
          inspect: async () => ({ credits: [${JSON.stringify(credit(30))}] }),
          now: () => ${T0 + 20 * MIN},
          // Only the loop below owns ticks; recorded timers cannot launch overlapping work.
          setTimer: (_fn, ms) => { scheduledMs = ms; return 1; },
          clearTimer: () => { scheduledMs = null; },
          log: () => {},
          consume: async redeemRequestId => {
            consumes.push(redeemRequestId);
            if (consumes.length !== 1) throw new Error("unexpected repeated consume");
            publish(worker + "-consume", { redeemRequestId });
            await waitFor(worker + "-release");
            return { code: "reset" };
          },
        });
        try {
          publish(worker + "-ready", {});
          await waitFor("start");
          let outcome;
          while (true) {
            if (performance.now() >= deadline) throw new Error("reservation contention deadline exceeded");
            scheduledMs = null;
            outcome = await redeemer.tick();
            if (outcome.kind === "dispatched") break;
            const contention = outcome.kind === "error" && (
              outcome.message === "Config mutation already in progress"
              || /database (?:is|table is) locked/i.test(outcome.message)
            );
            if (!contention || scheduledMs !== 1000 || consumes.length !== 0) {
              throw new Error("unexpected tick: " + JSON.stringify({ outcome, scheduledMs, consumes }));
            }
            retries.push({ message: outcome.message, scheduledMs });
            // Honor the recorded contention delay; never retry arbitrary errors or settlement.
            await Bun.sleep(scheduledMs);
          }
          publish(worker + "-result", { outcome, consumes, retries });
        } catch (error) {
          publish(worker + "-result", { error: String(error), consumes, retries });
          console.error(error);
          process.exitCode = 1;
        } finally {
          redeemer.stop();
        }
      `;
      const child = Bun.spawn([process.execPath, "-e", source], {
        cwd: repoPath(),
        env: { ...process.env, OPENCODEX_HOME: dir },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const output = { stdout: "", stderr: "" };
      const drain = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            output[key] += decoder.decode(value, { stream: true });
          }
          output[key] += decoder.decode();
        } catch (error) {
          output[key] += "\npipe read failed: " + String(error);
        } finally { reader.releaseLock(); }
      };
      // Start draining both pipes immediately, including while waiting at the barriers.
      const drained = Promise.all([drain(child.stdout, "stdout"), drain(child.stderr, "stderr")]);
      return { worker, child, output, drained };
    };
    const children: ReturnType<typeof launch>[] = [];
    const released = new Set<string>();
    const diagnostics = () => children.map(({ worker, child, output }) =>
      `${worker} pid=${child.pid} exit=${child.exitCode}\nstdout: ${output.stdout}\nstderr: ${output.stderr}`).join("\n");
    const waitUntil = async (label: string, ready: () => boolean) => {
      while (true) {
        for (const { worker, child } of children) {
          if (child.exitCode !== null && (!released.has(worker) || child.exitCode !== 0)) {
            throw new Error(`premature child exit waiting for ${label}\n${diagnostics()}`);
          }
        }
        if (ready()) return;
        if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}\n${diagnostics()}`);
        await Bun.sleep(10);
      }
    };
    const readMarker = (name: string) => JSON.parse(readFileSync(markerPath(name), "utf8"));
    try {
      children.push(launch("a"));
      children.push(launch("b"));
      await waitUntil("both ready", () => children.every(({ worker }) => existsSync(markerPath(worker + "-ready"))));
      for (const { worker, child } of children) expect(readMarker(worker + "-ready").pid).toBe(child.pid);
      expect(children[0]!.child.pid).not.toBe(children[1]!.child.pid);
      expect(existsSync(journalFile)).toBe(false);
      publish("start");
      await waitUntil("both consumes", () => children.every(({ worker }) => existsSync(markerPath(worker + "-consume"))));
      const ids = children.map(({ worker, child }) => {
        const marker = readMarker(worker + "-consume");
        expect(marker.pid).toBe(child.pid);
        expect(marker.redeemRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(existsSync(markerPath(worker + "-result"))).toBe(false);
        return marker.redeemRequestId as string;
      });
      expect(new Set(ids).size).toBe(1);
      const reserved = JSON.parse(readFileSync(journalFile, "utf8")).entries;
      expect(reserved).toHaveLength(1);
      expect(reserved[0].redeemRequestId).toBe(ids[0]);
      expect(reserved[0].state).toBe("dispatched");
      // Release one child at a time so settlement needs no timing-dependent retries.
      for (const { worker, child } of children) {
        released.add(worker);
        publish(worker + "-release");
        await waitUntil(worker + " result", () => existsSync(markerPath(worker + "-result")));
        const result = readMarker(worker + "-result");
        expect(result.pid).toBe(child.pid);
        expect(result.error).toBeUndefined();
        expect(result.outcome).toEqual({ kind: "dispatched", code: "reset", redeemRequestId: ids[0] });
        expect(result.consumes).toEqual([ids[0]]);
        await waitUntil(worker + " exit", () => child.exitCode !== null);
        expect(await child.exited).toBe(0);
      }
      const settled = JSON.parse(readFileSync(journalFile, "utf8")).entries;
      expect(settled).toHaveLength(1);
      expect(settled[0].redeemRequestId).toBe(ids[0]);
      expect(settled[0].state).toBe("settled");
    } catch (error) {
      throw new Error(`${String(error)}\n${diagnostics()}`);
    } finally {
      try {
        for (const { worker } of children) {
          if (!existsSync(markerPath(worker + "-release"))) publish(worker + "-release");
        }
      } finally {
        // Start every cleanup even if another child's kill races its natural exit.
        const cleanup = await Promise.allSettled(children.map(async ({ child, drained }) => {
          try {
            if (child.exitCode === null) child.kill("SIGKILL");
          } finally {
            await child.exited;
            await drained;
          }
        }));
        const failedCleanup = cleanup.filter(result => result.status === "rejected");
        if (failedCleanup.length > 0) throw new AggregateError(failedCleanup.map(result => result.reason), "journal fixture child cleanup failed");
      }
    }
  }, 35_000);

  test("a peer that observes a settled credit keeps checking for future credits", async () => {
    const journalFile = join(dir, "j.json");
    const first = harness({ credits: () => [credit(30)], journalFile });
    let peerCredits = [credit(30)];
    const peer = harness({ credits: () => peerCredits, journalFile });
    first.setNow(T0 + 20 * MIN);
    peer.setNow(T0 + 20 * MIN);
    expect((await first.redeemer.tick()).kind).toBe("dispatched");
    expect((await peer.redeemer.tick()).kind).toBe("skipped");
    expect(peer.consumed).toHaveLength(0);
    expect(peer.pendingAt()).toBe(T0 + 35 * MIN);
    const futureCredit = credit(45, "2026-09-02T10:30:00Z");
    peerCredits = [futureCredit];
    const outcome = await peer.advanceAndFire();
    expect(outcome).toEqual({ kind: "dispatched", code: "reset", redeemRequestId: expect.any(String) });
    expect(peer.consumed).toHaveLength(1);
    expect(peer.consumed[0]).not.toBe(first.consumed[0]);
    const entries = JSON.parse(readFileSync(journalFile, "utf8")).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry: { redeemRequestId: string }) => entry.redeemRequestId).sort()).toEqual([...first.consumed, ...peer.consumed].sort());
    expect(entries.find((entry: { redeemRequestId: string }) => entry.redeemRequestId === peer.consumed[0])).toMatchObject({
      grantedAt: futureCredit.granted_at, expiresAt: futureCredit.expires_at, state: "settled",
    });
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

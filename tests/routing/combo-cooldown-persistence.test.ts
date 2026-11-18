import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { PersistedCooldownMap } from "../../src/combos/cooldown-store";
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos/failover";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Row = { cooldownUntil: number; revision: number; status?: number };

let home: string;
let previous: string | undefined;
let revision = 0;
const nextRevision = () => ++revision;
const file = () => join(home, "combo-cooldowns.json");
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, { cooldownUntil: number; status?: number }>;
/** A second proxy process on the same home is a second map reading the same file. */
const peer = () => new PersistedCooldownMap<Row>(nextRevision);

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cooldown-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});

test("a combo cooldown is written with an absolute expiry and reloaded by a fresh map", async () => {
  const target = { provider: "provider-a", model: "model-x" };
  expect(coolComboTarget("combo-a", target, { retryAfter: "600", status: 429 })).toBe(true);
  // The production write is debounced (250 ms); wait it out before reading the file.
  await wait(500);
  const rows = stored();
  const key = Object.keys(rows).find(k => k.includes("provider-a/model-x"))!;
  expect(rows[key]!.cooldownUntil).toBeGreaterThan(Date.now() + 500_000);
  expect(rows[key]!.status).toBe(429);

  // A restart is a new map reading the same file; loaded rows get fresh, increasing revisions.
  const restarted = peer();
  expect(restarted.get(key)?.status).toBe(429);
  const loadedRevision = restarted.get(key)!.revision;
  restarted.set("other", { cooldownUntil: Date.now() + 1000, revision: nextRevision() });
  expect(restarted.get("other")!.revision).toBeGreaterThan(loadedRevision);
  expect(isComboTargetInCooldown("combo-a", target)).toBe(true);
  clearComboTargetCooldowns();
  await wait(500);
});

test("expired rows and a corrupt file are ignored", () => {
  writeFileSync(file(), JSON.stringify({
    stale: { cooldownUntil: Date.now() - 1000 },
    live: { cooldownUntil: Date.now() + 60_000 },
  }));
  const map = peer();
  expect(map.has("stale")).toBe(false);
  expect(map.has("live")).toBe(true);

  writeFileSync(file(), "{not json");
  expect(peer().size).toBe(0);
});

test("two maps on one home keep each other's rows", () => {
  const a = peer();
  const b = peer();
  a.set("a", { cooldownUntil: Date.now() + 60_000, revision: nextRevision() });
  expect(a.flush()).toBe(true);
  b.set("b", { cooldownUntil: Date.now() + 60_000, revision: nextRevision() });
  expect(b.flush()).toBe(true);
  a.set("a2", { cooldownUntil: Date.now() + 60_000, revision: nextRevision() });
  expect(a.flush()).toBe(true);
  expect(Object.keys(stored()).sort()).toEqual(["a", "a2", "b"]);
});

test("a flush never rewrites a row it did not touch and never shortens a longer foreign cooldown", () => {
  const now = Date.now();
  writeFileSync(file(), JSON.stringify({ shared: { cooldownUntil: now + 60_000 }, foreign: { cooldownUntil: now + 60_000 } }));
  const a = peer();
  expect(a.get("foreign")?.cooldownUntil).toBe(now + 60_000);
  // Another process extends the foreign row after this one loaded it.
  writeFileSync(file(), JSON.stringify({ shared: { cooldownUntil: now + 600_000, status: 503 }, foreign: { cooldownUntil: now + 600_000 } }));
  a.set("shared", { cooldownUntil: now + 120_000, revision: nextRevision(), status: 429 });
  expect(a.flush()).toBe(true);
  expect(stored()).toEqual({
    shared: { cooldownUntil: now + 600_000, status: 503 },
    foreign: { cooldownUntil: now + 600_000 },
  });
});

test("an expired local copy never erases a row another process extended", () => {
  const now = Date.now();
  writeFileSync(file(), JSON.stringify({ row: { cooldownUntil: now + 50 } }));
  const a = peer();
  expect(a.has("row")).toBe(true);
  writeFileSync(file(), JSON.stringify({ row: { cooldownUntil: now + 600_000 } }));
  // Expiry, sweeps and the probe lift are local drops.
  a.dropLocal("row");
  a.delete("row");
  a.set("mine", { cooldownUntil: now + 60_000, revision: nextRevision() });
  expect(a.flush()).toBe(true);
  expect(stored().row?.cooldownUntil).toBe(now + 600_000);
});

test("user clears are written: keys, one combo, and everything as a global reset", () => {
  const now = Date.now();
  writeFileSync(file(), JSON.stringify({
    "c1\0p/a": { cooldownUntil: now + 60_000 }, "c1\0p/b": { cooldownUntil: now + 60_000 },
    "c2\0p/a": { cooldownUntil: now + 60_000 }, foreign: { cooldownUntil: now + 60_000 },
  }));
  const a = peer();
  a.clearPersisted(["c1\0p/a"]);
  expect(a.flush()).toBe(true);
  expect(Object.keys(stored()).sort()).toEqual(["c1\0p/b", "c2\0p/a", "foreign"]);

  a.clearPrefixPersisted("c2\0");
  expect(a.flush()).toBe(true);
  expect(Object.keys(stored()).sort()).toEqual(["c1\0p/b", "foreign"]);

  // A row another process writes after this clear is erased too: clear-all is a global reset.
  writeFileSync(file(), JSON.stringify({ ...stored(), late: { cooldownUntil: now + 60_000 } }));
  a.clearAllPersisted();
  a.set("after", { cooldownUntil: now + 60_000, revision: nextRevision() });
  expect(a.flush()).toBe(true);
  expect(Object.keys(stored())).toEqual(["after"]);
});

test("a busy config lock keeps the pending write, which lands on a later flush", () => {
  const lock = new Database(join(home, "config-mutation.sqlite"), { create: true });
  lock.exec("BEGIN IMMEDIATE");
  const a = peer();
  a.set("kept", { cooldownUntil: Date.now() + 60_000, revision: nextRevision() });
  try {
    expect(a.flush()).toBe(false);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  expect(a.flush()).toBe(true);
  expect(Object.keys(stored())).toEqual(["kept"]);
});

test("the shutdown flush writes a pending row immediately", () => {
  const a = peer();
  a.set("pending", { cooldownUntil: Date.now() + 60_000, revision: nextRevision() });
  a.flushForShutdown();
  expect(Object.keys(stored())).toEqual(["pending"]);
});

test("a failed load is retried on a later access", () => {
  const now = Date.now();
  // A directory where the file should be makes the read fail with something other than ENOENT.
  const { mkdirSync, rmdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(file());
  const a = peer();
  expect(a.has("row")).toBe(false);
  rmdirSync(file());
  writeFileSync(file(), JSON.stringify({ row: { cooldownUntil: now + 60_000 } }));
  expect(a.has("row")).toBe(true);
});

for (const scope of ["key", "combo"] as const) {
  test(`a queued ${scope} clear survives a shorter cooldown for the same target`, () => {
    const now = Date.now();
    const key = "cleared\0p/a";
    writeFileSync(file(), JSON.stringify({ [key]: { cooldownUntil: now + 86_400_000, status: 503 } }));
    const a = peer();
    if (scope === "key") a.clearPersisted([key]); else a.clearPrefixPersisted("cleared\0");
    a.set(key, { cooldownUntil: now + 60_000, revision: nextRevision(), status: 429 });
    a.flushForShutdown();
    expect(stored()[key]).toEqual({ cooldownUntil: now + 60_000, status: 429 });
    expect(peer().get(key)?.cooldownUntil).toBe(now + 60_000);
  });
}

test("a combo-wide public clear removes peer rows absent from memory, including a later write", async () => {
  const combo = "peer-clear";
  const target = { provider: "provider-a", model: "model-x" };
  // Load the production map before the peer writes anything for this combo.
  expect(isComboTargetInCooldown(combo, target)).toBe(false);
  const b = peer();
  const until = Date.now() + 60_000;
  b.set(`${combo}\0provider-a/model-x`, { cooldownUntil: until, revision: nextRevision() });
  b.set(`${combo}-other\0provider-a/model-x`, { cooldownUntil: until, revision: nextRevision() });
  b.flushForShutdown();
  expect(isComboTargetInCooldown(combo, target)).toBe(false);

  clearComboTargetCooldowns(combo);
  // This row arrives after the clear was queued, but before its locked flush.
  b.set(`${combo}\0provider-b/model-y`, { cooldownUntil: until, revision: nextRevision() });
  b.flushForShutdown();
  await wait(500);
  expect(Object.keys(stored())).toEqual([`${combo}-other\0provider-a/model-x`]);
  expect(peer().has(`${combo}\0provider-a/model-x`)).toBe(false);
});

test("a combo-prefix clear and its new cooldown survive a busy lock", () => {
  const now = Date.now();
  const key = "retry-clear\0p/a";
  const a = peer();
  expect(a.size).toBe(0);
  a.clearPrefixPersisted("retry-clear\0");
  writeFileSync(file(), JSON.stringify({
    [key]: { cooldownUntil: now + 86_400_000, status: 503 },
    "retry-clear\0p/b": { cooldownUntil: now + 86_400_000 },
    "other\0p/a": { cooldownUntil: now + 86_400_000 },
  }));
  a.set(key, { cooldownUntil: now + 60_000, revision: nextRevision(), status: 429 });
  const lock = new Database(join(home, "config-mutation.sqlite"), { create: true });
  lock.exec("BEGIN IMMEDIATE");
  try {
    expect(a.flush()).toBe(false);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  a.flushForShutdown();
  expect(stored()).toEqual({
    [key]: { cooldownUntil: now + 60_000, status: 429 },
    "other\0p/a": { cooldownUntil: now + 86_400_000 },
  });
});

test("a successful prefix clear does not delete future peer rows on a later write", () => {
  const until = Date.now() + 60_000;
  writeFileSync(file(), JSON.stringify({ "cleared\0p/a": { cooldownUntil: until } }));
  const a = peer();
  a.clearPrefixPersisted("cleared\0");
  a.flushForShutdown();
  expect(stored()).toEqual({});
  const b = peer();
  b.set("cleared\0p/b", { cooldownUntil: until, revision: nextRevision() });
  b.flushForShutdown();
  a.set("other\0p/a", { cooldownUntil: until, revision: nextRevision() });
  a.flushForShutdown();
  expect(Object.keys(stored()).sort()).toEqual(["cleared\0p/b", "other\0p/a"]);
});

test("repeated prefix clears discard intervening sets but preserve the last replacement", () => {
  const now = Date.now();
  writeFileSync(file(), JSON.stringify({ "cleared\0p/a": { cooldownUntil: now + 86_400_000 } }));
  const a = peer();
  a.clearPrefixPersisted("cleared\0");
  a.set("cleared\0p/b", { cooldownUntil: now + 60_000, revision: nextRevision() });
  a.clearPrefixPersisted("cleared\0");
  a.set("cleared\0p/a", { cooldownUntil: now + 30_000, revision: nextRevision() });
  a.flushForShutdown();
  expect(stored()).toEqual({ "cleared\0p/a": { cooldownUntil: now + 30_000 } });
});

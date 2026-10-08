import { expect, test } from "bun:test";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { createShippedSpendLedger, loadShippedSpendLedger, spendAlias, spendCheckpoint, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";

const request = (sendId: string, poolId = "P", tokens = 10) => ({ sendId, scopes: { poolId }, inputTokens: tokens, outputCeilingTokens: 0 });
test("2.80.0 parses every emitted v1 kind and checkpoint status", () => {
  const disk = spendTestJournal();
  const ledger = createSpendReservationLedger({ journal: disk, salt, policy: spendTestPolicy({ retentionMs: 10 }), now: () => 2 });
  for (const id of ["open", "dispatched", "settled", "lost", "abandoned"]) expect(ledger.reserve(request(id)).reserved).toBe(true);
  ledger.markDispatched("dispatched"); ledger.settle("settled", { inputTokens: 7, outputTokens: 0 });
  ledger.markDispatched("lost"); ledger.markLost("lost"); ledger.abandon("abandoned");
  ledger.reconfigure(spendTestPolicy({ compactAfterRecords: 1, retentionMs: 10 }));
  ledger.reserve(request("checkpoint", "P", 0));
  const cp = JSON.parse(disk.lines[0]!);
  expect(cp.kind).toBe("checkpoint"); expect(cp.poolContinuity).toBeUndefined();
  expect(new Set(cp.sends.map((s: {status: string}) => s.status))).toEqual(new Set(["open", "dispatched", "settled", "lost", "abandoned"]));
  expect(cp.scopes.every((s: {alias: string}) => s.alias === spendAlias("pool", "P"))).toBe(true);
  // Collect all eight kinds through ordinary public operations and cleanup.
  const all = spendTestJournal();
  const ordinary = createSpendReservationLedger({ journal: all, salt, now: () => 1, policy: spendTestPolicy({ pool: {}, retentionMs: 1 }) });
  for (const id of ["settle", "lost", "abandon"]) { ordinary.reserve(request(id)); if (id !== "abandon") ordinary.markDispatched(id); }
  ordinary.settle("settle", { inputTokens: 3, outputTokens: 0 }); ordinary.markLost("lost"); ordinary.abandon("abandon"); ordinary.prune(3);
  const lines = [...all.lines, ...disk.lines];
  expect(new Set(lines.map(line => JSON.parse(line).kind))).toEqual(new Set(["reserve", "dispatch", "settle", "lost", "abandon", "forget", "drop", "checkpoint"]));
  for (const line of lines) expect(loadShippedSpendLedger().parseSpendJournalRecord(line)).toEqual(JSON.parse(line));
  const old = createShippedSpendLedger({ journal: spendTestJournal(disk.lines), salt, policy: spendTestPolicy(), now: () => 2 });
  expect(old.corruptRecords).toBe(0); expect(old.snapshot("pool", "P")).toMatchObject({ settled: 7, unresolved: 30 });
});
test("old compact retain and reupgrade keep legacy per-label totals", () => {
  const disk = spendTestJournal([spendCheckpoint([["A", 80, 0], ["P", 20, 0]])]);
  const policy = spendTestPolicy({ poolAliases: { [spendAlias("pool", "A")]: "P" }, retentionMs: 10 });
  const next = createSpendReservationLedger({ journal: disk, salt, policy, now: () => 2 });
  expect(next.snapshot("pool", "P")?.settled).toBe(100);
  const old = createShippedSpendLedger({ journal: disk, salt, policy: spendTestPolicy({ compactAfterRecords: 1, retentionMs: 10 }), now: () => 2 });
  expect(old.snapshot("pool", "A")?.settled).toBe(80); expect(old.snapshot("pool", "P")?.settled).toBe(20);
  old.reserve(request("old", "P", 0)); old.abandon("old");
  expect(createSpendReservationLedger({ journal: disk, salt, policy, now: () => 2 }).snapshot("pool", "P")?.settled).toBe(100);
  old.prune(13); old.reserve(request("compact-after-retention", "P", 0));
  expect(createSpendReservationLedger({ journal: disk, salt, policy, now: () => 13 }).snapshot("pool", "P")?.settled ?? 0).toBe(0);
});
test("same traffic has no promised downgrade allowance equivalence", () => {
  const disk = spendTestJournal();
  const next = createSpendReservationLedger({ journal: disk, salt, policy: spendTestPolicy(), now: () => 2 });
  next.reserve(request("physical", "P", 40)); next.settle("physical", { inputTokens: 40, outputTokens: 0 });
  const old = createShippedSpendLedger({ journal: disk, salt, policy: spendTestPolicy(), now: () => 2 });
  const neverUpgraded = createShippedSpendLedger({ journal: spendTestJournal(), salt, policy: spendTestPolicy(), now: () => 2 });
  neverUpgraded.reserve(request("physical", "account-label", 40)); neverUpgraded.settle("physical", { inputTokens: 40, outputTokens: 0 });
  expect(old.snapshot("pool", "P")?.settled).toBe(40);
  expect(neverUpgraded.snapshot("pool", "P")).toBeUndefined();
  expect(old.reserve(request("extra", "P", 61)).reserved).toBe(false);
  expect(neverUpgraded.reserve(request("extra", "P", 61)).reserved).toBe(true);
});

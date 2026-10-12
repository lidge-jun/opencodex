import { expect, test } from "bun:test";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { spendCheckpoint, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";
const request = (sendId: string, poolId = "P") => ({ sendId, scopes: { poolId }, inputTokens: 1, outputCeilingTokens: 0 });
const corrupt = () => spendTestJournal([spendCheckpoint([["P", 40, 0]]), "broken middle", {v:1,kind:"forget",send:"missing",at:2}]);
const policy = spendTestPolicy({ compactAfterRecords: 1 });
test("corrupt middle line compacts valid state without clearing live refusal", () => {
  const disk = corrupt(); const ledger = createSpendReservationLedger({ journal: disk, salt, policy, now: () => 3 });
  expect(ledger.reserve(request("refuse"))).toMatchObject({ reserved: false, denial: { reason: "journal-corrupt" } });
  // Unconfigured applicable root traffic can trigger ordinary scheduled compaction.
  ledger.reserve({ ...request("observe"), scopes: { rootId: "root" } });
  expect(disk.lines).toHaveLength(1); expect(JSON.parse(disk.lines[0]!).poolContinuity).toBeUndefined();
  expect(ledger.corruptRecords).toBe(1); expect(ledger.reserve(request("still-refuse")).reserved).toBe(false);
});
test("restart after compaction restores dev enforcement", () => {
  const disk = corrupt(); const ledger = createSpendReservationLedger({ journal: disk, salt, policy, now: () => 3 });
  ledger.reserve({ ...request("observe"), scopes: {} });
  const replay = createSpendReservationLedger({ journal: disk, salt, policy, now: () => 3 });
  expect(replay.corruptRecords).toBe(0); expect(replay.snapshot("pool", "P")?.settled).toBe(40);
  expect(replay.reserve(request("now-admits")).reserved).toBe(true);
});
test("complete final null remains corruption before compaction", () => {
  const ledger = createSpendReservationLedger({ journal: spendTestJournal([spendCheckpoint([["P", 40, 0]]), "null"]), salt, policy });
  expect(ledger.corruptRecords).toBe(1); expect(ledger.reserve(request("refuse")).reserved).toBe(false);
});
test("rewrite failure retains prior journal", () => {
  const disk = corrupt(); disk.failRewrite = true;
  const before = [...disk.lines]; const ledger = createSpendReservationLedger({ journal: disk, salt, policy, now: () => 3 });
  ledger.reserve({ ...request("observe"), scopes: {} });
  expect(disk.lines.slice(0, before.length)).toEqual(before); expect(ledger.persistFailures).toBe(1); expect(ledger.corruptRecords).toBe(1);
});

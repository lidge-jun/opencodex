import { expect, test } from "bun:test";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { spendAlias, spendCheckpoint, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";
const request = (sendId: string, poolId = "P", tokens = 1) => ({sendId, scopes: {poolId}, inputTokens: tokens, outputCeilingTokens: 0});
const policy = spendTestPolicy({ retentionMs: 10 });
test("30 settled 10 unresolved expires strictly after retention cutoff", () => {
  const disk = spendTestJournal([spendCheckpoint([["unknown", 30, 10]])]);
  const ledger = createSpendReservationLedger({journal:disk,salt,policy,now:()=>2});
  ledger.prune(11); expect(ledger.snapshot("pool", "P")).toMatchObject({settled:30,unresolved:10});
  ledger.prune(12); expect(ledger.snapshot("pool", "P")).toBeUndefined();
  expect(JSON.parse(disk.lines.at(-1)!)).toEqual({v:1,kind:"drop",scope:"pool",alias:spendAlias("pool","unknown"),at:12});
  expect(createSpendReservationLedger({journal:disk,salt,policy,now:()=>12}).snapshot("pool","P")).toBeUndefined();
});
test("capacity pressure never expires unknown history early", () => {
  const disk = spendTestJournal([spendCheckpoint([["unknown",30,10]])]);
  const ledger = createSpendReservationLedger({journal:disk,salt,policy:{...policy,maxTrackedScopes:1},now:()=>11});
  expect(ledger.reserve(request("full"))).toMatchObject({reserved:false,denial:{reason:"tracking-capacity-exhausted"}});
  expect(ledger.snapshot("pool","P")).toMatchObject({settled:30,unresolved:10}); expect(disk.lines).toHaveLength(1);
});
test("failed drop cannot reduce enforced admission total", () => {
  const disk = spendTestJournal([spendCheckpoint([["unknown",30,10]])]); disk.failAppend=true;
  const ledger = createSpendReservationLedger({journal:disk,salt,policy,now:()=>12}); ledger.prune();
  expect(ledger.snapshot("pool","P")).toMatchObject({settled:30,unresolved:10});
  expect(ledger.reserve(request("cannot-launder","P",61)).reserved).toBe(false);
  expect(ledger.persistFailures).toBeGreaterThan(0); expect(disk.lines).toHaveLength(1);
});
test("expiry rebuilds unrelated candidate overlay before admission", () => {
  const disk=spendTestJournal([spendCheckpoint([["unknown",40,0]]),spendCheckpoint([["unknown",40,0],["verified",60,0]])]);
  const ledger=createSpendReservationLedger({journal:disk,salt,policy:{...policy,poolAliases:{[spendAlias("pool","verified")]:"P"}},now:()=>12});
  expect(ledger.reserve(request("Q-admits","Q",100)).reserved).toBe(true);
  expect(ledger.snapshot("pool","P")?.settled ?? 0).toBe(0);
  expect(disk.lines.filter(line=>JSON.parse(line).kind==="drop")).toHaveLength(2);
});

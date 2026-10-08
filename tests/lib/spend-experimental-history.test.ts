import { expect, test } from "bun:test";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { createShippedSpendLedger, spendAlias, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";
const experimental = () => ({v:1,kind:"checkpoint",at:1,poolContinuity:{v:1,kind:"pool-continuity",at:1,bindings:[{alias:spendAlias("pool-current","P"),canonical:spendAlias("pool-current","P")}]},scopes:[{scope:"pool",alias:spendAlias("pool-current","P"),settled:30,unresolved:0,seenAt:1}],sends:[{send:spendAlias("send","live"),status:"dispatched",targets:[{scope:"pool",alias:spendAlias("pool-current","P")}],tokens:10,at:1,resolvedAt:1}]});
test("experimental aliases and live targets remain conservative across compaction",()=>{
  const disk=spendTestJournal([experimental()]);const policy=spendTestPolicy({compactAfterRecords:1,retentionMs:10});
  const ledger=createSpendReservationLedger({journal:disk,salt,policy,now:()=>2});
  expect(ledger.snapshot("pool","Q")).toMatchObject({settled:30,unresolved:10});
  ledger.reserve({sendId:"compact",scopes:{poolId:"P"},inputTokens:0,outputCeilingTokens:0});
  expect(JSON.parse(disk.lines[0]!).poolContinuity).toBeUndefined();
  expect(JSON.parse(disk.lines[0]!).scopes.some((r:{alias:string})=>r.alias===spendAlias("pool-current","P"))).toBe(true);
  expect(createSpendReservationLedger({journal:disk,salt,policy,now:()=>2}).snapshot("pool","Q")).toMatchObject({settled:30,unresolved:10});
});
test("experimental journal is excluded from C without immediate deletion",()=>{
  const disk=spendTestJournal([experimental()]);const ledger=createSpendReservationLedger({journal:disk,salt,policy:spendTestPolicy({retentionMs:10}),now:()=>2});
  expect(ledger.corruptRecords).toBe(0);expect(ledger.snapshot("pool","P")).toMatchObject({settled:30,unresolved:10});
  // The shipped reader does not look up the unpublished pool-current domain.
  expect(createShippedSpendLedger({journal:spendTestJournal(disk.lines),salt,now:()=>2}).snapshot("pool","P")).toBeUndefined();
  expect(disk.lines.some(line=>JSON.parse(line).kind==="drop")).toBe(false);
});
test("dormant experimental liability expires only through ordinary durable drop",()=>{
  const disk=spendTestJournal([experimental()]);const policy=spendTestPolicy({retentionMs:10});const ledger=createSpendReservationLedger({journal:disk,salt,policy,now:()=>2});
  ledger.prune(12);expect(ledger.snapshot("pool","P")?.unresolved).toBe(10);ledger.prune(13);expect(ledger.snapshot("pool","P")).toBeUndefined();
  expect(JSON.parse(disk.lines.at(-1)!)).toMatchObject({kind:"drop",alias:spendAlias("pool-current","P")});
  expect(createSpendReservationLedger({journal:disk,salt,policy,now:()=>13}).snapshot("pool","P")).toBeUndefined();
});

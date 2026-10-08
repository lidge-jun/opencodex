import { expect, test } from "bun:test";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { createShippedSpendLedger, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";
const req=(id:string,tokens=10)=>({sendId:id,scopes:{poolId:"P"},inputTokens:tokens,outputCeilingTokens:0});
test("three unconfigured sends match shipped bytes for equal pool inputs",()=>{
  const oldDisk=spendTestJournal(),newDisk=spendTestJournal();const policy=spendTestPolicy({pool:{}});
  for(const ledger of [createShippedSpendLedger({journal:oldDisk,salt,policy,now:()=>2}),createSpendReservationLedger({journal:newDisk,salt,policy,now:()=>2})]) {
    for(const id of ["a","b","c"]) {expect(ledger.reserve(req(id)).reserved).toBe(true);ledger.markDispatched(id);ledger.settle(id,{inputTokens:8,outputTokens:2});}
  }
  expect(newDisk.lines).toEqual(oldDisk.lines);expect(newDisk.lines).toHaveLength(9);
});
test("unconfigured full capacity remains permissive with shipped omitted booking",()=>{
  const policy=spendTestPolicy({pool:{},maxTrackedSends:1});const old=createShippedSpendLedger({journal:spendTestJournal(),salt,policy,now:()=>2});const next=createSpendReservationLedger({journal:spendTestJournal(),salt,policy,now:()=>2});
  for(const ledger of [old,next]) {expect(ledger.reserve(req("first")).reserved).toBe(true);expect(ledger.reserve({...req("omitted"),alreadySent:true}).reserved).toBe(false);expect(ledger.snapshot("pool","P")?.reserved).toBe(10);}
});
test("later ceiling sees retained ordinary history without continuity checkpoints",()=>{
  const disk=spendTestJournal();const ledger=createSpendReservationLedger({journal:disk,salt,policy:spendTestPolicy({pool:{}}),now:()=>2});
  ledger.reserve(req("retained",100));ledger.settle("retained",{inputTokens:100,outputTokens:0});ledger.reconfigure(spendTestPolicy());
  expect(ledger.reserve(req("blocked",1)).reserved).toBe(false);expect(disk.lines.some(line=>JSON.parse(line).kind==="checkpoint")).toBe(false);
});

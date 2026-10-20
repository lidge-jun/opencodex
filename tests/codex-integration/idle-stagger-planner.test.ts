import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers/repo-root.ts";
import {
  FIVE_HOURS_MS, MAX_ATTEMPTS, MAX_COHORT, MINUTE_MS,
  checkOfflineSlot, planIdleStagger, recoverAttempts, transitionAttempt,
  type OfflineAccount, type PlannerInput, type Attempt,
} from "../../src/codex/idle-stagger-planner.ts";

const MIN = MINUTE_MS;
const T = 1_800_000_000_000;
function account(id: string, overrides: Partial<OfflineAccount> = {}): OfflineAccount {
  return {id, credentialGeneration:"g1", windowGeneration:id+"-w1", evidence:"verified-five-hour",
    state:"unstarted", optedIn:true, healthy:true, weeklyHeadroom:true,
    observedAtMs:T, eligibleAtMs:T, ...overrides};
}
function fixture(accounts: OfflineAccount[], overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {nowMs:T, stableStartMs:T, lastForegroundSettledAtMs:T-60*MIN,
    activeAdmissions:0, activeStreams:0, epoch:1, enabled:true, observeOnly:false,
    idleAfterMs:30*MIN, initialHorizonMs:FIVE_HOURS_MS,
    maxRepairDeferralMs:60*MIN, evidenceTtlMs:15*MIN,
    accounts, ledger:[], ...overrides};
}
function times(x: PlannerInput) {return planIdleStagger(x).slots.map(t=>(t.scheduledMs-T)/MIN);}

for (const n of [2,3,5,16]) test("A01: "+n+" comparable accounts evenly spread across 300-minute cycle", () => {
  const x=fixture(Array.from({length:n}, (_,i)=>account("acct-"+String(i).padStart(3,"0"))));
  const r=planIdleStagger(x);
  assert.equal(r.mode,"offline-plan");
  assert.equal(r.comparableN,n);
  assert.equal(r.slots.length,n);
  assert.equal(r.spacingTargetMs,FIVE_HOURS_MS/n);
  assert.deepEqual(r.slots.map((s,i)=>s.scheduledMs),Array.from({length:n},(_,i)=>T+i*FIVE_HOURS_MS/n));
  assert(r.slots.every(x=>x.kind==="OFFLINE_DIAGNOSTIC_ONLY"));
});
test("A02: changing pool size and order recomputes N deterministically",()=>{
  const xs=Array.from("ABCDE",c=>account(c));
  assert.deepEqual(times(fixture([xs[4],xs[2],xs[0],xs[1],xs[3]])),[0,60,120,180,240]);
  assert.deepEqual(times(fixture(xs.slice(0,2))),[0,150]);
});
test("A03: real admission and streaming lifecycle block all offline slots",()=>{
  const x=fixture([account("A"),account("B")]);
  const slot=planIdleStagger(x).slots[0];
  assert.equal(checkOfflineSlot(x,slot),true);
  assert.equal(planIdleStagger({...x,activeAdmissions:1}).mode,"active");
  assert.equal(planIdleStagger({...x,activeStreams:1}).mode,"active");
  assert.equal(checkOfflineSlot({...x,activeAdmissions:1},slot),false);
  assert.equal(checkOfflineSlot({...x,activeStreams:1},slot),false);
  assert.equal(checkOfflineSlot({...x,epoch:2},slot),false);
});
test("A04: quiet time starts after last foreground *settlement*",()=>{
  const x=fixture([account("A"),account("B")],{lastForegroundSettledAtMs:T-10*MIN,evidenceTtlMs:45*MIN});
  assert.equal(planIdleStagger(x).mode,"quiet");
  assert.equal(planIdleStagger({...x,nowMs:T+20*MIN}).mode,"offline-plan");
});
test("A05: actual early B foreground anchoring invalidates previous plan",()=>{
  const x=fixture([account("A"),account("B")]);
  const old=planIdleStagger(x).slots[1];
  const next=fixture([account("A",{state:"anchored",resetAtMs:T+300*MIN}),
    account("B",{state:"anchored",resetAtMs:T+360*MIN,windowGeneration:"B-genuine"})],
    {nowMs:T+60*MIN,epoch:2,activeAdmissions:1,lastForegroundSettledAtMs:T+60*MIN});
  assert.equal(checkOfflineSlot(next,old),false);
  assert.equal(planIdleStagger(next).mode,"active");
});
test("A06: anchored windows are never synthetic candidates",()=>{
  const x=fixture([account("A",{state:"anchored",resetAtMs:T+300*MIN}),account("B")]);
  assert.deepEqual(planIdleStagger(x).slots.map(s=>s.accountId),["B"]);
});
test("A07: restart-eligible phase repairs obey 60-minute cap",()=>{
  const x=fixture([account("A",{state:"anchored",resetAtMs:T+600*MIN}),
    account("B",{state:"restart-eligible",eligibleAtMs:T+360*MIN})],{nowMs:T+350*MIN,
    lastForegroundSettledAtMs:T+300*MIN,evidenceTtlMs:400*MIN,
    accounts:[account("A",{state:"anchored",resetAtMs:T+600*MIN,observedAtMs:T+350*MIN}),
      account("B",{state:"restart-eligible",eligibleAtMs:T+360*MIN,observedAtMs:T+350*MIN})]});
  assert.equal(planIdleStagger(x).slots[0].scheduledMs,T+420*MIN);
});
test("A08: unstarted sliding/fixed/unknown observations stay observe-only",()=>{
  for(const evidence of ["sliding","fixed","unknown"] as const){
    const p=planIdleStagger(fixture([account("A",{evidence}),account("B")]));
    assert.equal(p.mode,"observe-only");assert.equal(p.slots.length,0);
  }
});
test("A09: fresh, positive five-hour evidence is required (plan name alone is not evidence)",()=>{
  const r=planIdleStagger(fixture([account("A"),account("B",{observedAtMs:T-16*MIN})]));
  assert.equal(r.mode,"observe-only");
  assert.equal(r.comparableN,1);
});
test("A10: ambiguous window generation, credential or eligible instant emits no slot",()=>{
  for(const variant of [{windowGeneration:null},{windowGeneration:""},{credentialGeneration:""},{eligibleAtMs:undefined}]){
    const p=planIdleStagger(fixture([account("A"),account("B",variant)]));
    assert.deepEqual(p.slots.map(s=>s.accountId),[]);
  }
});
test("A11: ambiguous anchored reference fails closed for entire cohort",()=>{
  const p=planIdleStagger(fixture([account("A",{state:"anchored",resetAtMs:undefined}),account("B")]));
  assert.equal(p.mode,"observe-only");assert.equal(p.slots.length,0);
});
test("A12: unknown/exhausted weekly, unhealthy, paused, non-verified excluded from N",()=>{
  const p=planIdleStagger(fixture([account("A"),account("B"),account("C",{weeklyHeadroom:false}),
    account("D",{optedIn:false}),account("E",{healthy:false}),account("F",{evidence:"fixed"})]));
  assert.equal(p.comparableN,2);
});
test("A13: never replay missed scheduling window after restart",()=>{
  const x=fixture([account("A"),account("B")],{nowMs:T+600*MIN,
    lastForegroundSettledAtMs:T+560*MIN,
    accounts:[account("A",{observedAtMs:T+600*MIN}),account("B",{observedAtMs:T+600*MIN})]});
  assert.equal(planIdleStagger(x).slots.length,0);
});
test("A14: moving provider reset hint cannot slide stable local first-use slot",()=>{
  const x=fixture([account("A"),account("B")]);
  const original=planIdleStagger(x).slots[1].scheduledMs;
  const y=fixture([account("A",{observedAtMs:T+10*MIN}),account("B",{observedAtMs:T+10*MIN})],
    {nowMs:T+10*MIN,lastForegroundSettledAtMs:T-50*MIN});
  assert.equal(planIdleStagger(y).slots[0].scheduledMs,original);
});
test("A15: policy disable/observe-only migration produces no planned output",()=>{
  const x=fixture([account("A"),account("B")]);
  assert.equal(planIdleStagger({...x,enabled:false}).mode,"disabled");
  assert.equal(planIdleStagger({...x,observeOnly:true}).mode,"observe-only");
});
test("A16: reserved/sent/ambiguous/verified/failed operations block new intents",()=>{
  for(const stage of ["reserved","send-boundary","sent","ambiguous","verified","failed"] as const){
    const a=account("A");const key:Attempt={accountId:"A",credentialGeneration:"g1",
      windowGeneration:"A-w1",stage,atMs:T,affectedWindows:["short","weekly"]};
    const p=planIdleStagger(fixture([a,account("B")],{ledger:[key]}));
    assert.deepEqual(p.slots.map(x=>x.accountId),["B"]);
  }
});
test("A17: one physical operation covering weekly + short owns ONE reservation",()=>{
  const a:Attempt={accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",
    stage:"reserved",atMs:T,affectedWindows:["short","weekly"]};
  const ledger=transitionAttempt([],a);
  assert.equal(ledger.length,1);assert.deepEqual(ledger[0].affectedWindows,["short","weekly"]);
  assert.equal(transitionAttempt(ledger,a).length,1);
});
test("A18: restart after each reservation/send boundary quarantines uncertain outcomes",()=>{
  const sample:Attempt={accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",
    stage:"reserved",atMs:T,affectedWindows:["short"]};
  for(const stage of ["reserved","send-boundary","sent","ambiguous"] as const){
    const recovered=recoverAttempts([{...sample,stage}]);
    assert.equal(recovered[0].stage,"ambiguous");
    assert.equal(planIdleStagger(fixture([account("A"),account("B")],{ledger:recovered})).slots.length,1);
  }
  assert.equal(recoverAttempts([{...sample,stage:"verified"}])[0].stage,"verified");
});
test("A19: state transitions do not rewind after send or reuse old receipts",()=>{
  const a:Attempt={accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",
    stage:"reserved",atMs:T,affectedWindows:["short"]};
  const r=transitionAttempt([],a);
  assert.equal(transitionAttempt(r,{...a,stage:"sent"})[0].stage,"reserved");
  const boundary=transitionAttempt(r,{...a,stage:"send-boundary",atMs:T+1});
  const sent=transitionAttempt(boundary,{...a,stage:"sent",atMs:T+2});
  assert.equal(transitionAttempt(sent,{...a,stage:"reserved",atMs:T+3})[0].stage,"sent");
  assert.equal(transitionAttempt(sent,{...a,stage:"verified",atMs:T+1})[0].stage,"sent");
  assert.equal(transitionAttempt(sent,{...a,stage:"verified",atMs:T+3})[0].stage,"verified");
});
test("A20: credential replacement invalidates prior plan; different generation is distinct",()=>{
  const x=fixture([account("A"),account("B")]);const slot=planIdleStagger(x).slots[0];
  const replacement=fixture([account("A",{credentialGeneration:"g2",windowGeneration:"A-w2"}),account("B")],{epoch:2});
  assert.equal(checkOfflineSlot(replacement,slot),false);
  const ledger:Attempt[]=[{accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",stage:"ambiguous",atMs:T,affectedWindows:["short"]}];
  assert.equal(planIdleStagger({...replacement,ledger}).slots.length,2);
});
test("A21: growth is bounded, with fail-closed ledger at capacity",()=>{
  const a:Attempt={accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",
    stage:"reserved",atMs:T,affectedWindows:["short"]};
  const ledger:Array<Attempt>=Array.from({length:MAX_ATTEMPTS},(_,i)=>({...a,windowGeneration:"w"+i}));
  assert.equal(transitionAttempt(ledger,{...a,windowGeneration:"new"}).length,MAX_ATTEMPTS);
  assert.equal(planIdleStagger(fixture([account("A"),account("B")],{ledger})).mode,"observe-only");
  assert.equal(planIdleStagger(fixture(Array.from({length:MAX_COHORT+1},(_,i)=>account(String(i))))).mode,"observe-only");
});
test("A22: large verified cohort is deterministic under bounded time",()=>{
  const accounts=Array.from({length:MAX_COHORT},(_,i)=>account("a"+String(i).padStart(5,"0")));
  const x=fixture(accounts);const before=performance.now();const p=planIdleStagger(x);
  const elapsed=performance.now()-before;
  assert.equal(p.slots.length,MAX_COHORT);
  assert.deepEqual(p.slots,planIdleStagger(x).slots);
  assert(elapsed<5000,"1024 account offline plan exceeded budget: "+elapsed.toFixed(1)+"ms");
});
test("A23: malformed inputs and duplicate account identities fail closed",()=>{
  const x=fixture([account("A"),account("B")]);
  assert.equal(planIdleStagger({...x,nowMs:NaN}).mode,"observe-only");
  assert.equal(planIdleStagger({...x,accounts:[account("A"),account("A")]}).mode,"observe-only");
  assert.equal(planIdleStagger({...x,activeAdmissions:-1}).mode,"observe-only");
});
test("A24: queue and cohort churn conservatively invalidate previous epochs",()=>{
  const first=fixture([account("A"),account("B")]);
  const prev=planIdleStagger(first).slots[1];
  const queued={...first,activeAdmissions:3,epoch:2};
  assert.equal(planIdleStagger(queued).mode,"active");
  const expanded={...first,epoch:3,accounts:[account("A"),account("B"),account("C")]};
  assert.equal(planIdleStagger(expanded).comparableN,3);
  assert.equal(checkOfflineSlot(expanded,prev),false);
  const shrunk={...first,epoch:4,accounts:[account("A"),account("B")]};
  assert.equal(planIdleStagger(shrunk).comparableN,2);
  assert.equal(checkOfflineSlot(shrunk,prev),false);
});
test("A25: migration disabled -> observe-only preserves attempted-window tombstones",()=>{
  const entry:Attempt={accountId:"A",credentialGeneration:"g1",windowGeneration:"A-w1",
    stage:"ambiguous",atMs:T,affectedWindows:["short","weekly"]};
  const x=fixture([account("A"),account("B")],{ledger:[entry]});
  assert.equal(planIdleStagger({...x,enabled:false}).mode,"disabled");
  assert.equal(planIdleStagger({...x,observeOnly:true}).mode,"observe-only");
  assert.deepEqual(planIdleStagger(x).slots.map(v=>v.accountId),["B"]);
});
test("A26: deterministic failure fixtures quarantine affected account without affecting sibling",()=>{
  const failureCases=JSON.parse(readFileSync(fixturePath("idle-stagger", "failure-cases.json"),"utf8")) as {
    cases: Array<{name:string,override:Partial<OfflineAccount>,expectedAccountSlots:number}>
  };
  for(const {name:label,override,expectedAccountSlots} of failureCases.cases) {
    assert.equal(expectedAccountSlots,0);
    const p=planIdleStagger(fixture([account("A"),account("B"),account("C",override)]));
    assert.equal(p.comparableN,2,label);
    assert.deepEqual(p.slots.map(x=>x.accountId),["A","B"],label);
  }
});

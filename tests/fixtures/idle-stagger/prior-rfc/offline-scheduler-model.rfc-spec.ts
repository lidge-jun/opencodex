import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_POLICY, MINUTE_MS, planIdleStagger, offlineDispatchGuard,
  type OfflineAccount, type OfflineInput} from './offline-scheduler-model.ts';
const m = (x: number) => x * MINUTE_MS;
const base = 60 * 60 * 1000;
function account(id: string, extras: Partial<OfflineAccount> = {}): OfflineAccount {
  return {id,plan:'plus',windowKind:'five-hour',state:'UNSTARTED_CANDIDATE',
    healthy:true,optedIn:true,weeklyHeadroom:true,credentialGeneration:'g1',
    eligibleAtMs:base,windowEpochKey:id+'-window1',attemptState:'none',
    providerActivationApproved:false,...extras};
}
function input(accounts: OfflineAccount[], x: Partial<OfflineInput> = {}): OfflineInput {
  return {accounts,nowMs:base,lastRealTrafficAtMs:0,policyStartAtMs:base,
    activeRequests:0,planEpoch:1,policy:{...DEFAULT_POLICY},...x};
}
const slotMin = (p: ReturnType<typeof planIdleStagger>) => p.intents.map(x => (x.scheduledAtMs - base)/MINUTE_MS);
test('T01: two eligible Plus accounts stagger 150 minutes, no upstream calls',()=>{
  const p=planIdleStagger(input([account('A'),account('B')]));
  assert.equal(p.mode,'IDLE_PLANNING'); assert.equal(p.targetSpacingMinutes,150);
  assert.deepEqual(slotMin(p),[0,150]);
  assert(p.intents.every(x=>x.evidence==='OFFLINE_PLAN_ONLY'));
});
test('T02: three and five Plus accounts correctly spread over 300 minutes',()=>{
  for(const n of [3,5]){
    const p=planIdleStagger(input(Array.from({length:n},(_,i)=>account(String.fromCharCode(65+i)))));
    const slots=slotMin(p); assert.equal(slots.length,n);
    for(let i=0;i<n;i++)assert.equal(slots[i],i*300/n);
  }
});
test('T03: foreground request overrides and cancels obsolete B intent',()=>{
  const before=planIdleStagger(input([account('A'),account('B')]));
  const oldB=before.intents.find(x=>x.accountId==='B')!;
  const after=input([
    account('A',{state:'ACTIVE_ANCHORED',observedResetAtMs:base+m(300)}),
    account('B',{state:'ACTIVE_ANCHORED',observedResetAtMs:base+m(360),windowEpochKey:'B-anchored'})
  ],{planEpoch:2,activeRequests:1,nowMs:base+m(60),lastRealTrafficAtMs:base+m(60)});
  assert.equal(planIdleStagger(after).mode,'ACTIVE');
  assert.equal(offlineDispatchGuard(after,oldB).ok,false);
});
test('T04: anchored windows are immutable phase inputs, not warmup candidates',()=>{
  const p=planIdleStagger(input([account('A',{state:'ACTIVE_ANCHORED',observedResetAtMs:base+m(300)}),account('B')]));
  assert.deepEqual(p.intents.map(x=>x.accountId),['B']);
});
test('T05: 60-minute max repair deferral after B early real use',()=>{
  const x=input([
    account('A',{state:'ACTIVE_ANCHORED',observedResetAtMs:base+m(600)}),
    account('B',{state:'RESTART_ELIGIBLE',eligibleAtMs:base+m(360)})
  ],{nowMs:base+m(350),policyStartAtMs:base});
  const p=planIdleStagger(x);
  assert.equal(p.intents.length,1);
  assert.equal((p.intents[0].scheduledAtMs-base)/MINUTE_MS,420);
});
test('T06: sliding remote reset cannot move a local slot',()=>{
  const accounts=[account('A'),account('B')];
  const first=planIdleStagger(input(accounts));
  const later=planIdleStagger(input(accounts,{nowMs:base+m(10)}));
  assert.equal(first.intents.find(x=>x.accountId==='B')?.scheduledAtMs, later.intents.find(x=>x.accountId==='B')?.scheduledAtMs);
  assert(!later.intents.some(x=>x.accountId==='A'));
});
test('T07: weekly-only, weekly-exhausted and unknown accounts do not count towards N',()=>{
  const p=planIdleStagger(input([account('A'),account('B'),account('C',{windowKind:'weekly-only'}),
    account('D',{weeklyHeadroom:false}),account('E',{state:'UNKNOWN'})]));
  assert.equal(p.eligibleN,2);assert.equal(p.targetSpacingMinutes,150);
});
test('T08: unknown or account without stable local epoch is never scheduled',()=>{
  const p=planIdleStagger(input([account('A'),account('B',{windowEpochKey:undefined}),account('C',{state:'UNKNOWN'})]));
  assert.deepEqual(p.intents.map(x=>x.accountId),['A']);
});
test('T09: quiet period suppresses activation',()=>{
  const v=input([account('A'),account('B')],{lastRealTrafficAtMs:base-m(5)});
  assert.equal(planIdleStagger(v).mode,'COOLDOWN');
});
test('T10: real arrival or stale epoch always invalidates dispatch guard',()=>{
  const v=input([account('A'),account('B')]);
  const intent=planIdleStagger(v).intents[0];
  assert.equal(offlineDispatchGuard({...v,activeRequests:1},intent).ok,false);
  assert.equal(offlineDispatchGuard({...v,planEpoch:2},intent).ok,false);
});
test('T11: unknown upstream permission blocks guard even if a slot is due',()=>{
  const v=input([account('A'),account('B')]);
  const intent=planIdleStagger(v).intents[0];
  assert.equal(offlineDispatchGuard(v,intent).reason,'upstream-contract-not-approved');
});
test('T12: even approved intent is in-memory guard only, and duplicate ledger blocks',()=>{
  const A=account('A',{providerActivationApproved:true});const B=account('B');
  const v=input([A,B]);const intent=planIdleStagger(v).intents[0];
  assert.equal(offlineDispatchGuard(v,intent).ok,true);
  assert.equal(offlineDispatchGuard(input([{...A,attemptState:'sent'},B]),intent).ok,false);
});
test('T13: feature off always disables policy',()=>{
  const v=input([account('A'),account('B')],{policy:{...DEFAULT_POLICY,enabled:false}});
  assert.equal(planIdleStagger(v).mode,'DISABLED');
});
test('T14: missed slots are not replayed in a burst',()=>{
  const v=input([account('A'),account('B')],{nowMs:base+m(720)});
  const p=planIdleStagger(v);assert.equal(p.intents.length,0);
});
test('T15: account count recomputes dynamically',()=>{
  const five=planIdleStagger(input(Array.from('ABCDE',c=>account(c))));
  const two=planIdleStagger(input([account('A'),account('B')]));
  assert.equal(five.targetSpacingMinutes,60);assert.equal(two.targetSpacingMinutes,150);
});

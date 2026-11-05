/** Purpose: Verify the SSOT D-484 Claude policy boundaries and the R-11 GPT transition; installed-kernel simulation has separate release proof.
 * Tags: ocx, routing, quota, shares, regression
 * Usage: bun test ocx_weighted_routing.test.ts
 */
import { expect, test } from "bun:test";
import { machineRoutingWeights, type MachineQuota } from "../../src/routing/machine-weighted-routing";
const now = Date.UTC(2026, 9, 2);
const hour = 60 * 60_000;
const near = (override: MachineQuota = {}): MachineQuota => ({ weeklyPercent: 40, weeklyResetAt: now + hour, fiveHourPercent: 59, shortPercent: 59, updatedAt: now, ...override });
const providerRows = ["anthropic"];
for (const provider of providerRows) {
  test(`${provider}: the target weight has exactly half the mass without Pro narrowing`, () => {
    for(const size of [2,3,5,7,10,50]) {
      const ids=Array.from({length:size},(_,i)=>`a${i}`);
      const r=machineRoutingWeights(provider,ids,id=>near({weeklyResetAt:now+(id==="a1"?1:12)*hour}),()=>"pro",now);
      expect(r.eligible).toEqual(ids);
      expect(r.weights.get("a1")!/[...r.weights.values()].reduce((a,b)=>a+b,0)).toBe(.5);
    }
  });
  const route = (override: MachineQuota = {}, quota: MachineQuota | null = near(override)) => machineRoutingWeights(provider, ["a", "b", "c"], id => id === "a" ? quota : near({weeklyResetAt: now + 48 * hour}), undefined, now);
  test(`${provider}: 59 -> 60 -> 61 -> 59 switches off and back on for this account`, () => {
    for (const [usage, mode] of [[59,"weighted"],[60,"round-robin"],[61,"round-robin"],[59,"weighted"]] as const) {
      expect(route({fiveHourPercent: usage, shortPercent: usage}).mode).toBe(mode);
    }
  });
  test(`${provider}: weekly remaining 2.0% off, 2.1% on, 0% off`, () => {
    expect(route({weeklyPercent:98}).mode).toBe("round-robin");
    expect(route({weeklyPercent:97.9}).mode).toBe("weighted");
    expect(route({weeklyPercent:100}).mode).toBe("round-robin");
  });
  test(`${provider}: missing, stale, future and invalid data disable only that account`, () => {
    for (const quota of [null, near({updatedAt:undefined}), near({updatedAt:now-16*60_000}), near({updatedAt:now+1}), near({weeklyPercent:undefined}), near({weeklyResetAt:undefined}), near({fiveHourPercent:undefined,shortPercent:undefined}), near({weeklyPercent:NaN}), near({fiveHourPercent:Infinity,shortPercent:Infinity})]) expect(route({},quota).mode).toBe("round-robin");
  });
  test(`${provider}: reset boundaries, seconds, ties and duplicate candidates`, () => {
    expect(route({weeklyResetAt:now}).mode).toBe("round-robin");
    expect(route({weeklyResetAt:now+24*hour}).mode).toBe("weighted");
    expect(route({weeklyResetAt:now+24*hour+1}).mode).toBe("round-robin");
    expect(route({weeklyResetAt:(now+hour)/1000,updatedAt:now/1000}).mode).toBe("weighted");
    const tied=machineRoutingWeights(provider,["b","a","c","a"],()=>near(),undefined,now);
    expect(tied.eligible).toEqual(["b","a","c"]);
    expect(tied.weights.get("a")).toBe(2);
  });
  test(`${provider}: earliest disabled target does not disable another qualifying account`, () => {
    const r=machineRoutingWeights(provider,["a","b","c"], id=>near({weeklyResetAt:now+(id==="a"?1:2)*hour,fiveHourPercent:id==="a"?60:59,shortPercent:id==="a"?60:59}),undefined,now);
    expect([...r.weights.values()]).toEqual([1,2,1]);
  });
  test(`${provider}: no candidates and one candidate have ordinary behavior`,()=>{
    expect(machineRoutingWeights(provider,[],()=>near(),undefined,now).eligible).toEqual([]);
    expect(machineRoutingWeights(provider,["a"],()=>near(),undefined,now).mode).toBe("round-robin");
  });
}
test("R-11: GPT and Claude use the same reset-near weights after the apply window",()=>{
  for(const size of [2,3,5]) {
    const ids=Array.from({length:size},(_,i)=>`a${i}`);
    const quota=(id:string)=>near({weeklyResetAt:now+(id==="a1"?1:12)*hour});
    for(const provider of ["openai","anthropic"]) {
      const r=machineRoutingWeights(provider,ids,quota,()=>"pro",now);
      expect(r.mode).toBe("weighted");
      expect(r.eligible).toEqual(ids);
      expect([...r.weights.values()]).toEqual(ids.map(id=>id==="a1"?size-1:1));
    }
  }
});
test("R-11: one eligible pin account keeps ordinary rotation",()=>{
  const r=machineRoutingWeights("openai",["hand"],()=>near(),undefined,now);
  expect(r.mode).toBe("round-robin");
  expect(r.eligible).toEqual(["hand"]);
  expect([...r.weights.values()]).toEqual([1]);
});
test("R-11: missing, invalid or stale GPT quota keeps ordinary rotation",()=>{
  for(const quota of [null,near({shortPercent:undefined}),near({shortPercent:NaN}),near({shortPercent:60}),near({weeklyPercent:98}),near({updatedAt:undefined}),near({updatedAt:now-16*60_000}),near({shortObservedAt:now-16*60_000})]) {
    const r=machineRoutingWeights("openai",["a","b","c"],id=>id==="a"?quota:null,undefined,now);
    expect(r.mode).toBe("round-robin");
    expect([...r.weights.values()]).toEqual([1,1,1]);
  }
});
test("non-GPT/non-Claude Antigravity policy keeps the inherited family windows",()=>{
  const ag=()=>({customWindows:[{label:"Gem (Weekly)",percent:30,resetAt:now+24*hour},{label:"Cla (Weekly)",percent:30,resetAt:now+96*hour}],updatedAt:now});
  expect(machineRoutingWeights("google-antigravity",["a","b"],ag,undefined,now,"gem").mode).toBe("weighted");
  expect(machineRoutingWeights("google-antigravity",["a","b"],ag,undefined,now,"cla").mode).toBe("round-robin");
});

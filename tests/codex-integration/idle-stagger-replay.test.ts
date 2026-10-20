import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers/repo-root.ts";
import { compareTraceFixtures, evaluateTrace, type ReplayTrace } from "../../src/codex/idle-stagger-replay.ts";

const parsed=JSON.parse(readFileSync(fixturePath("idle-stagger", "paired-traces.json"),"utf8")) as {description:string,traces:ReplayTrace[]};

test("R01: paired passive, legacy and offline-policy fixture metrics use identical cohorts",()=>{
  const r=compareTraceFixtures(parsed.traces);assert.equal(r.length,3);
  assert(r.every(x=>x.elapsedMs===18_000_000));
  for(const row of r){
    assert.equal(row.allKnownUnusableMs+row.anyKnownUsableMs+row.unknownCoverageMs,row.elapsedMs);
  }
});
test("R02: unknown coverage is separate from actually unavailable time",()=>{
  const x=compareTraceFixtures(parsed.traces);
  const passive=x.find(r=>r.traceName==="passive")!;
  assert.equal(passive.allKnownUnusableMs,7_200_000);
  assert.equal(passive.unknownCoverageMs,3_600_000);
  assert.equal(passive.anyKnownUsableMs,7_200_000);
  assert.equal(passive.unknownAccountMs,3_600_000);
});
test("R03: hypothetical policy improvement is measurable but NOT provider evidence",()=>{
  const results=compareTraceFixtures(parsed.traces);
  const passive=results.find(x=>x.traceName==="passive")!;
  const legacy=results.find(x=>x.traceName==="legacy")!;
  const plan=results.find(x=>x.traceName==="offline-policy")!;
  assert(plan.allKnownUnusableMs<passive.allKnownUnusableMs);
  assert(plan.allKnownUnusableMs<legacy.allKnownUnusableMs);
  assert(plan.unknownCoverageMs>0);
});
test("R04: reject traces with missing or extra accounts",()=>{
  const t=structuredClone(parsed.traces[0]);
  t.observations[1].accounts={A:"usable"};
  assert.throws(()=>evaluateTrace(t),/changing cohort/);
});
test("R05: reject gaps, overlaps, invalid state and unsorted timestamps",()=>{
  for(const mutate of [
    (t:ReplayTrace)=>{t.observations[0].atMs=1;},
    (t:ReplayTrace)=>{t.observations[2].atMs=t.observations[1].atMs;},
    (t:ReplayTrace)=>{t.observations[1].accounts.A="yes" as never;},
    (t:ReplayTrace)=>{t.endMs=0;},
  ]) {
    const t=structuredClone(parsed.traces[0]);mutate(t);
    assert.throws(()=>evaluateTrace(t));
  }
});
test("R06: reject unpaired baselines and mismatched cohort/time horizons",()=>{
  assert.throws(()=>compareTraceFixtures(parsed.traces.slice(0,2)));
  const changed=structuredClone(parsed.traces);changed[2].endMs+=10;
  assert.throws(()=>compareTraceFixtures(changed));
});
test("R07: high-volume trace events cannot exhaust the replay evaluator",()=>{
  const rows=Array.from({length:10_001},(_,i)=>({atMs:i,accounts:{A:"usable" as const}}));
  assert.throws(()=>evaluateTrace({name:"large",startMs:0,endMs:10_002,observations:rows}),/bounds/);
});

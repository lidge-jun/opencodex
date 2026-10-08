import { expect, test } from "bun:test";
import { createSpendReservationLedger, sharedSpendLedger, type SpendReservationLedger, type SpendSeed } from "../../src/lib/spend-reservation-ledger";
import { createShippedSpendLedger, spendAlias, spendTestJournal, spendTestPolicy, testSpendSalt as salt } from "../helpers/shipped-spend-ledger";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSpendLedgerServerLifecycle } from "../../src/server/index/spend-ledger-lifecycle";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
const request = (sendId: string, scopes = {poolId:"P"}, tokens=0) => ({sendId,scopes,inputTokens:tokens,outputCeilingTokens:0});
const seed = (ledger: SpendReservationLedger, id="seed", scopes={poolId:"P"}, tokens=0): SpendSeed => {
  const decision=ledger.reserveSeed(request(id,scopes,tokens)); expect(decision.reserved).toBe(true);
  if(!decision.reserved) throw new Error("seed denied"); return decision.seed;
};
const reported = (ledger: SpendReservationLedger, anchor: SpendSeed, id: string, tokens=0) => ledger.reserveReportedFromSeed(anchor,{sendId:id,inputTokens:tokens,outputCeilingTokens:0});
const factory = (disk=spendTestJournal(), scopeCap=1, sendCap=1) => createSpendReservationLedger({journal:disk,salt,policy:spendTestPolicy({maxTrackedScopes:scopeCap,maxTrackedSends:sendCap}),now:()=>2});
test("normal initial seed refuses before wire at full send capacity",()=>{
  const ledger=factory(); const first=seed(ledger); expect(ledger.reserveSeed(request("blocked"))).toMatchObject({reserved:false,denial:{reason:"tracking-capacity-exhausted"}});
  expect(ledger.knows(first.sendId)).toBe(true);
});
test("40 retained plus 70 delayed usage survives old replay as 110",()=>{
  const disk=spendTestJournal(); const ledger=factory(disk); const anchor=seed(ledger,"first",{poolId:"P"},40);
  ledger.markDispatched(anchor.sendId); ledger.settle(anchor.sendId,{inputTokens:40,outputTokens:0});
  expect(reported(ledger,anchor,"delayed",70)).toBe(true); ledger.markDispatched("delayed"); ledger.settle("delayed",{inputTokens:70,outputTokens:0});
  expect(ledger.forgetResolved([anchor.sendId,"delayed"])).toBe(true); expect(ledger.finishSeed(anchor)).toBe(true);
  const old=createShippedSpendLedger({journal:disk,salt,policy:spendTestPolicy(),now:()=>2});
  expect(old.corruptRecords).toBe(0); expect(old.snapshot("pool","P")?.settled).toBe(110);
  expect(old.reserve(request("next",{poolId:"P"},1)).reserved).toBe(false);
});
test("concurrent reporters stay within Msend times L with zero new scope keys", async()=>{
  const disk=spendTestJournal(); const ledger=factory(disk,1,2); const anchors=[seed(ledger,"a"),seed(ledger,"b")];
  const reporters=anchors.map(()=>ledger.registerReporter());
  await Promise.all(anchors.map(async(anchor,index)=>{ for(let n=1;n<4;n++) expect(reported(ledger,anchor,`${index}-${n}`,1)).toBe(true); }));
  expect(disk.lines.filter(line=>JSON.parse(line).kind==="reserve")).toHaveLength(8);
  expect(new Set(disk.lines.flatMap(line=>JSON.parse(line).targets?.map((r:{scope:string;alias:string})=>r.scope+":"+r.alias)??[])).size).toBe(1);
  expect(ledger.reserveSeed(request("new" )).reserved).toBe(false); reporters.forEach(r=>r.close()); await ledger.waitForReporterDrain();
});
test("sequential distinct scope seeds cannot bypass normal scope cap",()=>{
  const ledger=factory(); const anchor=seed(ledger,"first",{poolId:"P"},100);
  ledger.markDispatched(anchor.sendId); ledger.settle(anchor.sendId,{inputTokens:100,outputTokens:0}); ledger.forgetResolved([anchor.sendId]); ledger.finishSeed(anchor);
  ledger.reconfigure(spendTestPolicy({maxTrackedScopes:1,maxTrackedSends:1,poolAliases:{[spendAlias("pool","P")]:"P"}}));
  expect(ledger.reserveSeed(request("next",{poolId:"Q"},1))).toMatchObject({reserved:false,denial:{reason:"tracking-capacity-exhausted"}});
});
test("live zero-token seed pins every target",()=>{
  const disk=spendTestJournal();const ledger=factory(disk,3); const anchor=seed(ledger,"zero",{rootId:"R",identityId:"I",poolId:"P"});
  ledger.prune(1e12); expect(reported(ledger,anchor,"report",7)).toBe(true);
  for(const [scope,id] of [["root","R"],["identity","I"],["pool","P"]] as const) expect(ledger.snapshot(scope,id)?.reserved).toBe(7);
  expect(disk.lines.some(line=>JSON.parse(line).kind==="drop")).toBe(false);
});
test("settle lost then durable forget preserves shipped-reader liability",()=>{
  const disk=spendTestJournal();const ledger=factory(disk); const anchor=seed(ledger,"s",{poolId:"P"},10);
  ledger.markDispatched("s"); expect(reported(ledger,anchor,"lost",20)).toBe(true);ledger.markDispatched("lost");
  ledger.settle("s",{inputTokens:5,outputTokens:0}); ledger.markLost("lost"); expect(ledger.forgetResolved(["s","lost"])).toBe(true);
  expect(ledger.finishSeed(anchor)).toBe(true); expect(ledger.knows("s")).toBe(false);
  expect(createShippedSpendLedger({journal:disk,salt,now:()=>2}).snapshot("pool","P")).toMatchObject({settled:5,unresolved:20});
});
test("orphan replay forgets send IDs without reducing totals",()=>{
  const disk=spendTestJournal();const ledger=factory(disk);seed(ledger,"orphan",{poolId:"P"},10);ledger.markDispatched("orphan");
  const replay=factory(disk); expect(replay.knows("orphan")).toBe(false); expect(replay.snapshot("pool","P")?.unresolved).toBe(10);
  expect(JSON.parse(disk.lines.at(-1)!).kind).toBe("forget");
});
test("foreign closed and abandoned seeds cannot authorize reported overflow",()=>{
  const ledger=factory();const foreign=seed(factory());expect(reported(ledger,foreign,"foreign")).toBe(false);
  const anchor=seed(ledger); expect(reported(ledger,{sendId:anchor.sendId},"forged")).toBe(false);
  ledger.abandon(anchor.sendId);expect(reported(ledger,anchor,"abandoned")).toBe(false);expect(ledger.finishSeed(anchor)).toBe(true);
  expect(reported(ledger,anchor,"closed")).toBe(false);
});
test("terminal waits for reporters and failed persistence cannot reclaim a seed",async()=>{
  const disk=spendTestJournal();const ledger=factory(disk);const anchor=seed(ledger,"seed",{poolId:"P"},10);ledger.markDispatched("seed");
  const reporter=ledger.registerReporter(); let drained=false; const drain=ledger.waitForReporterDrain().then(()=>{drained=true;});
  await Promise.resolve();expect(drained).toBe(false);expect(ledger.finishSeed(anchor)).toBe(false);
  reporter.close();reporter.close();await drain;expect(drained).toBe(true);
  disk.failAppend=true; expect(ledger.settle("seed",{inputTokens:7,outputTokens:0})).toBe(true);
  expect(ledger.forgetResolved(["seed"])).toBe(false);expect(ledger.finishSeed(anchor)).toBe(false);expect(ledger.knows("seed")).toBe(true);
  disk.failAppend=false;expect(ledger.settle("seed",{inputTokens:7,outputTokens:0})).toBe(false);
  disk.failAppend=true;expect(ledger.forgetResolved(["seed"])).toBe(false);expect(ledger.finishSeed(anchor)).toBe(false);
  disk.failAppend=false;expect(ledger.forgetResolved(["seed"])).toBe(true);expect(ledger.finishSeed(anchor)).toBe(true);
  const delayedDisk = spendTestJournal();
  const delayedLedger = factory(delayedDisk);
  const delayedSeed = seed(delayedLedger, "initial", { poolId: "P" }, 40);
  delayedLedger.markDispatched("initial");
  delayedDisk.failAppend = true;
  expect(reported(delayedLedger, delayedSeed, "physical-but-unwritten", 70)).toBe(true);
  delayedLedger.markDispatched("physical-but-unwritten");
  expect(delayedLedger.snapshot("pool", "P")?.reserved).toBe(110);
  expect(delayedLedger.markLost("physical-but-unwritten")).toBe(true);
  expect(delayedLedger.finishSeed(delayedSeed)).toBe(false);
  delayedDisk.failAppend = false;
  expect(delayedLedger.markLost("physical-but-unwritten")).toBe(false);
  expect(delayedLedger.markLost("initial")).toBe(true);
  expect(delayedLedger.forgetResolved(["initial", "physical-but-unwritten"])).toBe(true);
  expect(delayedLedger.finishSeed(delayedSeed)).toBe(true);
  expect(createShippedSpendLedger({ journal: delayedDisk, salt, now: () => 2 }).snapshot("pool", "P")?.unresolved).toBe(110);
  // Listener shutdown retains the home owner until enforced reporters finish.
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-seed-drain-"));
  process.env.OPENCODEX_HOME = home;
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  let shutdownReporter: ReturnType<SpendReservationLedger["registerReporter"]> | undefined;
  try {
    lifecycle.configure({ pool: { maxTokens: 100 } }, undefined, ["P"]);
    const shared = sharedSpendLedger();
    shutdownReporter = shared.registerReporter();
    const listener = lifecycle.track({ stop: async () => {} });
    let stopped = false;
    const stopping = Promise.resolve(listener.stop()).then(() => { lifecycle.release(); stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false); expect(spendLedgerOwnerSnapshot().ownership).toBe("held");
    shutdownReporter.close(); await stopping;
    expect(stopped).toBe(true); expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
  } finally {
    shutdownReporter?.close(); lifecycle.release();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});
test("ceiling removal does not drop seeded accounting",()=>{
  const disk=spendTestJournal();const ledger=factory(disk);const anchor=seed(ledger);ledger.reconfigure(spendTestPolicy({pool:{}}));
  expect(reported(ledger,anchor,"delayed",70)).toBe(true);ledger.markDispatched("delayed");ledger.settle("delayed",{inputTokens:70,outputTokens:0});
  expect(createShippedSpendLedger({journal:disk,salt,now:()=>2}).snapshot("pool","P")?.settled).toBe(70);
});

for (const sends of [1, 2]) test(`terminal usage survives append failure without another tracker settlement (${sends} sends)`, async () => {
  const disk = spendTestJournal();
  const ledger = createSpendReservationLedger({ journal: disk, salt, now: () => 2,
    policy: spendTestPolicy({ pool: { maxTokens: 50 } }) });
  const tracker = createRequestSpendTracker({ provider: "P", spendInputEstimateTokens: 1 }, undefined, ledger);
  const anchor = tracker.ensureSeed({ poolId: "P" });
  if (!anchor) throw new Error("seed denied");
  const reporter = tracker.beginReporter();
  for (let ordinal = 1; ordinal <= sends; ordinal++) reporter.start(anchor, ordinal);
  reporter.report(sends);
  reporter.close();
  disk.failAppend = true;
  tracker.settle({ inputTokens: 70, outputTokens: 0 });
  // A terminal write failure must survive without another caller settlement.
  await Promise.resolve();
  expect(ledger.snapshot("pool", "P")).toMatchObject({ settled: 70, reserved: 0, unresolved: sends - 1 });
  expect(ledger.knows(anchor.sendId)).toBe(true);
  expect(disk.lines.some(line => JSON.parse(line).kind === "forget")).toBe(false);
  disk.failAppend = false;
  expect(ledger.reserve(request("next", { poolId: "P" }, 1))).toMatchObject({
    reserved: false, denial: { reason: "spend-limit-exceeded", projected: 70 + sends },
  });
  expect(ledger.knows(anchor.sendId)).toBe(false);
  const old = createShippedSpendLedger({ journal: disk, salt, now: () => 2 });
  expect(old.snapshot("pool", "P")).toMatchObject({ settled: 70, unresolved: sends - 1 });
  expect(old.corruptRecords).toBe(0);
});

test("partial pending flush preserves reserve dispatch and terminal order without duplicate liability", () => {
  const disk = spendTestJournal();
  const append = disk.append.bind(disk);
  let writesLeft = Number.POSITIVE_INFINITY;
  disk.append = line => {
    if (writesLeft-- <= 0) throw new Error("partial flush unavailable");
    append(line);
  };
  const ledger = createSpendReservationLedger({ journal: disk, salt, now: () => 2,
    policy: spendTestPolicy({ pool: { maxTokens: 50 } }) });
  const anchor = seed(ledger, "initial", { poolId: "P" }, 1);
  ledger.markDispatched("initial");
  writesLeft = 0;
  expect(reported(ledger, anchor, "terminal", 1)).toBe(true);
  expect(ledger.markDispatched("terminal")).toBe(true);
  expect(ledger.markLost("initial")).toBe(true);
  expect(ledger.settle("terminal", { inputTokens: 70, outputTokens: 0 })).toBe(true);
  expect(ledger.settle("terminal", { inputTokens: 700, outputTokens: 0 })).toBe(false);
  expect(ledger.markLost("terminal")).toBe(false);
  expect(ledger.snapshot("pool", "P")).toMatchObject({ settled: 70, reserved: 0, unresolved: 1 });
  writesLeft = 1;
  expect(ledger.forgetResolved(["initial", "terminal"])).toBe(false);
  expect(disk.lines.map(line => JSON.parse(line).kind)).toEqual(["reserve", "dispatch", "reserve"]);
  expect(ledger.knows("terminal")).toBe(true);
  writesLeft = Number.POSITIVE_INFINITY;
  expect(ledger.reserve(request("next", { poolId: "P" }, 1))).toMatchObject({
    reserved: false, denial: { reason: "spend-limit-exceeded", projected: 72 },
  });
  expect(disk.lines.map(line => JSON.parse(line).kind)).toEqual(["reserve", "dispatch", "reserve", "dispatch", "lost", "settle"]);
  expect(ledger.forgetResolved(["initial", "terminal"])).toBe(true);
  expect(ledger.finishSeed(anchor)).toBe(true);
  expect(createShippedSpendLedger({ journal: disk, salt, now: () => 2 }).snapshot("pool", "P"))
    .toMatchObject({ settled: 70, unresolved: 1 });
});

test("completed trackers reclaim seeds while another tracker still reports", async () => {
  const disk = spendTestJournal();
  const ledger = factory(disk, 1, 2);
  const busy = createRequestSpendTracker({ provider: "P" }, undefined, ledger);
  const busySeed = busy.ensureSeed({});
  if (!busySeed) throw new Error("busy seed denied");
  const busyReporter = busy.beginReporter();
  busyReporter.start(busySeed, 1);
  let drained = false;
  const drain = ledger.waitForReporterDrain().then(() => { drained = true; });
  for (let index = 0; index < 3; index++) {
    const tracker = createRequestSpendTracker({ provider: "P" }, undefined, ledger);
    const anchor = tracker.ensureSeed({});
    expect(anchor).toBeDefined();
    if (!anchor) throw new Error("overlapping seed denied");
    const reporter = tracker.beginReporter();
    reporter.start(anchor, 1);
    tracker.settle({ inputTokens: 1, outputTokens: 0 });
    expect(ledger.knows(anchor.sendId)).toBe(true);
    reporter.close();
    expect(ledger.knows(anchor.sendId)).toBe(false);
  }
  await Promise.resolve();
  expect(drained).toBe(false);
  busyReporter.close();
  busy.settle({ inputTokens: 1, outputTokens: 0 });
  await drain;
  expect(drained).toBe(true);
  expect(ledger.knows(busySeed.sendId)).toBe(false);
  expect(createShippedSpendLedger({ journal: disk, salt, now: () => 2 }).snapshot("pool", "P")?.settled).toBe(4);
});

test("later admission retries tracker cleanup after partial durable forgetting fails", async () => {
  const disk = spendTestJournal();
  const append = disk.append.bind(disk);
  let forgetsBeforeFailure = 1;
  disk.append = line => {
    if (JSON.parse(line).kind === "forget" && forgetsBeforeFailure-- <= 0) throw new Error("forget unavailable");
    append(line);
  };
  const ledger = factory(disk);
  const tracker = createRequestSpendTracker({ provider: "P", spendInputEstimateTokens: 1 }, undefined, ledger);
  const anchor = tracker.ensureSeed({});
  if (!anchor) throw new Error("seed denied");
  const reporter = tracker.beginReporter();
  reporter.start(anchor, 1);
  reporter.start(anchor, 2);
  reporter.close();
  tracker.settle({ inputTokens: 70, outputTokens: 0 });
  await Promise.resolve();
  expect(disk.lines.filter(line => JSON.parse(line).kind === "forget")).toHaveLength(1);
  expect(ledger.reserveSeed(request("still-full"))).toMatchObject({ reserved: false, denial: { reason: "tracking-capacity-exhausted" } });
  forgetsBeforeFailure = Number.POSITIVE_INFINITY;
  // No second settle call: ordinary admission must release the durable completed seed.
  expect(ledger.reserveSeed(request("recovered"))).toMatchObject({ reserved: true });
  expect(disk.lines.filter(line => JSON.parse(line).kind === "forget")).toHaveLength(2);
  expect(createShippedSpendLedger({ journal: disk, salt, now: () => 2 }).snapshot("pool", "P"))
    .toMatchObject({ settled: 70, unresolved: 1 });
});

test("seed reverse indexes release all sends and retain shared scope pins until the last seed closes", () => {
  const ledger = factory(spendTestJournal(), 1, 2);
  ledger.reconfigure(spendTestPolicy({ maxTrackedScopes: 1, maxTrackedSends: 2, poolAliases: { [spendAlias("pool", "P")]: "P" } }));
  const first = seed(ledger, "first");
  const last = seed(ledger, "last");
  expect(reported(ledger, first, "overflow")).toBe(true);
  for (const sendId of ["first", "overflow"]) ledger.settle(sendId, { inputTokens: 0, outputTokens: 0 });
  expect(ledger.forgetResolved(["first", "overflow"])).toBe(true);
  expect(ledger.finishSeed(first)).toBe(true);
  ledger.prune(1e12);
  expect(ledger.snapshot("pool", "P")).toBeDefined();
  expect(reported(ledger, last, "overflow")).toBe(true);
  for (const sendId of ["last", "overflow"]) ledger.settle(sendId, { inputTokens: 0, outputTokens: 0 });
  expect(ledger.forgetResolved(["last", "overflow"])).toBe(true);
  expect(ledger.finishSeed(last)).toBe(true);
  ledger.prune(1e12);
  expect(ledger.snapshot("pool", "P")).toBeUndefined();
  expect(ledger.reserveSeed(request("first", { poolId: "Q" }))).toMatchObject({ reserved: true });
  expect(reported(ledger, first, "late")).toBe(false);
});

test("seed cleanup checks the owning reporter count and rejects another owner", () => {
  const ledger = factory();
  const owner = {};
  const foreign = {};
  const decision = ledger.reserveSeed(request("owned"), owner);
  if (!decision.reserved) throw new Error("seed denied");
  const first = ledger.registerReporter(owner);
  const second = ledger.registerReporter(owner);
  const unrelated = ledger.registerReporter(foreign);
  ledger.settle("owned", { inputTokens: 1, outputTokens: 0 });
  first.close();
  first.close();
  expect(ledger.forgetResolved(["owned"], owner)).toBe(false);
  expect(ledger.finishSeed(decision.seed, owner)).toBe(false);
  second.close();
  expect(ledger.forgetResolved(["owned"], {})).toBe(false);
  expect(ledger.finishSeed(decision.seed, {})).toBe(false);
  expect(ledger.forgetResolved(["owned"], owner)).toBe(true);
  // A forgotten alias stays pinned until its seed closes; it cannot be rebound underneath it.
  expect(ledger.knows("owned")).toBe(true);
  expect(ledger.reserve(request("owned"))).toMatchObject({ reserved: false, denial: { reason: "duplicate-send-id" } });
  expect(ledger.finishSeed(decision.seed, owner)).toBe(true);
  unrelated.close();
  expect(ledger.reserveSeed(request("owned"), foreign)).toMatchObject({ reserved: true });
});

import { describe, expect, spyOn, test } from "bun:test";
import { createChildOpsEngine, resetSharedChildOpsEngineForTests, sharedChildOpsEngine, type ChildOpsEngine } from "../../src/link/child-ops-engine";
import type { ChildOp, ChildOpsEnv, ItemOutcome, ItemRunner } from "../../src/link/child-ops-types";
import type { ChildObservation } from "../../src/link/child-observations";
import type { LinkRecord, LinkStore } from "../../src/link/store";

const NOW = Date.parse("2026-11-11T00:00:00.000Z");
const ids = Array.from({ length: 6 }, (_, index) => "lnk_" + index.toString(16).padStart(16, "0"));

function record(id: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id, alias: "host-" + id.slice(-2), direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-" + id.slice(-2), createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}
const store = (links: LinkRecord[]): LinkStore => ({ version: 1, listenerPort: 18181, links });

/** A fake env: in-memory store, a test clock and a recording cache writer that never throws (the env contract). */
function fakeEnv(links: () => LinkRecord[], clock: { now: number } = { now: NOW }) {
  const writes: Array<{ linkId: string; patch: Partial<ChildObservation> }> = [];
  const env: ChildOpsEnv = {
    readStore: () => store(links()), runner: { run: async () => { throw new Error("no SSH in engine tests"); } }, knownHostsFile: "/dev/null",
    wireState: () => "connected", activity: () => ({ idle: true, inFlight: 0 }), homeVersion: "2.100.0", now: () => clock.now,
    sleep: async () => {}, observe: async () => { throw new Error("unused"); }, readObservation: () => null,
    writeObservation: (linkId, patch) => { writes.push({ linkId, patch }); }, catalogEtag: () => null,
  };
  return { env, writes, clock };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const succeeded: ItemOutcome = { state: "succeeded", reason: null };

/** Runners that wait on a per-link gate and record how many run at once, per op. */
function gatedRunners() {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  let running = 0;
  const peak: Partial<Record<ChildOp, number>> = {};
  const runner = (op: ChildOp): ItemRunner => async target => {
    running += 1; peak[op] = Math.max(peak[op] ?? 0, running);
    started.push(op + ":" + target.id);
    const gate = deferred();
    gates.set(op + ":" + target.id, gate);
    await gate.promise;
    running -= 1;
    return succeeded;
  };
  const release = async (key: string) => { gates.get(key)!.resolve(); await flush(); };
  const releaseAll = async () => { while ([...gates.values()].length) { const pending = [...gates.entries()]; gates.clear(); for (const [, gate] of pending) gate.resolve(); await flush(); } };
  return { runners: { observe: runner("observe"), sync: runner("sync"), "restart-codex": runner("restart-codex"), update: runner("update") },
    started, peak, release, releaseAll, running: () => running };
}

const manual = (op: ChildOp, linkIds: readonly string[] | "all") => ({ op, linkIds, restart: "none" as const, trigger: "manual" as const });
function submitted(engine: ChildOpsEngine, request: ReturnType<typeof manual>, env: ChildOpsEnv) {
  const result = engine.submit(request, env);
  if (!result.ok) throw new Error("submit refused: " + result.code);
  return result.job;
}

describe("child ops engine (wp3)", () => {
  test("a held single link refuses a second submit and activeJob reports it", async () => {
    const gated = gatedRunners();
    const { env } = fakeEnv(() => [record(ids[0]!)]);
    const engine = createChildOpsEngine({ runners: gated.runners });
    const job = submitted(engine, manual("sync", [ids[0]!]), env);
    expect(engine.submit(manual("sync", [ids[0]!]), env)).toEqual({ ok: false, code: "link_operation_in_progress", linkId: ids[0]! });
    expect(engine.submit(manual("update", [ids[0]!]), env)).toEqual({ ok: false, code: "link_operation_in_progress", linkId: ids[0]! });
    expect(engine.activeJob(ids[0]!)).toEqual({ jobId: job.jobId, op: "sync", state: "running" });
    await gated.releaseAll();
    await engine.settled();
    expect(engine.activeJob(ids[0]!)).toBeNull();
  });

  test("a bulk job skips the held link as busy and writes no lastOperation for it", async () => {
    const gated = gatedRunners();
    const links = [record(ids[0]!), record(ids[1]!)];
    const { env, writes } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    const first = submitted(engine, manual("sync", [ids[0]!]), env);
    const bulk = submitted(engine, manual("sync", "all"), env);
    expect(bulk.items[0]).toMatchObject({ linkId: ids[0], state: "busy", reason: "link-operation-in-progress" });
    expect(bulk.items[0]!.finishedAt).not.toBeNull();
    await gated.releaseAll();
    await engine.settled();
    const lastOps = writes.filter(write => write.patch.lastOperation).map(write => [write.linkId, write.patch.lastOperation!.jobId]);
    expect(lastOps.sort()).toEqual([[ids[0]!, first.jobId], [ids[1]!, bulk.jobId]].sort());
  });

  test("all lists every link: Child-initiated items end unsupported at admission, except for observe", async () => {
    const calls: string[] = [];
    const runner: ItemRunner = async (target, job) => { calls.push(job.op + ":" + target.id); return succeeded; };
    const links = [record(ids[0]!), record(ids[1]!, { direction: "client-initiated", hostKeyFingerprint: null })];
    const { env, writes } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: { sync: runner, observe: runner } });
    const sync = submitted(engine, manual("sync", "all"), env);
    expect(sync.items[1]).toMatchObject({ linkId: ids[1], state: "unsupported", reason: "child-initiated" });
    await engine.settled();
    expect(calls).toEqual(["sync:" + ids[0]]);
    expect(writes.filter(write => write.linkId === ids[1])).toEqual([]);
    submitted(engine, manual("observe", "all"), env);
    await engine.settled();
    expect(calls.slice(1).sort()).toEqual(["observe:" + ids[0], "observe:" + ids[1]].sort());
    // An explicit Child-initiated id inside a list is an unsupported item too.
    const listed = submitted(engine, manual("update", [ids[0]!, ids[1]!]), env);
    expect(listed.items[1]).toMatchObject({ state: "unsupported", reason: "child-initiated" });
    await engine.settled();
  });

  test("submit refusals", async () => {
    const links = [record(ids[0]!), record(ids[1]!, { direction: "client-initiated", hostKeyFingerprint: null })];
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: { observe: async () => succeeded } });
    for (const op of ["sync", "restart-codex", "update"] as const) {
      expect(engine.submit(manual(op, [ids[1]!]), env)).toEqual({ ok: false, code: "link_not_home_initiated", linkId: ids[1]! });
    }
    expect(engine.submit(manual("observe", [ids[1]!]), env).ok).toBe(true);
    await engine.settled();
    expect(engine.submit(manual("sync", [ids[5]!]), env)).toEqual({ ok: false, code: "link_not_found", linkId: ids[5]! });
    const empty = fakeEnv(() => []);
    expect(engine.submit(manual("sync", "all"), empty.env)).toEqual({ ok: false, code: "no_eligible_links", linkId: null });
    const clientsOnly = fakeEnv(() => [links[1]!]);
    const job = submitted(engine, manual("sync", "all"), clientsOnly.env);
    expect(job.state).toBe("done");
    expect(job.items.map(item => item.state)).toEqual(["unsupported"]);
    await engine.settled();
  });

  test("a job whose every link is held is done at once with every item busy", async () => {
    const gated = gatedRunners();
    const links = [record(ids[0]!), record(ids[1]!)];
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    submitted(engine, manual("sync", [ids[0]!, ids[1]!]), env);
    const all = submitted(engine, manual("sync", "all"), env);
    expect(all.state).toBe("done");
    expect(all.items.map(item => item.state)).toEqual(["busy", "busy"]);
    await gated.releaseAll();
    await engine.settled();
  });

  test("update items run one at a time, sync items three at a time", async () => {
    const links = ids.slice(0, 5).map(id => record(id));
    for (const op of ["update", "sync"] as const) {
      const gated = gatedRunners();
      const { env } = fakeEnv(() => links);
      const engine = createChildOpsEngine({ runners: gated.runners });
      submitted(engine, manual(op, "all"), env);
      expect(gated.running()).toBe(op === "update" ? 1 : 3);
      await gated.releaseAll();
      await engine.settled();
      expect(gated.peak[op]).toBe(op === "update" ? 1 : 3);
      expect(gated.started).toHaveLength(5);
    }
  });

  test("engine-wide slots: four single-link syncs run three at a time; a second update waits for the first", async () => {
    const gated = gatedRunners();
    const links = ids.map(id => record(id));
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    const jobs = ids.slice(0, 4).map(id => submitted(engine, manual("sync", [id]), env));
    expect(gated.running()).toBe(3);
    expect(engine.job(jobs[3]!.jobId)!.items[0]!.state).toBe("queued");
    await gated.release("sync:" + ids[0]);
    expect(engine.job(jobs[3]!.jobId)!.items[0]!.state).toBe("running");
    await gated.releaseAll();
    await engine.settled();
    const updates = [ids[4]!, ids[5]!].map(id => submitted(engine, manual("update", [id]), env));
    expect(gated.started.at(-1)).toBe("update:" + ids[4]);
    expect(engine.job(updates[1]!.jobId)!.items[0]!.state).toBe("queued");
    await gated.release("update:" + ids[4]);
    expect(gated.started.at(-1)).toBe("update:" + ids[5]);
    await gated.releaseAll();
    await engine.settled();
  });

  test("a waiting update does not block a sync queued behind it", async () => {
    const gated = gatedRunners();
    const links = ids.slice(0, 3).map(id => record(id));
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    submitted(engine, manual("update", [ids[0]!]), env);
    const waiting = submitted(engine, manual("update", [ids[1]!]), env);
    const sync = submitted(engine, manual("sync", [ids[2]!]), env);
    expect(sync.items[0]!.state).toBe("running");
    expect(waiting.items[0]!.state).toBe("queued");
    expect(gated.started).toEqual(["update:" + ids[0], "sync:" + ids[2]]);
    await gated.releaseAll();
    await engine.settled();
  });

  test("a record removed before its turn ends refused/link-removed", async () => {
    const gated = gatedRunners();
    let links = ids.slice(0, 4).map(id => record(id));
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    const job = submitted(engine, manual("sync", "all"), env);
    links = links.filter(link => link.id !== ids[3]);
    await gated.releaseAll();
    await engine.settled();
    expect(engine.job(job.jobId)!.items[3]).toMatchObject({ state: "refused", reason: "link-removed" });
  });

  test("a throwing runner or a non-terminal state ends failed/internal-error", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const links = [record(ids[0]!), record(ids[1]!)];
      const { env } = fakeEnv(() => links);
      const engine = createChildOpsEngine({ runners: { sync: async target => {
        if (target.id === ids[0]) throw new TypeError("boom");
        return { state: "running" as never, reason: null };
      } } });
      const job = submitted(engine, manual("sync", "all"), env);
      await engine.settled();
      expect(engine.job(job.jobId)!.items.map(item => [item.state, item.reason])).toEqual([["failed", "internal-error"], ["failed", "internal-error"]]);
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([`[link] child sync failed linkId=${ids[0]} error=TypeError`]);
    } finally { warn.mockRestore(); }
  });

  test("lastOperation is written per item; a write failure does not fail the item; versions the cache refuses are left out", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const links = [record(ids[0]!), record(ids[1]!)];
      const { env, writes } = fakeEnv(() => links);
      const engine = createChildOpsEngine({ runners: { update: async target => target.id === ids[0]
        ? { state: "succeeded", reason: null, fromVersion: "unknown", toVersion: "2.100.0" } : { state: "failed", reason: "rolled-back", fromVersion: "2.98.0", toVersion: "2.100.0" } } });
      const job = submitted(engine, manual("update", "all"), env);
      await engine.settled();
      const summaries = writes.map(write => write.patch.lastOperation);
      expect(summaries).toEqual([
        { op: "update", jobId: job.jobId, state: "succeeded", reason: null, toVersion: "2.100.0", finishedAt: new Date(NOW).toISOString() },
        { op: "update", jobId: job.jobId, state: "failed", reason: "rolled-back", fromVersion: "2.98.0", toVersion: "2.100.0", finishedAt: new Date(NOW).toISOString() },
      ]);
      // An env that breaks its never-throws contract is still contained by the engine.
      const broken = { ...env, writeObservation: () => { throw new Error("locked"); } };
      const second = submitted(engine, manual("update", [ids[0]!]), broken);
      await engine.settled();
      expect(engine.job(second.jobId)!.items[0]).toMatchObject({ state: "succeeded", fromVersion: "unknown" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test("a hint longer than the CLI's 256-character bound is cut to it", async () => {
    const { env } = fakeEnv(() => [record(ids[0]!)]);
    const engine = createChildOpsEngine({ runners: { sync: async () => ({ state: "refused", reason: "child-link-mismatch", hint: "x".repeat(400) }) } });
    const job = submitted(engine, manual("sync", [ids[0]!]), env);
    await engine.settled();
    expect(engine.job(job.jobId)!.items[0]!.hint).toHaveLength(256);
  });

  test("retention keeps 32 finished jobs and one hour on each job's clock", async () => {
    const clock = { now: NOW };
    const { env } = fakeEnv(() => [record(ids[0]!)], clock);
    let counter = 0;
    const engine = createChildOpsEngine({ runners: { sync: async () => succeeded }, jobId: () => "ljob_" + (counter++).toString(16).padStart(16, "0") });
    for (let index = 0; index < 34; index++) {
      clock.now += 1_000;
      submitted(engine, manual("sync", [ids[0]!]), env);
      await engine.settled();
    }
    // 34 finished jobs: the two oldest are dropped on the next read.
    expect(engine.job("ljob_0000000000000000")).toBeUndefined();
    expect(engine.job("ljob_0000000000000001")).toBeUndefined();
    expect(engine.job("ljob_0000000000000002")).toBeDefined();
    clock.now += 61 * 60 * 1000;
    expect(engine.job("ljob_0000000000000021")).toBeUndefined();
  });

  test("one shared engine per process until the test reset", () => {
    resetSharedChildOpsEngineForTests();
    const first = sharedChildOpsEngine();
    expect(sharedChildOpsEngine()).toBe(first);
    resetSharedChildOpsEngineForTests();
    expect(sharedChildOpsEngine()).not.toBe(first);
    resetSharedChildOpsEngineForTests();
  });

  test("every lock is released once the engine settles", async () => {
    const gated = gatedRunners();
    const links = ids.map(id => record(id));
    const { env } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: gated.runners });
    submitted(engine, manual("restart-codex", ids.slice(0, 2)), env);
    submitted(engine, manual("update", ids.slice(2, 4)), env);
    await gated.releaseAll();
    await engine.settled();
    for (const id of ids) expect(engine.activeJob(id)).toBeNull();
  });
});

describe("link reservation (link removal)", () => {
  test("a reserved link refuses single-link submits, makes bulk items busy, and frees on release", async () => {
    const links = [record(ids[0]!), record(ids[1]!)];
    const { env, writes } = fakeEnv(() => links);
    const engine = createChildOpsEngine({ runners: { sync: async () => succeeded } });
    const release = engine.reserve(ids[0]!);
    expect(release).not.toBeNull();
    expect(engine.reserve(ids[0]!)).toBeNull();
    expect(engine.activeJob(ids[0]!)).toBeNull();
    expect(engine.submit(manual("sync", [ids[0]!]), env)).toEqual({ ok: false, code: "link_operation_in_progress", linkId: ids[0]! });
    const bulk = submitted(engine, manual("sync", "all"), env);
    expect(bulk.items[0]).toMatchObject({ state: "busy", reason: "link-operation-in-progress" });
    await engine.settled();
    expect(writes.filter(write => write.linkId === ids[0])).toEqual([]);
    release!();
    release!();
    expect(engine.submit(manual("sync", [ids[0]!]), env).ok).toBe(true);
    await engine.settled();
  });

  test("a link a job holds cannot be reserved; a late release never frees a job's lock", async () => {
    const gate = deferred();
    const { env } = fakeEnv(() => [record(ids[0]!)]);
    const engine = createChildOpsEngine({ runners: { sync: async () => { await gate.promise; return succeeded; } } });
    const free = engine.reserve(ids[0]!)!;
    free();
    submitted(engine, manual("sync", [ids[0]!]), env);
    expect(engine.reserve(ids[0]!)).toBeNull();
    free();
    expect(engine.submit(manual("sync", [ids[0]!]), env)).toMatchObject({ ok: false, code: "link_operation_in_progress" });
    gate.resolve();
    await engine.settled();
  });
});


describe("whenDone (wp5)", () => {
  test("a job that finished at submit resolves at once; a running job after its last item; an unknown id with null", async () => {
    const gated = gatedRunners();
    const { env } = fakeEnv(() => [record(ids[0]!), record(ids[1]!)]);
    const engine = createChildOpsEngine({ runners: gated.runners });
    const running = submitted(engine, manual("sync", [ids[0]!, ids[1]!]), env);
    const busy = submitted(engine, manual("sync", [ids[0]!, ids[1]!]), env);
    const busyDone = await engine.whenDone(busy.jobId);
    expect(busyDone?.state).toBe("done");
    expect(busyDone?.items.map(item => item.state)).toEqual(["busy", "busy"]);
    let resolved: Awaited<ReturnType<ChildOpsEngine["whenDone"]>> | undefined;
    void engine.whenDone(running.jobId).then(job => { resolved = job; });
    const second = engine.whenDone(running.jobId);
    await gated.release("sync:" + ids[0]!);
    expect(resolved).toBeUndefined();
    await gated.release("sync:" + ids[1]!);
    expect(resolved?.state).toBe("done");
    expect(resolved?.items.map(item => item.state)).toEqual(["succeeded", "succeeded"]);
    expect((await second)?.jobId).toBe(running.jobId);
    expect(await engine.whenDone("ljob_ffffffffffffffff")).toBeNull();
  });
});

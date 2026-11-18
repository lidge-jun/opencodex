import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildOpsEngine, type ChildOpRequest, type ChildOpsEngine } from "../../src/link/child-ops-engine";
import type { ChildOpsEnv, ItemOutcome } from "../../src/link/child-ops-types";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, CATALOG_BACKOFF_KEY, CATALOG_POLL_MS, QUIET_MAX_DEFER_MS, QUIET_PERIOD_MS, createChildOpsScheduler,
  createLinkBackoff, type ChildOpsScheduler } from "../../src/link/child-ops-scheduler";
import { DEFAULT_CHILD_POLICY, updateChildPolicy, type ChildPolicy } from "../../src/link/child-policy";
import { hostChildOpsEnv, runtimeCurrentDigest, schedulerRevision, syncedEtagFor, type ChildOpsHostBinding } from "../../src/link/child-ops-host";
import { childObservationsPath, linkStorePath } from "../../src/link/paths";
import type { LinkWireState } from "../../src/link/status-projection";
import type { LinkRecord } from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const T0 = Date.parse("2026-11-11T00:00:00.000Z");
const id = (n: number) => "lnk_" + n.toString(16).padStart(16, "0");
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G = id(7);
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

function record(linkId: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id: linkId, alias: "host-" + linkId.slice(-2), direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-" + linkId.slice(-2), createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}

/** Timers through the scheduler's deps; advance() fires them in time order and lets their promises settle. */
function fakeTimers(clock: { now: number }) {
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => { const handle = next++; timers.set(handle, { at: clock.now + ms, fn, every: null }); return handle; },
    setInterval: (fn: () => void, ms: number) => { const handle = next++; timers.set(handle, { at: clock.now + ms, fn, every: ms }); return handle; },
    clear: (handle: unknown) => { timers.delete(handle as number); },
    async advance(ms: number) {
      const target = clock.now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        clock.now = timer.at;
        if (timer.every !== null) timer.at += timer.every; else timers.delete(handle);
        timer.fn();
        await flush();
      }
      clock.now = target;
      await flush();
    },
  };
}

interface State {
  links: LinkRecord[]; policy: ChildPolicy; etag: string | null; synced: Record<string, string | null>; idle: Record<string, boolean>;
  wire: Record<string, LinkWireState>; homeDigest: string | null; childDigest: Record<string, string | null>; peer: Record<string, string | null>;
  held: Set<string>; changed: boolean; client: boolean; outcome: (linkId: string) => ItemOutcome; gate: Promise<void> | null;
}

function harness(overrides: Partial<State> = {}) {
  const clock = { now: T0 };
  const timers = fakeTimers(clock);
  const state: State = { links: [record(A)], policy: { ...DEFAULT_CHILD_POLICY }, etag: "\"E1\"", synced: {}, idle: {}, wire: {}, homeDigest: "sha256:home",
    childDigest: {}, peer: {}, held: new Set(), changed: false, client: false, outcome: () => ({ state: "succeeded", reason: null }), gate: null, ...overrides };
  const submits: Array<ChildOpRequest & { at: number }> = [];
  const engine = createChildOpsEngine({ runners: { sync: async target => {
    const etag = state.etag;                      // the real runner reads the etag before the sync
    if (state.gate) await state.gate;
    const outcome = state.outcome(target.id);
    if (outcome.state === "succeeded") state.synced[target.id] = etag;
    return outcome;
  } } });
  const recording: ChildOpsEngine = { ...engine,
    submit: (request, env) => { submits.push({ ...structuredClone(request), linkIds: request.linkIds === "all" ? "all" : [...request.linkIds], at: clock.now }); return engine.submit(request, env); },
    activeJob: linkId => state.held.has(linkId) ? { jobId: "ljob_ffffffffffffffff", op: "sync", state: "running" } : engine.activeJob(linkId) };
  const env: ChildOpsEnv = {
    readStore: () => ({ version: 1, listenerPort: 18181, links: state.links }), runner: { run: async () => { throw new Error("no SSH"); } },
    knownHostsFile: "/dev/null", wireState: linkId => state.wire[linkId] ?? "connected",
    activity: linkId => ({ idle: state.idle[linkId] ?? true, inFlight: 0 }), homeVersion: "2.100.0", now: () => clock.now,
    sleep: async () => {}, observe: async () => { throw new Error("unused"); }, readObservation: () => null, writeObservation: () => {},
    catalogEtag: () => state.etag,
  };
  let slot: (() => void) | null = null;
  const slotCalls: Array<"set" | "null"> = [];
  const scheduler: ChildOpsScheduler = createChildOpsScheduler({
    engine: recording, env: () => env, readPolicy: () => ({ policy: state.policy, warning: null }),
    revision: { current: () => ({ etag: state.etag, changedAt: null }), recompute: async () => { const changed = state.changed; state.changed = false; return changed; } },
    syncedEtag: linkId => state.synced[linkId] ?? null, homeDigest: () => state.homeDigest, childDigest: linkId => state.childDigest[linkId] ?? null,
    peerVersion: linkId => state.peer[linkId] ?? null, isClientRuntime: () => state.client,
    setCatalogChangedSlot: fanout => { slot = fanout; slotCalls.push(fanout ? "set" : "null"); },
    setTimeout: timers.setTimeout, clearTimeout: timers.clear, setInterval: timers.setInterval, clearInterval: timers.clear,
  });
  /** A Home catalog change as the auto-refresh tick reports it. */
  const change = (etag: string) => { state.etag = etag; slot?.(); };
  return { clock, timers, state, submits, scheduler, change, slot: () => slot, slotCalls,
    async started() { scheduler.start(); await flush(); } };
}

describe("quiet period", () => {
  test("a change submits one automatic no-restart sync 60 s later", async () => {
    const h = harness();
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS - 1);
    expect(h.submits).toEqual([]);
    await h.timers.advance(1);
    expect(h.submits).toEqual([{ op: "sync", linkIds: [A], restart: "none", trigger: "auto", at: T0 + QUIET_PERIOD_MS }]);
    h.change("\"E2\"");
    await h.timers.advance(QUIET_PERIOD_MS);
    expect(h.submits.map(s => s.at)).toEqual([T0 + QUIET_PERIOD_MS, T0 + 2 * QUIET_PERIOD_MS]);
  });

  test("a burst coalesces into one job 60 s after the last change", async () => {
    const h = harness({ synced: { [A]: "\"E1\"" } });
    await h.started();
    h.change("\"E2\"");
    await h.timers.advance(20_000); h.change("\"E3\"");
    await h.timers.advance(20_000); h.change("\"E4\"");
    await h.timers.advance(QUIET_PERIOD_MS - 1);
    expect(h.submits).toEqual([]);
    await h.timers.advance(1);
    expect(h.submits.map(s => s.at)).toEqual([T0 + 40_000 + QUIET_PERIOD_MS]);
  });

  test("a steady stream of changes cannot postpone the fan-out past the 5-minute ceiling", async () => {
    const h = harness();
    await h.started();
    for (let i = 1; i <= 20; i += 1) { await h.timers.advance(30_000); h.change(`"E${i + 1}"`); }
    expect(h.submits[0]!.at).toBe(T0 + QUIET_MAX_DEFER_MS);
  });

  test("a quiet timer that fires while an evaluation runs evaluates again when it finishes", async () => {
    let release!: () => void;
    const h = harness({ gate: new Promise<void>(resolve => { release = resolve; }) });
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS);
    expect(h.submits.length).toBe(1);
    h.change("\"E2\"");
    await h.timers.advance(QUIET_PERIOD_MS);
    expect(h.submits.length).toBe(1);
    h.state.gate = null;
    release();
    await flush();
    // The first pass synced E1; the rerun sees the link behind E2.
    expect(h.submits.length).toBe(2);
    expect(h.state.synced[A]).toBe("\"E2\"");
  });
});

describe("policy and runtime", () => {
  test("catalogFanout manual submits nothing; auto resumes at the next evaluation", async () => {
    const h = harness({ policy: { ...DEFAULT_CHILD_POLICY, catalogFanout: "manual" } });
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS + CATALOG_POLL_MS);
    expect(h.submits).toEqual([]);
    h.state.policy = { ...DEFAULT_CHILD_POLICY };
    await h.timers.advance(CATALOG_POLL_MS);
    expect(h.submits.length).toBe(1);
  });

  test("a Child runtime never evaluates", async () => {
    const h = harness({ client: true });
    await h.started();
    expect(await h.scheduler.evaluateForTest()).toEqual([]);
    await h.timers.advance(QUIET_PERIOD_MS + CATALOG_POLL_MS);
    expect(h.submits).toEqual([]);
  });

  test("updates auto-when-idle with every Child behind the Home version still submits only sync jobs (wp5 starts no update)", async () => {
    const h = harness({ links: [record(A), record(B)], peer: { [A]: "2.90.0", [B]: "2.91.0" },
      policy: { ...DEFAULT_CHILD_POLICY, updates: "auto-when-idle", childCodexRestart: "app-server-when-idle" } });
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS + 3 * CATALOG_POLL_MS);
    expect(h.submits.length).toBeGreaterThan(0);
    expect(h.submits.every(s => s.op === "sync")).toBe(true);
  });
});

describe("eligibility", () => {
  test("only connected, Home-initiated, unheld links behind the current etag", async () => {
    const h = harness({
      links: [record(A), record(B, { direction: "client-initiated", hostKeyFingerprint: null }), record(C), record(D), record(E), record(F), record(G)],
      wire: { [C]: "reconnecting" }, held: new Set([E]), synced: { [D]: "\"E1\"", [F]: null, [G]: "\"E0\"" },
    });
    await h.started();
    const jobs = await h.scheduler.evaluateForTest();
    expect(h.submits.map(s => s.linkIds)).toEqual([[A, F, G]]);
    expect(jobs[0]!.items.map(item => item.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  test("a fetched-but-not-synced Child is still behind; an unreadable catalog makes nobody behind", async () => {
    const h = harness({ synced: { [A]: "\"OLD\"" } });
    await h.started();
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(1);
    const unread = harness({ etag: null });
    await unread.started();
    expect(await unread.scheduler.evaluateForTest()).toEqual([]);
    expect(unread.submits).toEqual([]);
  });

  test("digest rule: a busy Child is synced only when its settings already match the Home", async () => {
    const h = harness({ links: [record(A), record(B), record(C)], idle: { [A]: false, [B]: false, [C]: true },
      childDigest: { [A]: "sha256:home", [B]: "sha256:other", [C]: "sha256:other" } });
    await h.started();
    await h.scheduler.evaluateForTest();
    expect(h.submits.map(s => s.linkIds)).toEqual([[A, C]]);
    const noHome = harness({ homeDigest: null, idle: { [A]: false }, childDigest: { [A]: null } });
    await noHome.started();
    await noHome.scheduler.evaluateForTest();
    expect(noHome.submits).toEqual([]);
  });

  test("a busy Child skipped for its digest is synced at the first poll after it turns idle", async () => {
    const h = harness({ idle: { [A]: false }, childDigest: { [A]: "sha256:other" } });
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS + CATALOG_POLL_MS);
    expect(h.submits).toEqual([]);
    h.state.idle[A] = true;
    await h.timers.advance(CATALOG_POLL_MS);
    expect(h.submits.map(s => s.linkIds)).toEqual([[A]]);
  });

  test("app-server-when-idle: idle Children get a restarting job, busy ones a plain sync", async () => {
    const h = harness({ links: [record(A), record(B)], idle: { [A]: true, [B]: false }, childDigest: { [B]: "sha256:home" },
      policy: { ...DEFAULT_CHILD_POLICY, childCodexRestart: "app-server-when-idle" } });
    await h.started();
    await h.scheduler.evaluateForTest();
    expect(h.submits.map(({ linkIds, restart, trigger }) => ({ linkIds, restart, trigger }))).toEqual([
      { linkIds: [B], restart: "none", trigger: "auto" }, { linkIds: [A], restart: "app-server", trigger: "auto" }]);
  });
});

describe("backoff through the scheduler", () => {
  test("a failure waits 5 minutes, a second one 10; a success clears it", async () => {
    const h = harness({ outcome: () => ({ state: "failed", reason: "child-sync-failed" }) });
    await h.started();
    await h.scheduler.evaluateForTest();
    h.clock.now += BACKOFF_MIN_MS - 1;
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(1);
    h.clock.now += 1;
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(2);
    h.clock.now += 2 * BACKOFF_MIN_MS - 1;
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(2);
    h.clock.now += 1;
    h.state.outcome = () => ({ state: "succeeded", reason: null });
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(3);
    h.state.etag = "\"E2\"";
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(4);
  });

  test("busy does not grow the backoff: the next evaluation retries", async () => {
    const h = harness({ outcome: () => ({ state: "busy", reason: "link-active" }) });
    await h.started();
    await h.scheduler.evaluateForTest();
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(2);
  });

  test("a Child below 2.93 is attempted once and retried only after it reports another version", async () => {
    const h = harness({ peer: { [A]: "2.92.0" }, outcome: () => ({ state: "owner-action", reason: "child-ocx-lacks-expect-link" }) });
    await h.started();
    await h.scheduler.evaluateForTest();
    h.clock.now += BACKOFF_MAX_MS * 2;
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(1);
    h.state.peer[A] = "2.97.0";
    await h.scheduler.evaluateForTest();
    expect(h.submits.length).toBe(2);
  });
});

describe("poll, start and stop", () => {
  test("a poll that sees a change arms the quiet period; one that does not evaluates at once", async () => {
    const h = harness({ synced: { [A]: "\"E1\"" } });
    await h.started();
    await h.timers.advance(QUIET_PERIOD_MS);
    expect(h.submits).toEqual([]);
    h.state.etag = "\"E2\""; h.state.changed = true;
    await h.timers.advance(CATALOG_POLL_MS - QUIET_PERIOD_MS);
    expect(h.submits).toEqual([]);
    await h.timers.advance(QUIET_PERIOD_MS);
    expect(h.submits.map(s => s.at)).toEqual([T0 + CATALOG_POLL_MS + QUIET_PERIOD_MS]);
    h.state.etag = "\"E3\"";                       // changed, but the monitor did not report it: the poll still evaluates
    await h.timers.advance(CATALOG_POLL_MS - QUIET_PERIOD_MS);
    expect(h.submits.map(s => s.at)).toEqual([T0 + CATALOG_POLL_MS + QUIET_PERIOD_MS, T0 + 2 * CATALOG_POLL_MS]);
  });

  test("start sets the slot and one interval; stop clears both; a second start or stop is a no-op", async () => {
    const h = harness();
    await h.started();
    h.scheduler.start();
    await flush();
    expect(h.slotCalls).toEqual(["set"]);
    expect([...h.timers.timers.values()].filter(timer => timer.every === CATALOG_POLL_MS).length).toBe(1);
    h.scheduler.stop();
    h.scheduler.stop();
    expect(h.slotCalls).toEqual(["set", "null"]);
    expect(h.slot()).toBeNull();
    expect(h.timers.timers.size).toBe(0);
    expect(await h.scheduler.evaluateForTest()).toEqual([]);
  });
});

describe("createLinkBackoff (shared with 070)", () => {
  test("keys are independent, delays double to the 6-hour cap, success clears", () => {
    const backoff = createLinkBackoff();
    backoff.record(A, CATALOG_BACKOFF_KEY, { state: "failed", reason: null }, T0, "2.97.0");
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + BACKOFF_MIN_MS - 1, "2.97.0")).toBe(true);
    expect(backoff.blocked(A, "2.100.0", T0, "2.97.0")).toBe(false);
    let now = T0, delay = BACKOFF_MIN_MS;
    for (let i = 0; i < 10; i += 1) {
      now += delay;
      backoff.record(A, CATALOG_BACKOFF_KEY, { state: "offline", reason: null }, now, "2.97.0");
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, now + delay - 1, "2.97.0")).toBe(true);
      expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, now + delay, "2.97.0")).toBe(false);
    }
    expect(delay).toBe(BACKOFF_MAX_MS);
    expect(backoff.attempts(A, CATALOG_BACKOFF_KEY)).toBe(11);
    backoff.record(A, CATALOG_BACKOFF_KEY, { state: "succeeded", reason: null }, now, "2.97.0");
    expect(backoff.attempts(A, CATALOG_BACKOFF_KEY)).toBe(0);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, now, "2.97.0")).toBe(false);
    expect(backoff.lastAttemptAt(A)).toBe(now);
    backoff.record(A, "2.100.0", { state: "failed", reason: null }, now + 5, "2.97.0");
    expect(backoff.lastAttemptAt(A)).toBe(now + 5);
    expect(backoff.lastAttemptAt(B)).toBeNull();
  });

  test("countOn limits what counts while growOn decides growth", () => {
    const counted = createLinkBackoff({ growOn: new Set(["failed", "busy"]), countOn: new Set(["failed"]) });
    for (let i = 0; i < 3; i += 1) counted.record(A, "2.100.0", { state: "busy", reason: null }, T0, null);
    expect(counted.attempts(A, "2.100.0")).toBe(0);
    expect(counted.blocked(A, "2.100.0", T0 + BACKOFF_MIN_MS, null)).toBe(true);     // grown to 20 min
    const plain = createLinkBackoff();
    plain.record(A, CATALOG_BACKOFF_KEY, { state: "busy", reason: null }, T0, null);
    expect(plain.blocked(A, CATALOG_BACKOFF_KEY, T0, null)).toBe(false);
    expect(plain.attempts(A, CATALOG_BACKOFF_KEY)).toBe(1);
  });

  test("a legacy Child with no known version retries after the maximum backoff or as soon as a version appears", () => {
    const backoff = createLinkBackoff();
    const lacks = { state: "owner-action", reason: "child-ocx-lacks-expect-link" };
    backoff.record(A, CATALOG_BACKOFF_KEY, lacks, T0, null);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + BACKOFF_MAX_MS - 1, null)).toBe(true);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + BACKOFF_MAX_MS, null)).toBe(false);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + 1, "2.92.0")).toBe(false);
    backoff.record(A, CATALOG_BACKOFF_KEY, lacks, T0, "2.92.0");
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + 10 * BACKOFF_MAX_MS, "2.92.0")).toBe(true);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0, "2.97.0")).toBe(false);
  });
});

describe("host env (2.3)", () => {
  let temp = "";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "ocx-child-ops-host-"));
    saved.OPENCODEX_HOME = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(temp, "ocx");
    mkdirSync(join(temp, "ocx", "link"), { recursive: true });
    writeFileSync(linkStorePath(), JSON.stringify({ version: 1, listenerPort: 18181, links: [record(A)] }));
  });
  afterEach(() => {
    if (saved.OPENCODEX_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved.OPENCODEX_HOME;
    removeTreeWithRetry(temp);
  });
  const binding = (overrides: Partial<ChildOpsHostBinding> = {}): ChildOpsHostBinding => ({
    config: () => ({}) as never, supervisorStatus: () => [], listenerStatus: () => ({ state: "listening", port: 18181 }),
    activity: () => null, catalogRevision: () => ({ current: () => ({ etag: "\"H1\"", changedAt: T0 }) }),
    peer: () => ({ observed: null, refused: null }) as never, ...overrides,
  });
  const runner = { run: async () => { throw new Error("no SSH"); } } as never;

  test("idle follows the policy's idleAfterMs", () => {
    const lastDataEndAt = Date.now() - 5 * 60_000;
    const b = binding({ activity: () => ({ inFlight: 0, lastDataEndAt, observedSince: 0 }) });
    expect(hostChildOpsEnv(b, runner).activity(A)).toEqual({ inFlight: 0, idle: false });
    updateChildPolicy({ idleAfterMs: 60_000 });
    expect(hostChildOpsEnv(b, runner).activity(A)).toEqual({ inFlight: 0, idle: true });
    const busy = binding({ activity: () => ({ inFlight: 1, lastDataEndAt: 0, observedSince: 0 }) });
    expect(hostChildOpsEnv(busy, runner).activity(A)).toEqual({ inFlight: 1, idle: false });
  });

  test("one env reads the current idleAfterMs on every activity check (#8557 review)", () => {
    // The scheduler's second sync group reuses the env built for the first; a policy change in between must apply.
    const lastDataEndAt = Date.now() - 5 * 60_000;
    updateChildPolicy({ idleAfterMs: 60_000 });
    const env = hostChildOpsEnv(binding({ activity: () => ({ inFlight: 0, lastDataEndAt, observedSince: 0 }) }), runner);
    expect(env.activity(A)).toEqual({ inFlight: 0, idle: true });
    updateChildPolicy({ idleAfterMs: 30 * 60_000 });
    expect(env.activity(A)).toEqual({ inFlight: 0, idle: false });
  });

  test("catalogEtag reads the shared monitor and is null when it throws", () => {
    expect(hostChildOpsEnv(binding(), runner).catalogEtag()).toBe("\"H1\"");
    expect(hostChildOpsEnv(binding({ catalogRevision: () => { throw new Error("catalog"); } }), runner).catalogEtag()).toBeNull();
  });

  test("syncedEtag reads catalogSyncedEtag from the observation file; a failing write never escapes", () => {
    const env = hostChildOpsEnv(binding(), runner);
    expect(syncedEtagFor(A)).toBeNull();
    env.writeObservation(A, { catalogSyncedEtag: "\"H1\"" });
    expect(syncedEtagFor(A)).toBe("\"H1\"");
    removeTreeWithRetry(childObservationsPath());
    mkdirSync(join(childObservationsPath(), "blocker"), { recursive: true });   // a directory where the file goes
    expect(() => env.writeObservation(A, { catalogSyncedEtag: "\"H2\"" })).not.toThrow();
  });

  test("autoSyncAllowed: idle, or settings already equal to the Home", () => {
    let snapshot = { inFlight: 1, lastDataEndAt: 0, observedSince: 0 };
    let child: string | null = "sha256:other";
    const env = hostChildOpsEnv(binding({ activity: () => snapshot }), runner, { home: () => "sha256:home", child: () => child });
    expect(env.autoSyncAllowed?.(A)).toBe(false);
    child = "sha256:home";
    expect(env.autoSyncAllowed?.(A)).toBe(true);
    child = "sha256:other";
    snapshot = { inFlight: 0, lastDataEndAt: 0, observedSince: 0 };
    expect(env.autoSyncAllowed?.(A)).toBe(true);
    expect(hostChildOpsEnv(binding(), runner).autoSyncAllowed).toBeUndefined();
  });

  test("schedulerRevision reports a move of the monitor's etag once", async () => {
    let etag: string | null = "\"H1\"";
    const revision = schedulerRevision({ current: () => etag === null ? null : { etag, changedAt: T0 } });
    expect(await revision.recompute()).toBe(false);
    expect(await revision.recompute()).toBe(false);
    etag = "\"H2\"";
    expect(await revision.recompute()).toBe(true);
    expect(await revision.recompute()).toBe(false);
    etag = null;
    expect(revision.current()).toEqual({ etag: null, changedAt: null });
    expect(await revision.recompute()).toBe(true);
  });
});

describe("review fixes (#8557)", () => {
  const twoGroups = (gate: Promise<void>) => harness({ links: [record(A), record(B)], idle: { [A]: false, [B]: true }, childDigest: { [A]: "sha256:home" },
    policy: { ...DEFAULT_CHILD_POLICY, childCodexRestart: "app-server-when-idle" }, gate });

  test("stop() during the plain-sync job submits no restarting group afterwards", async () => {
    let release!: () => void;
    const h = twoGroups(new Promise<void>(resolve => { release = resolve; }));
    await h.started();
    const pass = h.scheduler.evaluateForTest();
    await flush();
    expect(h.submits.map(s => s.restart)).toEqual(["none"]);
    h.scheduler.stop();
    release();
    await pass;
    expect(h.submits.map(s => s.restart)).toEqual(["none"]);
  });

  test("a policy switched during the plain-sync job governs the second group", async () => {
    let release!: () => void;
    const manual = twoGroups(new Promise<void>(resolve => { release = resolve; }));
    await manual.started();
    const pass = manual.scheduler.evaluateForTest();
    await flush();
    manual.state.policy = { ...manual.state.policy, catalogFanout: "manual" };
    release();
    await pass;
    expect(manual.submits.map(s => s.restart)).toEqual(["none"]);

    let releaseNever!: () => void;
    const never = twoGroups(new Promise<void>(resolve => { releaseNever = resolve; }));
    await never.started();
    const second = never.scheduler.evaluateForTest();
    await flush();
    never.state.policy = { ...never.state.policy, childCodexRestart: "never" };
    releaseNever();
    await second;
    expect(never.submits.map(({ linkIds, restart }) => ({ linkIds, restart }))).toEqual([{ linkIds: [A], restart: "none" }, { linkIds: [B], restart: "none" }]);
  });

  test("a legacy Child stays blocked when its known version stops being reported", () => {
    const backoff = createLinkBackoff();
    backoff.record(A, CATALOG_BACKOFF_KEY, { state: "owner-action", reason: "child-ocx-lacks-expect-link" }, T0, "2.92.0");
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0 + 10 * BACKOFF_MAX_MS, null)).toBe(true);
    expect(backoff.blocked(A, CATALOG_BACKOFF_KEY, T0, "2.97.0")).toBe(false);
  });

  test("a busy Child's digest counts only once its runtime started after the last apply", () => {
    const digest = "sha256:home";
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: digest, lastApplyAt: 2_000_000_000_000, runtimeStartedAt: 2_000_000_000_001, reportedAt: 1 })).toBe(digest);
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: digest, lastApplyAt: 2_000_000_000_000, runtimeStartedAt: 2_000_000_000_000, reportedAt: 1 })).toBe(digest);
    // The apply's runtime restart did not happen: the next sync would restart it.
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: digest, lastApplyAt: 2_000_000_000_000, runtimeStartedAt: 1_999_999_999_999, reportedAt: 1 })).toBeNull();
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: digest, lastApplyAt: null, runtimeStartedAt: 2_000_000_000_000, reportedAt: 1 })).toBeNull();
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: digest, lastApplyAt: 2_000_000_000_000, runtimeStartedAt: null, reportedAt: 1 })).toBeNull();
    expect(runtimeCurrentDigest({ appliedCodexSettingsDigest: null, lastApplyAt: null, runtimeStartedAt: null, reportedAt: null })).toBeNull();
  });
});

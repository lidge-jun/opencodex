import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  countedRecoveryTimes,
  parseTimingOverride,
  readRecoveryEntries,
  readSentinelRuntime,
  runHealthSentinel,
  startLagMonitor,
  syncDirectory,
  writeRecoveryEntry,
  type HealthSentinelDeps,
  type RecoveryEntry,
  type SentinelRuntimeRecord,
} from "../../src/service/health-sentinel-main";
import { healthzPid, probeHealth, probeUrlHost } from "../../src/service/health-sentinel-probe";
import type { HealthProbeOutcome } from "../../src/service/health-sentinel-policy";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const TARGET = 777;
const FAST = { intervalMs: 10, probeTimeoutMs: 20, startupGraceMs: 0, failureThreshold: 3, minUnhealthyMs: 0, suspendSlackMs: 10_000 };

let home: TempHome | null = null;
afterEach(() => { home?.remove(); home = null; });

/** A fake sentinel world: scripted probe outcomes on a simulated clock, with every effect recorded. */
function world(script: Array<"answer" | "timeout" | "refused">, overrides: Partial<HealthSentinelDeps> = {}) {
  let clock = 1_000;
  const events: string[] = [];
  const history: RecoveryEntry[] = [];
  let step = 0;
  let gone = false;
  let resolveExit: () => void = () => {};
  const targetExited = new Promise<void>(resolve => { resolveExit = resolve; });
  const exitTarget = () => { gone = true; resolveExit(); };
  const runtime: SentinelRuntimeRecord = { pid: TARGET, port: 4100, hostname: "127.0.0.1", sibling: false };
  let leased = false;
  const deps: HealthSentinelDeps = {
    targetPid: TARGET,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    probe: async (_target, timeoutMs): Promise<HealthProbeOutcome> => {
      const kind = script[Math.min(step, script.length - 1)]!;
      step += 1;
      const startedAt = clock;
      clock += kind === "timeout" ? timeoutMs : 1;
      events.push(`probe:${kind}`);
      return kind === "answer"
        ? { kind: "answered", pid: TARGET, startedAt, endedAt: clock }
        : { kind, startedAt, endedAt: clock };
    },
    readRuntime: () => runtime,
    targetExited,
    isTargetGone: () => gone,
    bindTarget: () => ({ ok: true }),
    terminateTarget: () => { events.push(`terminate:${TARGET}:${leased ? "leased" : "unleased"}`); exitTarget(); return "terminated"; },
    withOwnershipLease: run => { leased = true; try { return run(); } finally { leased = false; } },
    readHistory: () => [],
    writeHistory: entry => { events.push(`history:${entry.state}:${leased ? "leased" : "unleased"}`); history.push(entry); return true; },
    log: line => events.push(`log:${line}`),
    timing: FAST,
    ...overrides,
  };
  return { deps, events, history, runtime, exitTarget, advance: (ms: number) => { clock += ms; } };
}

const terminated = (events: string[]) => events.some(event => event.startsWith("terminate:"));

describe("health sentinel runner (#6671)", () => {
  test("records intent under the ownership lease, terminates after releasing it, then settles under it", async () => {
    const { deps, events, history } = world(["answer", "timeout"]);
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "recovered", state: "terminated" });
    const intent = events.indexOf("history:intent:leased");
    // Released first: on Windows the sentinel may die with the proxy and must not strand the lease.
    const kill = events.indexOf(`terminate:${TARGET}:unleased`);
    expect(intent).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(intent);
    expect(events.indexOf("history:terminated:leased")).toBeGreaterThan(kill);
    expect(history.map(entry => entry.state)).toEqual(["intent", "terminated"]);
    expect(events.filter(event => event === "probe:timeout")).toHaveLength(3);
    expect(events.some(event => event.includes("not replayed"))).toBe(true);
    // Arming is announced once, before the first counted timeout.
    expect(events.filter(event => event === `log:watching pid ${TARGET} on port 4100`)).toHaveLength(1);
    expect(events.indexOf(`log:watching pid ${TARGET} on port 4100`)).toBeLessThan(events.indexOf("probe:timeout"));
  });

  test("evidence that went stale during lease and history work is discarded and observed again", async () => {
    // Merge sign-off condition A: a slow history write (or a clock set back) between the last
    // failing probe and the kill must not kill a proxy on old observations.
    for (const shift of [10 * 60_000, -2 * 60 * 60_000]) {
      const { deps, events, history, advance } = world(["answer", "timeout"]);
      let delayed = false;
      const write = deps.writeHistory;
      deps.writeHistory = entry => {
        if (entry.state === "intent" && !delayed) {
          delayed = true;
          advance(shift);
        }
        return write(entry);
      };
      expect(await runHealthSentinel(deps)).toEqual({ outcome: "recovered", state: "terminated" });
      expect(history.map(entry => entry.state)).toEqual(["intent", "skipped", "intent", "terminated"]);
      const discarded = events.findIndex(event => event.includes("discarding stale evidence"));
      const kill = events.findIndex(event => event.startsWith("terminate:"));
      expect(discarded).toBeGreaterThan(-1);
      expect(kill).toBeGreaterThan(discarded);
      // The kill came only after a fresh run of failing probes, not from the stale one, and
      // promptly: a clock set back must not hold recovery off for as long as it moved (the
      // simulated clock would otherwise need ~240,000 probes to catch up two hours).
      const fresh = events.slice(discarded, kill).filter(event => event === "probe:timeout").length;
      expect(fresh).toBeGreaterThanOrEqual(3);
      expect(fresh).toBeLessThanOrEqual(6);
    }
  });

  test.each([10 * 60_000, -2 * 60 * 60_000])("final runtime re-read invalidates stale evidence after clock shift %s", async shift => {
    const { deps, events, history, advance } = world(["answer", "timeout"]);
    const read = deps.readRuntime;
    let shifted = false;
    deps.readRuntime = () => {
      const record = read();
      if (!shifted && history.some(entry => entry.state === "intent")) {
        shifted = true;
        advance(shift);
      }
      return record;
    };
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "recovered", state: "terminated" });
    expect(history.map(entry => entry.state)).toEqual(["intent", "skipped", "intent", "terminated"]);
    const discarded = events.findIndex(event => event.includes("discarding stale evidence"));
    const kill = events.findIndex(event => event.startsWith("terminate:"));
    expect(discarded).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(discarded);
    const fresh = events.slice(discarded, kill).filter(event => event === "probe:timeout").length;
    expect(fresh).toBeGreaterThanOrEqual(3);
    expect(fresh).toBeLessThanOrEqual(6);
  });

  test("target exit during final runtime re-read prevents termination", async () => {
    const { deps, events, history, exitTarget } = world(["answer", "timeout"]);
    const read = deps.readRuntime;
    deps.readRuntime = () => {
      const record = read();
      if (history.some(entry => entry.state === "intent")) exitTarget();
      return record;
    };
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "target_exited" });
    expect(terminated(events)).toBe(false);
    expect(history.map(entry => entry.state)).toEqual(["intent", "skipped"]);
  });

  test("a healthy or refusing target is never terminated", async () => {
    for (const kind of ["answer", "refused"] as const) {
      const { deps, events, exitTarget } = world(["answer", kind]);
      let probes = 0;
      const probe = deps.probe;
      deps.probe = async (target, timeoutMs) => {
        probes += 1;
        if (probes === 50) exitTarget();
        return probe(target, timeoutMs);
      };
      expect(await runHealthSentinel(deps)).toEqual({ outcome: "target_exited" });
      expect(terminated(events)).toBe(false);
    }
  });

  test("an unbindable target stands the sentinel down before any probe", async () => {
    const { deps, events } = world(["timeout"], { bindTarget: () => ({ ok: false, reason: "not our parent" }) });
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "stood_down", reason: "not our parent" });
    expect(events.some(event => event.startsWith("probe:"))).toBe(false);
  });

  test("fails closed when the recovery history cannot be read or written", async () => {
    const unreadable = world(["answer", "timeout"], { readHistory: () => null });
    expect((await runHealthSentinel(unreadable.deps)).outcome).toBe("stood_down");
    expect(terminated(unreadable.events)).toBe(false);
    const unwritable = world(["answer", "timeout"], { writeHistory: () => false });
    expect((await runHealthSentinel(unwritable.deps)).outcome).toBe("stood_down");
    expect(terminated(unwritable.events)).toBe(false);
  });

  test("a busy ownership lease defers the recovery instead of acting", async () => {
    const busy = world(["answer", "timeout"]);
    let attempts = 0;
    busy.deps.withOwnershipLease = () => {
      attempts += 1;
      if (attempts === 2) busy.exitTarget();
      return "busy";
    };
    expect(await runHealthSentinel(busy.deps)).toEqual({ outcome: "target_exited" });
    expect(terminated(busy.events)).toBe(false);
    expect(busy.events.filter(event => event.includes("lease is busy"))).toHaveLength(2);
  });

  test("stands down when the runtime record names another process or a sibling", async () => {
    const replaced = world(["answer", "timeout"]);
    let reads = 0;
    replaced.deps.readRuntime = () => (++reads > 3 ? { ...replaced.runtime, pid: TARGET + 1 } : replaced.runtime);
    expect((await runHealthSentinel(replaced.deps)).outcome).toBe("stood_down");
    expect(terminated(replaced.events)).toBe(false);
    const sibling = world(["answer"], { readRuntime: () => ({ pid: TARGET, port: 4100, sibling: true }) });
    expect((await runHealthSentinel(sibling.deps)).outcome).toBe("stood_down");
  });

  test("a target that is no longer the parent at the last moment is skipped, not killed", async () => {
    const orphaned = world(["answer", "timeout"], { terminateTarget: () => "not_target" });
    expect(await runHealthSentinel(orphaned.deps)).toEqual({ outcome: "target_exited" });
    expect(orphaned.history.map(entry => entry.state)).toEqual(["intent", "skipped"]);
    const refused = world(["answer", "timeout"], { terminateTarget: () => "failed" });
    expect((await runHealthSentinel(refused.deps)).outcome).toBe("stood_down");
    expect(refused.history.map(entry => entry.state)).toEqual(["intent", "failed"]);
  });

  test("an exit that is not observed is recorded as unconfirmed", async () => {
    const stubborn = world(["answer", "timeout"], { terminateTarget: () => "terminated" });
    expect(await runHealthSentinel(stubborn.deps)).toEqual({ outcome: "recovered", state: "unconfirmed" });
    expect(stubborn.history.at(-1)?.state).toBe("unconfirmed");
  });

  test("a long healthy run subscribes to the target's exit once, not once per probe", async () => {
    const { deps, exitTarget } = world(["answer"]);
    const exit = deps.targetExited;
    let subscriptions = 0;
    deps.targetExited = { then: (...args: Parameters<Promise<void>["then"]>) => { subscriptions += 1; return exit.then(...args); } } as Promise<void>;
    let probes = 0;
    const probe = deps.probe;
    deps.probe = async (target, timeoutMs) => {
      probes += 1;
      if (probes === 5_000) exitTarget();
      return probe(target, timeoutMs);
    };
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "target_exited" });
    expect(probes).toBeGreaterThanOrEqual(5_000);
    expect(subscriptions).toBe(1);
  });

  test("leaves as soon as the target exits, even mid-probe", async () => {
    const { deps, events, exitTarget } = world(["answer"]);
    deps.probe = () => { exitTarget(); return new Promise<HealthProbeOutcome>(() => {}); };
    expect(await runHealthSentinel(deps)).toEqual({ outcome: "target_exited" });
    expect(terminated(events)).toBe(false);
  });

  test("DNS bind names never arm recovery or reach a probe", async () => {
    const w = world(["answer", "timeout"]);
    w.runtime.hostname = "health.attacker.invalid";
    expect((await runHealthSentinel(w.deps)).outcome).toBe("stood_down");
    expect(w.events.filter(event => event.startsWith("probe:"))).toHaveLength(0);
    expect(terminated(w.events)).toBe(false);
    expect(w.history).toHaveLength(0);
  });

  test.each(["127.0.0.2", "health.attacker.invalid"])("address change to %s after arming stands down", async hostname => {
    const w = world(["answer", "timeout"]);
    const probe = w.deps.probe;
    w.deps.probe = async (target, timeout) => {
      const outcome = await probe(target, timeout);
      w.runtime.hostname = hostname;
      return outcome;
    };
    expect((await runHealthSentinel(w.deps)).outcome).toBe("stood_down");
    expect(w.events.filter(event => event.startsWith("probe:"))).toHaveLength(1);
    expect(terminated(w.events)).toBe(false);
    expect(w.history).toHaveLength(0);
  });

  test.each(["address", "port"])("%s change during lease admission preserves the process", async changed => {
    const w = world(["answer", "timeout"]);
    const lease = w.deps.withOwnershipLease;
    w.deps.withOwnershipLease = run => {
      if (changed === "address") w.runtime.hostname = "127.0.0.2";
      else w.runtime.port++;
      return lease(run);
    };
    expect((await runHealthSentinel(w.deps)).outcome).toBe("stood_down");
    expect(terminated(w.events)).toBe(false);
    expect(w.history).toHaveLength(0);
  });

  test("endpoint change while writing intent is rechecked before termination", async () => {
    const w = world(["answer", "timeout"]);
    const write = w.deps.writeHistory;
    w.deps.writeHistory = entry => {
      if (entry.state === "intent") w.runtime.hostname = "127.0.0.2";
      return write(entry);
    };
    expect((await runHealthSentinel(w.deps)).outcome).toBe("stood_down");
    expect(terminated(w.events)).toBe(false);
    expect(w.history.map(entry => entry.state)).toEqual(["intent", "skipped"]);
  });
});

describe("health sentinel state files", () => {
  test("history: absent is empty, corrupt fails closed, entries settle in place, bounded and private", () => {
    home = createTempHome("ocx-sentinel-history-");
    const path = home.path("service-health-recovery.json");
    expect(readRecoveryEntries(path)).toEqual([]);
    for (let i = 0; i < 12; i += 1) expect(writeRecoveryEntry(path, { at: i, pid: 100 + i, state: "intent" })).toBe(true);
    expect(writeRecoveryEntry(path, { at: 11, pid: 111, state: "terminated" })).toBe(true);
    expect(writeRecoveryEntry(path, { at: 10, pid: 110, state: "skipped" })).toBe(true);
    const entries = readRecoveryEntries(path)!;
    expect(entries).toHaveLength(10);
    expect(entries.at(-1)).toEqual({ at: 11, pid: 111, state: "terminated" });
    expect(countedRecoveryTimes(entries)).not.toContain(10);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "{not json");
    expect(readRecoveryEntries(path)).toBeNull();
    expect(writeRecoveryEntry(path, { at: 99, pid: 1, state: "intent" })).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{not json");
    writeFileSync(path, JSON.stringify({ recoveries: [{ at: 1, pid: 2, state: "bogus" }] }));
    expect(readRecoveryEntries(path)).toBeNull();
  });

  test("a directory sync storage error fails the write; an unsupported sync does not", () => {
    home = createTempHome("ocx-sentinel-dirsync-");
    const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    if (process.platform !== "win32") {
      expect(syncDirectory(home.root, { fsync: failing("EIO") })).toBe(false);
      expect(syncDirectory(home.root, { fsync: failing("ENOSPC") })).toBe(false);
      expect(syncDirectory(home.root, { fsync: failing("EINVAL") })).toBe(true);
    }
    expect(syncDirectory(home.root)).toBe(true);
  });

  test("the lag monitor reports how late the sentinel's own loop ran", () => {
    let clock = 0;
    const lag = startLagMonitor(250, () => clock);
    try {
      clock = 250;
      expect(lag.read()).toBe(0);
      clock = 18_250;
      expect(lag.read()).toBe(18_000);
      lag.reset();
      expect(lag.read()).toBe(0);
    } finally {
      lag.stop();
    }
  });

  test("runtime record: validated, sibling flagged", () => {
    home = createTempHome("ocx-sentinel-runtime-");
    const path = home.path("runtime-port.json");
    writeFileSync(path, JSON.stringify({ pid: 12, port: 4100, hostname: "0.0.0.0", attestationSecret: "x" }));
    expect(readSentinelRuntime(path)).toEqual({ pid: 12, port: 4100, hostname: "0.0.0.0", sibling: false });
    writeFileSync(path, JSON.stringify({ pid: 12, port: 4101, siblingOfPort: 4100 }));
    expect(readSentinelRuntime(path)?.sibling).toBe(true);
    writeFileSync(path, JSON.stringify({ pid: -1, port: 4100 }));
    expect(readSentinelRuntime(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: 12, port: 4100, hostname: 4100 }));
    expect(readSentinelRuntime(path)).toBeNull();
  });

  test("timing override keeps only finite non-negative known fields", () => {
    expect(parseTimingOverride(undefined)).toEqual({});
    expect(parseTimingOverride("nope")).toEqual({});
    expect(parseTimingOverride(JSON.stringify({ intervalMs: 5, probeTimeoutMs: -1, bogus: 3, failureThreshold: "2" }))).toEqual({ intervalMs: 5 });
  });
});

describe("health sentinel probe", () => {
  test("classifies an answer, a silent listener and a closed port", async () => {
    const answering = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "opencodex", pid: 4321 }) });
    const silentSockets: net.Socket[] = [];
    const silent = net.createServer(socket => { silentSockets.push(socket); });
    await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
    const closed = net.createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    try {
      const ok = await probeHealth({ hostname: "127.0.0.1", port: answering.port! }, 2_000);
      expect(ok).toMatchObject({ kind: "answered", pid: 4321 });
      const hung = await probeHealth({ hostname: "0.0.0.0", port: (silent.address() as net.AddressInfo).port }, 300);
      expect(hung.kind).toBe("timeout");
      expect(hung.endedAt - hung.startedAt).toBeGreaterThanOrEqual(250);
      expect((await probeHealth({ hostname: "127.0.0.1", port: closedPort }, 2_000)).kind).toBe("refused");
    } finally {
      answering.stop(true);
      for (const socket of silentSockets) socket.destroy();
      await new Promise<void>(resolve => silent.close(() => resolve()));
    }
  });

  test("a non-JSON or pid-less answer still counts as an answer", async () => {
    const outcome = await probeHealth({ hostname: "127.0.0.1", port: 1 }, 100, {
      fetch: async () => new Response("package tree changed", { status: 503 }),
    });
    expect(outcome).toMatchObject({ kind: "answered", pid: null });
    expect(healthzPid(JSON.stringify({ pid: 0 }))).toBeNull();
    expect(probeUrlHost("::")).toBe("[::1]");
    expect(probeUrlHost("fd00::1")).toBe("[fd00::1]");
    expect(probeUrlHost(undefined)).toBe("127.0.0.1");
  });

  test.each(["health.attacker.invalid", "127.1", "2130706433", "[::1", "::1]", "fe80::1%en0"])("refuses unpinned destination %s before transport", async hostname => {
    let calls = 0;
    const outcome = await probeHealth({ hostname, port: 4100 }, 100, {
      fetch: async () => { calls++; throw Object.assign(new Error("redirected timeout"), { name: "TimeoutError" }); },
    });
    expect(outcome.kind).toBe("error");
    expect(calls).toBe(0);
  });

  test.each([
    [undefined, "127.0.0.1"], ["localhost.", "127.0.0.1"], ["LOCALHOST", "127.0.0.1"],
    ["0.0.0.0", "127.0.0.1"], ["127.0.0.2", "127.0.0.2"], ["::", "[::1]"],
    ["[::1]", "[::1]"], ["0:0:0:0:0:0:0:0", "[::1]"], ["fd00::1", "[fd00::1]"],
    // Every wildcard spelling the server accepts (isWildcardHostname) maps to loopback.
    ["*", "127.0.0.1"], ["0", "127.0.0.1"], ["00.0.0.000", "127.0.0.1"], ["0.0.0.0.", "127.0.0.1"],
    ["[::]", "[::1]"], ["::0", "[::1]"],
  ])("normalizes stable bind %s to %s", (hostname, expected) => {
    expect(probeUrlHost(hostname)).toBe(expected);
  });
});

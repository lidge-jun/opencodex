import { describe, expect, spyOn, test } from "bun:test";
import * as proxyLiveness from "../../src/server/proxy-liveness";
import { proxyStillLiveAfterStop } from "../../src/service";
import { WINDOWS_STOP_CAPS } from "../../src/service/windows-stop-budget";

/**
 * #764: `ocx service stop` reported success while the proxy kept running, and native Codex was
 * restored on top of it.
 *
 * The subtlety is which failure mode matters. PR #780 waited only when `schtasks /end` returned
 * an ERROR -- but the reported case is an /end that SUCCEEDS while the wrapper survives and
 * respawns its child a few seconds later. On that path the stop command has nothing to report,
 * so the outcome has to be probed rather than inferred from the command's exit status.
 */

/** Deterministic clock: no wall-clock sleeping, and the deadline is reached by construction. */
function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

describe("service stop verification (#764)", () => {
  test("a clean stop returns immediately when the supervisor cannot respawn", async () => {
    // The regression this must not introduce: launchd and systemd do not bring a child back
    // after unload/stop, so a single probe answers the question. Making every macOS and Linux
    // user wait out a Windows-specific restart window would trade one bug for a worse daily one.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => { probes += 1; return null; },
      canRespawn: false,
      ...clock,
    });
    expect(live).toBeNull();
    expect(probes).toBe(1);
    expect(clock.now()).toBe(0); // no sleeping at all
  });

  test("a proxy that respawns inside the restart window is detected", async () => {
    // The reported failure: /end succeeded, the wrapper lived, and the child came back at ~5s.
    // A single probe immediately after the stop command would have seen nothing and passed.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        return probes >= 5 ? { port: 10100 } : null;
      },
      canRespawn: true,
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
    expect(probes).toBeGreaterThan(1);
  });

  test("a genuinely stopped proxy returns null within the bound", async () => {
    // The control. Without it the check could report a survivor every time and block every
    // legitimate stop -- worse than the bug, since it would strand native Codex unrestored.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => { probes += 1; return null; },
      canRespawn: true,
      ...clock,
    });
    expect(live).toBeNull();
    expect(probes).toBeGreaterThan(1);
  });

  test("a probe that throws does not count as proof the proxy is gone", async () => {
    // A failing health probe means "unknown", not "stopped". Treating an exception as absence
    // would restore native Codex on top of a proxy that is merely unreachable for a moment.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        if (probes < 4) throw new Error("connection refused");
        return { port: 10100 };
      },
      canRespawn: true,
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });

  test("an immediately live proxy is caught on the first probe", async () => {
    const clock = fakeClock();
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => ({ port: 10100 }),
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });

  test("the platform default drives the behavior, not just the explicit flag", async () => {
    // Every other test passes canRespawn explicitly, so none of them exercises the DEFAULT --
    // a regression to `?? false` would leave them all green while Windows silently lost the
    // restart window it needs. These pin the derivation itself.
    const original = process.platform;
    const setPlatform = (value: string) =>
      Object.defineProperty(process, "platform", { value, configurable: true });
    try {
      setPlatform("linux");
      const linuxClock = fakeClock();
      let linuxProbes = 0;
      await proxyStillLiveAfterStop({
        findProxy: async () => { linuxProbes += 1; return null; },
        ...linuxClock,
      });
      expect(linuxProbes).toBe(1);
      expect(linuxClock.now()).toBe(0);

      setPlatform("win32");
      const winClock = fakeClock();
      let winProbes = 0;
      await proxyStillLiveAfterStop({
        findProxy: async () => { winProbes += 1; return null; },
        ...winClock,
      });
      expect(winProbes).toBeGreaterThan(1);
      expect(winClock.now()).toBeGreaterThanOrEqual(7000);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

/**
 * #7771: the tracked-proxy stop's orphan discovery is part of the checked Windows stop's
 * admitted budget (030 "Time budget"), which reserves 3 s for it. The helper used to
 * hard-code 7 s for every platform and every caller, so a Windows stop that had already
 * paid for Part A and Part B could still spend 7 s on discovery — past the deadline its
 * admission had just proven — and a non-Windows stop must keep today's 7 s.
 */
describe("orphan discovery is capped by the caller, not hard-coded (#7771)", () => {
  // The helper calls findLiveProxy directly, so the spy is the seam: it records the
  // deadline the helper asked for and answers "nothing live" so no process is touched.
  const discoveredBudget = async (io: Record<string, unknown>): Promise<number> => {
    const { stopTrackedProxyForServiceCommand } = await import("../../src/service/orchestration");
    let seen = -1;
    const started = Date.now();
    const spy = spyOn(proxyLiveness, "findLiveProxy").mockImplementation((async (options: { deadlineAt?: number }) => {
      seen = (options.deadlineAt ?? 0) - started;
      return null;
    }) as never);
    try {
      await stopTrackedProxyForServiceCommand(io as never);
    } finally {
      spy.mockRestore();
    }
    return seen;
  };

  test("the default keeps today's 7 s window", async () => {
    const budget = await discoveredBudget({});
    expect(budget).toBeGreaterThanOrEqual(6_900);
    expect(budget).toBeLessThanOrEqual(7_100);
  });

  test("a Windows checked caller's admitted 3 s is what discovery gets", async () => {
    const budget = await discoveredBudget({ orphanDiscoveryCapMs: WINDOWS_STOP_CAPS.orphanDiscovery });
    expect(WINDOWS_STOP_CAPS.orphanDiscovery).toBe(3_000);
    expect(budget).toBeGreaterThanOrEqual(2_900);
    expect(budget).toBeLessThanOrEqual(3_100);
  });

  test("an absent Part A still names the cap: discovery is the only port proof left", async () => {
    const { windowsServiceRemovalStop, windowsServiceStopBeforeRestore } = await import("../../src/service/cli-windows-stop");
    const { setWindowsServiceStopHooksForTests } = await import("../../src/service/windows-service-stop");
    const { partAResult } = await import("../helpers/windows-stop-caller-fixtures");
    setWindowsServiceStopHooksForTests({ partA: async () => partAResult("absent") });
    try {
      // The endpoint probes are injected: both callers would otherwise fall through to
      // the real ones, which on Windows spend their full window before answering, and this
      // test is about the discovery budget, not about that wait.
      const probed: unknown[] = [];
      for (const run of [windowsServiceStopBeforeRestore, windowsServiceRemovalStop]) {
        const seen: unknown[] = [];
        await run({
          ownsSharedTeardown: () => false,
          resolveTarget: async () => null,
          stopTracked: async io => { seen.push(io); return "stopped"; },
          endpointLiveness: async endpoint => { probed.push(endpoint); return "dead"; },
        });
        expect(seen).toEqual([{ target: null, skipPortWait: false, orphanDiscoveryCapMs: 3_000 }]);
      }
      expect(probed.length).toBe(2);
    } finally {
      setWindowsServiceStopHooksForTests(null);
    }
  });
});

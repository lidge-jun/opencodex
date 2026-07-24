import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRestartHistoryPathForTests } from "../src/server/memory-restart-history";
import {
  parseProcStatusCommitted,
  pressureBytes,
  pressureSource,
  readMemorySnapshot,
  setMemoryPlatformForTests,
  setProcStatusReaderForTests,
  setWindowsProbeRunnerForTests,
  type MemorySnapshot,
} from "../src/lib/memory-usage";
import {
  applyWatchdogRuntimeConfig,
  createWatchdogState,
  detectSupervisor,
  evaluate,
  memoryWatchdogReport,
  recommend,
  resolveWatchdogConfig,
  startMemoryWatchdog,
  stopMemoryWatchdog,
  tick,
  type ResolvedWatchdogConfig,
  type WatchdogDeps,
} from "../src/server/memory-watchdog";
import type { OcxConfig } from "../src/types";

const MiB = 1024 * 1024;

function snapshot(pressure: number, opts: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    rssBytes: opts.rssBytes ?? pressure,
    heapUsedBytes: opts.heapUsedBytes ?? 10 * MiB,
    externalBytes: opts.externalBytes ?? 0,
    committedBytes: opts.committedBytes ?? pressure,
    committedSource: opts.committedSource ?? "windows-private",
    totalSystemBytes: opts.totalSystemBytes ?? 100 * MiB,
  };
}

function cfg(over: Partial<ResolvedWatchdogConfig> = {}): ResolvedWatchdogConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    warnFraction: 0.60,
    criticalFraction: 0.75,
    autoRestart: false,
    requireSupervisor: true,
    minRestartIntervalMs: 600_000,
    maxRestarts: 3,
    restartGraceMs: 30_000,
    growthWindowMs: 600_000,
    ...over,
  };
}

describe("memory-usage snapshot", () => {
  test("parseProcStatusCommitted sums VmRSS + VmSwap (kB → bytes)", () => {
    const text = "Name:\tbun\nVmRSS:\t 1024 kB\nVmSwap:\t 512 kB\n";
    expect(parseProcStatusCommitted(text)).toBe((1024 + 512) * 1024);
  });

  test("parseProcStatusCommitted tolerates a missing VmSwap and rejects missing VmRSS", () => {
    expect(parseProcStatusCommitted("VmRSS:\t 2048 kB\n")).toBe(2048 * 1024);
    expect(parseProcStatusCommitted("VmData:\t 100 kB\n")).toBeNull();
  });

  test("linux snapshot reports committed from /proc/self/status", () => {
    setMemoryPlatformForTests("linux");
    setProcStatusReaderForTests(() => "VmRSS:\t 4096 kB\nVmSwap:\t 0 kB\n");
    try {
      const snap = readMemorySnapshot();
      expect(snap.committedSource).toBe("proc-status");
      expect(snap.committedBytes).toBe(4096 * 1024);
      expect(pressureSource(snap)).toBe("proc-status");
    } finally {
      setMemoryPlatformForTests(null);
      setProcStatusReaderForTests(null);
    }
  });

  test("windows snapshot uses the private-bytes probe", () => {
    setMemoryPlatformForTests("win32");
    setWindowsProbeRunnerForTests(() => ({ privateBytes: 79 * 1024 * MiB, timedOut: false }));
    try {
      const snap = readMemorySnapshot();
      expect(snap.committedSource).toBe("windows-private");
      expect(snap.committedBytes).toBe(79 * 1024 * MiB);
    } finally {
      setMemoryPlatformForTests(null);
      setWindowsProbeRunnerForTests(null);
    }
  });

  test("a timed-out windows probe soft-fails to the RSS fallback", () => {
    setMemoryPlatformForTests("win32");
    setWindowsProbeRunnerForTests(() => ({ privateBytes: null, timedOut: true }));
    try {
      const snap = readMemorySnapshot();
      expect(snap.committedBytes).toBeNull();
      expect(snap.committedSource).toBe("none");
      // pressure falls back to RSS so the watchdog still functions.
      expect(pressureBytes(snap)).toBe(snap.rssBytes);
      expect(pressureSource(snap)).toBe("rss-fallback");
    } finally {
      setMemoryPlatformForTests(null);
      setWindowsProbeRunnerForTests(null);
    }
  });
});

describe("resolveWatchdogConfig", () => {
  test("defaults are warn-only and enabled", () => {
    const r = resolveWatchdogConfig({} as OcxConfig);
    expect(r.enabled).toBe(true);
    expect(r.autoRestart).toBe(false);
    expect(r.warnFraction).toBe(0.60);
    expect(r.criticalFraction).toBe(0.75);
  });

  test("config file values override defaults", () => {
    const r = resolveWatchdogConfig({
      memoryWatchdog: { enabled: true, warnFraction: 0.5, criticalFraction: 0.8, autoRestart: true },
    } as OcxConfig);
    expect(r.warnFraction).toBe(0.5);
    expect(r.criticalFraction).toBe(0.8);
    expect(r.autoRestart).toBe(true);
  });

  test("critical <= warn is nudged above warn so the levels never collapse", () => {
    const r = resolveWatchdogConfig({
      memoryWatchdog: { warnFraction: 0.7, criticalFraction: 0.6 },
    } as OcxConfig);
    expect(r.criticalFraction).toBeGreaterThan(r.warnFraction);
  });

  test("fractions are clamped into [0.10, 0.99]", () => {
    const r = resolveWatchdogConfig({
      memoryWatchdog: { warnFraction: 0.01, criticalFraction: 5 },
    } as OcxConfig);
    expect(r.warnFraction).toBe(0.10);
    expect(r.criticalFraction).toBe(0.99);
  });

  test("restartGraceMs defaults to the quiet-window budget and is config-overridable", () => {
    expect(resolveWatchdogConfig({} as OcxConfig).restartGraceMs).toBe(30_000);
    const r = resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: 120_000 } } as OcxConfig);
    expect(r.restartGraceMs).toBe(120_000);
  });

  test("restartGraceMs is clamped into [1s, 10min]; junk falls back to the default", () => {
    expect(resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: 5 } } as OcxConfig).restartGraceMs).toBe(1_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: 86_400_000 } } as OcxConfig).restartGraceMs).toBe(600_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: -1 } } as OcxConfig).restartGraceMs).toBe(30_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: Number.NaN } } as OcxConfig).restartGraceMs).toBe(30_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { restartGraceMs: Number.POSITIVE_INFINITY } } as OcxConfig).restartGraceMs).toBe(30_000);
  });

  test("cooldown < grace is raised to the grace so a drain can never overlap the next restart", () => {
    const r = resolveWatchdogConfig({
      memoryWatchdog: { restartGraceMs: 120_000, minRestartIntervalMs: 5_000 },
    } as OcxConfig);
    expect(r.minRestartIntervalMs).toBe(120_000);
    // A cooldown already >= grace is untouched.
    const ok = resolveWatchdogConfig({
      memoryWatchdog: { restartGraceMs: 30_000, minRestartIntervalMs: 900_000 },
    } as OcxConfig);
    expect(ok.minRestartIntervalMs).toBe(900_000);
  });

  test("intervalMs gets a 1s floor and junk falls back to the default", () => {
    expect(resolveWatchdogConfig({ memoryWatchdog: { intervalMs: 5 } } as OcxConfig).intervalMs).toBe(1_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { intervalMs: -60_000 } } as OcxConfig).intervalMs).toBe(60_000);
    expect(resolveWatchdogConfig({ memoryWatchdog: { intervalMs: Number.NaN } } as OcxConfig).intervalMs).toBe(60_000);
  });

  test("maxRestarts keeps 0 (meaning: never auto-restart) and rejects negatives/junk", () => {
    expect(resolveWatchdogConfig({ memoryWatchdog: { maxRestarts: 0 } } as OcxConfig).maxRestarts).toBe(0);
    expect(resolveWatchdogConfig({ memoryWatchdog: { maxRestarts: 2.9 } } as OcxConfig).maxRestarts).toBe(2);
    expect(resolveWatchdogConfig({ memoryWatchdog: { maxRestarts: -3 } } as OcxConfig).maxRestarts).toBe(3);
    expect(resolveWatchdogConfig({ memoryWatchdog: { maxRestarts: Number.NaN } } as OcxConfig).maxRestarts).toBe(3);
  });
});

describe("evaluate (pure decision core)", () => {
  test("stays ok below the warn fraction", () => {
    const s = createWatchdogState();
    const d = evaluate(s, snapshot(50 * MiB), cfg(), 1_000);
    expect(d.level).toBe("ok");
    expect(d.action).toBe("none");
  });

  test("warns once on the first crossing, then latches", () => {
    const s = createWatchdogState();
    const first = evaluate(s, snapshot(65 * MiB), cfg(), 1_000);
    expect(first.level).toBe("warn");
    expect(first.action).toBe("warn");
    const second = evaluate(s, snapshot(66 * MiB), cfg(), 2_000);
    expect(second.level).toBe("warn");
    expect(second.action).toBe("none"); // latched — no repeat log
  });

  test("recovering to ok re-arms the warning", () => {
    const s = createWatchdogState();
    evaluate(s, snapshot(65 * MiB), cfg(), 1_000);
    evaluate(s, snapshot(50 * MiB), cfg(), 2_000); // back to ok
    const again = evaluate(s, snapshot(65 * MiB), cfg(), 3_000);
    expect(again.action).toBe("warn");
  });

  test("critical with auto-restart disabled warns but never restarts", () => {
    const s = createWatchdogState();
    const d = evaluate(s, snapshot(80 * MiB), cfg({ autoRestart: false }), 1_000);
    expect(d.level).toBe("critical");
    expect(d.action).toBe("warn");
    expect(d.reason).toContain("auto-restart disabled");
    expect(s.restartCount).toBe(0);
  });

  test("critical with auto-restart armed restarts once, then defers by cooldown", () => {
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 600_000 });
    const first = evaluate(s, snapshot(80 * MiB), c, 1_000);
    expect(first.action).toBe("restart");
    expect(s.restartCount).toBe(1);

    // Still critical a moment later — cooldown must suppress a second restart.
    const second = evaluate(s, snapshot(85 * MiB), c, 2_000);
    expect(second.action).not.toBe("restart");
    expect(second.reason).toContain("cooldown");
    expect(s.restartCount).toBe(1);
  });

  test("max-restart guard stops restarting after the cap", () => {
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 0, maxRestarts: 2 });
    // Each call is critical and past the (zero) cooldown.
    expect(evaluate(s, snapshot(80 * MiB), c, 10_000).action).toBe("restart");
    expect(evaluate(s, snapshot(80 * MiB), c, 20_000).action).toBe("restart");
    const third = evaluate(s, snapshot(80 * MiB), c, 30_000);
    expect(third.action).not.toBe("restart");
    expect(third.reason).toContain("max-restart");
    expect(s.restartCount).toBe(2);
  });

  test("computes growth rate across the sample window", () => {
    const s = createWatchdogState();
    evaluate(s, snapshot(50 * MiB), cfg(), 0);
    const d = evaluate(s, snapshot(60 * MiB), cfg(), 3_600_000); // +10 MiB over exactly 1h
    expect(d.growthMbPerHour).toBe(10);
  });
});

describe("tick (driver wiring)", () => {
  function deps(over: Partial<WatchdogDeps>): WatchdogDeps {
    return {
      now: () => 1_000,
      read: () => snapshot(50 * MiB),
      supervised: true,
      restart: () => {},
      log: () => {},
      ...over,
    };
  }

  test("logs on a warn action and invokes restart on a restart action", () => {
    const logs: string[] = [];
    let restarts = 0;
    let restartGrace = 0;
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 0, restartGraceMs: 45_000 });

    // warn crossing
    tick(s, c, deps({ read: () => snapshot(65 * MiB), log: l => logs.push(l) }));
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("WARN");

    // critical crossing → restart, and the running cfg (incl. the quiet-window budget) is threaded through
    const d = tick(s, c, deps({
      read: () => snapshot(80 * MiB),
      log: l => logs.push(l),
      restart: rc => { restarts += 1; restartGrace = rc.restartGraceMs; },
      now: () => 2_000,
    }));
    expect(d.action).toBe("restart");
    expect(restarts).toBe(1);
    expect(restartGrace).toBe(45_000);
  });

  test("a read failure inside tick propagates as a thrown error only to the caller's try", () => {
    // startMemoryWatchdog wraps tick in try/catch; here we assert tick itself surfaces the error
    // so the wrapper (not the timer) owns swallowing it.
    const s = createWatchdogState();
    expect(() => tick(s, cfg(), deps({ read: () => { throw new Error("probe boom"); } }))).toThrow("probe boom");
  });

  test("a synchronously-throwing restart hook is logged, not thrown out of tick", () => {
    const logs: string[] = [];
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 0 });
    const d = tick(s, c, deps({
      read: () => snapshot(80 * MiB),
      log: l => logs.push(l),
      restart: () => { throw new Error("hook boom"); },
    }));
    expect(d.action).toBe("restart");
    expect(logs.some(l => l.includes("restart hook failed") && l.includes("hook boom"))).toBe(true);
  });

  test("a rejecting async restart hook is logged instead of surfacing as an unhandled rejection", async () => {
    const logs: string[] = [];
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 0 });
    tick(s, c, deps({
      read: () => snapshot(80 * MiB),
      log: l => logs.push(l),
      restart: () => Promise.reject(new Error("async boom")),
    }));
    await Bun.sleep(0); // let the rejection handler run
    expect(logs.some(l => l.includes("restart hook failed") && l.includes("async boom"))).toBe(true);
  });

  test("a restart decision is persisted via recordRestart with the decision timestamp", () => {
    const recorded: number[] = [];
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, minRestartIntervalMs: 0 });
    tick(s, c, deps({
      read: () => snapshot(80 * MiB),
      now: () => 42_000,
      recordRestart: at => recorded.push(at),
    }));
    expect(recorded).toEqual([42_000]);
  });

  test("a warn action does not touch the restart history", () => {
    const recorded: number[] = [];
    const s = createWatchdogState();
    tick(s, cfg(), deps({ read: () => snapshot(65 * MiB), recordRestart: at => recorded.push(at) }));
    expect(recorded).toEqual([]);
  });
});

describe("detectSupervisor", () => {
  test("explicit OCX_SUPERVISED=1 wins", () => {
    expect(detectSupervisor({ OCX_SUPERVISED: "1" })).toEqual({ supervised: true, hint: "OCX_SUPERVISED" });
  });

  test("pm2 markers are detected", () => {
    expect(detectSupervisor({ pm_id: "0" })).toEqual({ supervised: true, hint: "pm2" });
    expect(detectSupervisor({ PM2_HOME: "/home/app/.pm2" })).toEqual({ supervised: true, hint: "pm2" });
  });

  test("systemd markers are detected", () => {
    expect(detectSupervisor({ INVOCATION_ID: "abc123" })).toEqual({ supervised: true, hint: "systemd" });
    expect(detectSupervisor({ NOTIFY_SOCKET: "/run/systemd/notify" })).toEqual({ supervised: true, hint: "systemd" });
  });

  test("nothing set → not supervised (safe default)", () => {
    expect(detectSupervisor({})).toEqual({ supervised: false, hint: "none" });
  });

  test("explicit OCX_SUPERVISED=off reports the reason", () => {
    expect(detectSupervisor({ OCX_SUPERVISED: "off" })).toEqual({ supervised: false, hint: "OCX_SUPERVISED=off" });
  });
});

describe("recommend (advisory only)", () => {
  test("with < 2 samples it echoes current config and says so", () => {
    const s = createWatchdogState();
    const r = recommend(s, cfg({ warnFraction: 0.5, criticalFraction: 0.7 }), true);
    expect(r.warnFraction).toBe(0.5);
    expect(r.criticalFraction).toBe(0.7);
    expect(r.rationale).toContain("insufficient samples");
  });

  test("places warn above the observed peak and keeps critical > warn", () => {
    const s = createWatchdogState();
    const c = cfg();
    evaluate(s, snapshot(40 * MiB), c, 0); // fraction 0.40
    evaluate(s, snapshot(50 * MiB), c, 1_000); // fraction 0.50 (observed peak)
    const r = recommend(s, c, true);
    expect(r.warnFraction).toBeGreaterThan(0.50);
    expect(r.criticalFraction).toBeGreaterThan(r.warnFraction);
  });

  test("clamps into [0.10, 0.99] even at very high pressure", () => {
    const s = createWatchdogState();
    const c = cfg();
    evaluate(s, snapshot(95 * MiB), c, 0);
    evaluate(s, snapshot(98 * MiB), c, 1_000);
    const r = recommend(s, c, true);
    expect(r.warnFraction).toBeLessThanOrEqual(0.99);
    expect(r.criticalFraction).toBeLessThanOrEqual(0.99);
  });

  test("suggests auto-restart only when supervised AND trending up", () => {
    const s = createWatchdogState();
    const c = cfg();
    evaluate(s, snapshot(40 * MiB), c, 0);
    evaluate(s, snapshot(50 * MiB), c, 3_600_000); // growing
    expect(recommend(s, c, true).autoRestart).toBe(true);
    expect(recommend(s, c, false).autoRestart).toBe(false); // no supervisor → never suggested
  });

  test("does not suggest auto-restart for a flat process", () => {
    const s = createWatchdogState();
    const c = cfg();
    evaluate(s, snapshot(50 * MiB), c, 0);
    evaluate(s, snapshot(50 * MiB), c, 3_600_000); // no growth
    expect(recommend(s, c, true).autoRestart).toBe(false);
  });
});

describe("evaluate — requireSupervisor gate", () => {
  test("critical + autoRestart but no supervisor → warns instead of restarting", () => {
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, requireSupervisor: true, minRestartIntervalMs: 0 });
    const d = evaluate(s, snapshot(80 * MiB), c, 1_000, /* supervised */ false);
    expect(d.level).toBe("critical");
    expect(d.action).toBe("warn");
    expect(d.reason).toContain("no supervisor");
    expect(s.restartCount).toBe(0);
  });

  test("critical + autoRestart + supervised → restarts", () => {
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, requireSupervisor: true, minRestartIntervalMs: 0 });
    const d = evaluate(s, snapshot(80 * MiB), c, 1_000, /* supervised */ true);
    expect(d.action).toBe("restart");
    expect(s.restartCount).toBe(1);
  });

  test("requireSupervisor=false lets auto-restart fire without a supervisor", () => {
    const s = createWatchdogState();
    const c = cfg({ autoRestart: true, requireSupervisor: false, minRestartIntervalMs: 0 });
    const d = evaluate(s, snapshot(80 * MiB), c, 1_000, /* supervised */ false);
    expect(d.action).toBe("restart");
  });
});

describe("applyWatchdogRuntimeConfig (live tuning)", () => {
  test("returns null when the watchdog is not running", () => {
    stopMemoryWatchdog();
    expect(applyWatchdogRuntimeConfig({ warnFraction: 0.5 })).toBeNull();
  });

  test("live-updates fractions with clamping and critical > warn", () => {
    try {
      startMemoryWatchdog({} as OcxConfig, { read: () => snapshot(50 * MiB), now: () => 0, log: () => {} });
      const applied = applyWatchdogRuntimeConfig({ warnFraction: 0.01, criticalFraction: 5 });
      expect(applied).not.toBeNull();
      expect(applied!.warnFraction).toBe(0.10); // clamped up
      expect(applied!.criticalFraction).toBe(0.99); // clamped down
      const collapsed = applyWatchdogRuntimeConfig({ warnFraction: 0.7, criticalFraction: 0.6 });
      expect(collapsed!.criticalFraction).toBeGreaterThan(collapsed!.warnFraction);
    } finally {
      stopMemoryWatchdog();
    }
  });

  test("updates requireSupervisor / autoRestart in place", () => {
    try {
      startMemoryWatchdog({} as OcxConfig, { read: () => snapshot(50 * MiB), now: () => 0, log: () => {} });
      const applied = applyWatchdogRuntimeConfig({ autoRestart: true, requireSupervisor: false });
      expect(applied!.autoRestart).toBe(true);
      expect(applied!.requireSupervisor).toBe(false);
    } finally {
      stopMemoryWatchdog();
    }
  });

  test("live-tuned restartGraceMs is clamped and the cooldown is raised to match", () => {
    try {
      startMemoryWatchdog({} as OcxConfig, { read: () => snapshot(50 * MiB), now: () => 0, log: () => {} });
      const clamped = applyWatchdogRuntimeConfig({ restartGraceMs: 86_400_000 });
      expect(clamped!.restartGraceMs).toBe(600_000);
      // Default cooldown is exactly 10 min — equal to the clamped grace, so it is untouched.
      expect(clamped!.minRestartIntervalMs).toBe(600_000);
      const raised = applyWatchdogRuntimeConfig({ restartGraceMs: 300_000, minRestartIntervalMs: 60_000 });
      expect(raised!.restartGraceMs).toBe(300_000);
      expect(raised!.minRestartIntervalMs).toBe(300_000); // raised from 60s to the grace
      const junk = applyWatchdogRuntimeConfig({ restartGraceMs: Number.NaN });
      expect(junk!.restartGraceMs).toBe(300_000); // invalid live input keeps the running value
    } finally {
      stopMemoryWatchdog();
    }
  });
});

describe("startMemoryWatchdog — cross-process history seeding", () => {
  test("seeds cooldown clock and restarts-in-window count from the persisted history", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-watchdog-seed-"));
    const path = join(root, "memory-watchdog-restarts.json");
    const NOW = 100 * 3_600_000;
    try {
      writeFileSync(path, JSON.stringify({ version: 1, restarts: [NOW - 120_000, NOW - 60_000] }), "utf-8");
      setRestartHistoryPathForTests(path);
      startMemoryWatchdog({} as OcxConfig, { read: () => snapshot(50 * MiB), now: () => NOW, log: () => {} });
      const report = memoryWatchdogReport();
      expect(report!.restartCount).toBe(2);
    } finally {
      stopMemoryWatchdog();
      setRestartHistoryPathForTests(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing history file seeds a fresh slate", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-watchdog-seed-"));
    try {
      setRestartHistoryPathForTests(join(root, "absent.json"));
      startMemoryWatchdog({} as OcxConfig, { read: () => snapshot(50 * MiB), now: () => 1_000, log: () => {} });
      expect(memoryWatchdogReport()!.restartCount).toBe(0);
    } finally {
      stopMemoryWatchdog();
      setRestartHistoryPathForTests(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

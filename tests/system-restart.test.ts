/**
 * #563 — memory-card drain-and-restart acceptance + respawn policy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { resetLifecycleDrainStateForTests, setDraining } from "../src/server/lifecycle";
import {
  DEADLINE_LISTENER_STOP_TIMEOUT_MS,
  MEMORY_DRAIN_RESTART_MS,
  REPLACEMENT_READY_TIMEOUT_MS,
  acceptSystemRestart,
  setSystemRestartIoForTests,
  waitForReplacementReady,
} from "../src/server/management/system-restart";
import { SYSTEM_RESTART_EXPECTED_PID_HEADER } from "../src/lib/system-restart-contract";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

afterEach(() => {
  setSystemRestartIoForTests();
  resetLifecycleDrainStateForTests();
});

describe("acceptSystemRestart", () => {
  test("uses the remaining absolute restart budget, spawns start, marks recycle, then exits 0", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let deadlineCallback: (() => void) | null = null;
    let deadlineDelay = -1;
    let deadlineCancellations = 0;
    let now = 10_000;

    const result = acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 3,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn, ms) => {
        deadlineCallback = fn;
        deadlineDelay = ms;
        return () => { deadlineCancellations += 1; };
      },
      now: () => now,
      setDraining: (value) => { calls.push(`draining:${value}`); },
      drainAndShutdown: async (_server, timeoutMs) => {
        calls.push(`drain:${timeoutMs}`);
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: (port, waitForHealth) => { calls.push(`start:${port}:${waitForHealth ? "ready" : "deferred"}`); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    expect(result).toEqual({
      accepted: true,
      alreadyDraining: false,
      activeTurnCount: 3,
      drainTimeoutMs: MEMORY_DRAIN_RESTART_MS,
    });
    // Data-plane reject must arm before the 200ms flush delay runs.
    expect(calls).toEqual(["draining:true"]);
    expect(MEMORY_DRAIN_RESTART_MS).toBe(60_000);
    expect(scheduled).not.toBeNull();
    now += 15_000;
    await scheduled!();
    expect(calls).toEqual(["draining:true", "drain:45000", "stop", "start:10123:ready", "recycle", "exit:0"]);
    expect(deadlineDelay).toBe(45_000);
    expect(deadlineCancellations).toBe(1);
    deadlineCallback?.();
    expect(calls).toEqual(["draining:true", "drain:45000", "stop", "start:10123:ready", "recycle", "exit:0"]);
  });

  test("snapshots the restart port before normal drain invalidates listener metadata", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let portAvailable = true;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => {
        calls.push(`port:${portAvailable ? 10123 : "gone"}`);
        return portAvailable ? 10123 : undefined;
      },
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: () => () => {},
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: async () => {
        calls.push("drain");
        portAvailable = false;
      },
      stopListener: () => {
        calls.push("stop");
        portAvailable = false;
      },
      spawnStart: (port) => { calls.push(`start:${port}`); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual([
      "latched",
      "port:10123",
      "drain",
      "stop",
      "start:10123",
      "recycle",
      "exit:0",
    ]);
  });

  test("never-settling unsupervised drain starts one replacement at the original deadline", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let fireDeadline: (() => void) | null = null;
    let resolveStop!: () => void;
    let resolveStart!: () => void;
    let signalStartEntered!: () => void;
    const startEntered = new Promise<void>(resolve => { signalStartEntered = resolve; });
    let deadlineSchedules = 0;
    let now = 1_000;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 1,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn, ms) => {
        deadlineSchedules += 1;
        if (deadlineSchedules === 1) {
          expect(ms).toBe(60_000);
          fireDeadline = fn;
        } else {
          expect(ms).toBe(DEADLINE_LISTENER_STOP_TIMEOUT_MS);
        }
        return () => {};
      },
      now: () => now,
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>(() => {});
      },
      stopListener: () => {
        calls.push("stop");
        return new Promise<void>(resolve => { resolveStop = resolve; });
      },
      spawnStart: (port, waitForHealth) => {
        calls.push(`start:${port}:${waitForHealth ? "ready" : "deferred"}`);
        signalStartEntered();
        return new Promise<void>(resolve => { resolveStart = resolve; });
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["latched", "drain"]);
    now += 60_000;
    fireDeadline?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["latched", "drain", "stop"]);
    resolveStop();
    await startEntered;
    expect(calls).toEqual(["latched", "drain", "stop", "start:10123:deferred"]);
    resolveStart();
    await running;
    expect(calls).toEqual(["latched", "drain", "stop", "start:10123:deferred", "recycle", "exit:0"]);
  });

  test("exactly elapsed unsupervised deadline starts replacement without waiting for late drain resolution", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let resolveDrain!: () => void;
    let now = 5_000;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (_fn, ms) => {
        expect(ms).toBe(DEADLINE_LISTENER_STOP_TIMEOUT_MS);
        return () => {};
      },
      now: () => now,
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: (_server, timeoutMs) => {
        calls.push(`drain:${timeoutMs}`);
        return new Promise<void>(resolve => { resolveDrain = resolve; });
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: (port) => { calls.push(`start:${port}`); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    now += MEMORY_DRAIN_RESTART_MS;
    await scheduled!();
    expect(calls).toEqual(["latched", "drain:0", "stop", "start:10123", "recycle", "exit:0"]);
    resolveDrain();
    await Promise.resolve();
    expect(calls).toEqual(["latched", "drain:0", "stop", "start:10123", "recycle", "exit:0"]);
  });

  test("deadline leaves a supervised child to its failure-only supervisor", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let fireDeadline: (() => void) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => true,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn) => { fireDeadline = fn; return () => {}; },
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>(() => {});
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: () => { calls.push("start"); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    fireDeadline?.();
    await running;
    expect(calls).toEqual(["latched", "drain", "exit:1"]);
  });

  test("deadline spawn failure exits 1 without marking an unsupervised restart recyclable", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let fireDeadline: (() => void) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn) => { fireDeadline = fn; return () => {}; },
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>(() => {});
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: async () => {
        calls.push("start");
        throw Object.assign(new Error("spawn error"), { code: "EACCES" });
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    fireDeadline?.();
    await running;
    expect(calls).toEqual(["latched", "drain", "stop", "start", "exit:1"]);
  });

  test("deadline listener-stop failure still hands off to a deferred replacement", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let fireDeadline: (() => void) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn) => { fireDeadline = fn; return () => {}; },
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>(() => {});
      },
      stopListener: async () => {
        calls.push("stop");
        throw new Error("fixture stop failure");
      },
      spawnStart: (_port, waitForHealth) => {
        calls.push(`start:${waitForHealth ? "ready" : "deferred"}`);
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    fireDeadline?.();
    await running;
    expect(calls).toEqual(["latched", "drain", "stop", "start:deferred", "recycle", "exit:0"]);
  });

  test("deadline bounds a never-settling listener stop and ignores its late rejection", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let rejectStop!: (reason?: unknown) => void;
    let now = 1_000;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
      now: () => now,
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>(() => {});
      },
      stopListener: () => {
        calls.push("stop");
        return new Promise<void>((_resolve, reject) => { rejectStop = reject; });
      },
      spawnStart: (port, waitForHealth) => {
        calls.push(`start:${port}:${waitForHealth ? "ready" : "deferred"}`);
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers[0]?.ms).toBe(MEMORY_DRAIN_RESTART_MS);
    timers[0]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers[1]?.ms).toBe(DEADLINE_LISTENER_STOP_TIMEOUT_MS);
    expect(calls).toEqual(["latched", "drain", "stop"]);

    timers[1]!.fn();
    await running;
    expect(calls).toEqual([
      "latched",
      "drain",
      "stop",
      "start:10123:deferred",
      "recycle",
      "exit:0",
    ]);

    rejectStop(new Error("late fixture stop rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      "latched",
      "drain",
      "stop",
      "start:10123:deferred",
      "recycle",
      "exit:0",
    ]);
  });

  test("normal unsupervised stop rejection also preserves a replacement", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: () => () => {},
      setDraining: () => {},
      drainAndShutdown: async () => { calls.push("drain"); },
      stopListener: async () => {
        calls.push("stop");
        throw new Error("fixture stop rejection");
      },
      spawnStart: (port, waitForHealth) => {
        calls.push(`start:${port}:${waitForHealth ? "ready" : "deferred"}`);
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual([
      "drain",
      "stop",
      "start:10123:deferred",
      "recycle",
      "exit:0",
    ]);
  });

  test("a reported drain failure uses the uncertain-cleanup restart handoff", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: fn => { scheduled = fn; },
      scheduleDeadline: () => () => {},
      setDraining: () => {},
      drainAndShutdown: async () => false,
      stopListener: () => { calls.push("stop"); },
      spawnStart: (port, waitForHealth) => {
        calls.push(`start:${port}:${waitForHealth ? "ready" : "deferred"}`);
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: code => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual(["stop", "start:10123:deferred", "recycle", "exit:1"]);
  });

  test("late drain rejection after timeout is observed without a second terminal action", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let fireDeadline: (() => void) | null = null;
    let rejectDrain!: (reason?: unknown) => void;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 1,
      schedule: (fn) => { scheduled = fn; },
      scheduleDeadline: (fn) => { fireDeadline = fn; return () => {}; },
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: () => {
        calls.push("drain");
        return new Promise<void>((_resolve, reject) => { rejectDrain = reject; });
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: () => { calls.push("start"); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    const running = scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    fireDeadline?.();
    await running;
    expect(calls).toEqual(["latched", "drain", "stop", "start", "recycle", "exit:0"]);
    rejectDrain(new Error("late fixture rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["latched", "drain", "stop", "start", "recycle", "exit:0"]);
  });

  test("supervised service child exits 1 so failure-only supervisors respawn", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => true,
      schedule: (fn) => { scheduled = fn; },
      drainAndShutdown: async () => { calls.push("drain"); },
      stopListener: () => { calls.push("stop"); },
      spawnStart: () => { calls.push("start"); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual(["drain", "exit:1"]);
  });

  test("OCX_SERVICE with non-viable Background Service uses detached start", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    const prev = process.env.OCX_SERVICE;
    process.env.OCX_SERVICE = "1";

    try {
      acceptSystemRestart({
        isDraining: () => false,
        getActiveTurnCount: () => 0,
        // Installed-but-stale assets must NOT count as supervised recovery.
        isServiceViable: () => false,
        listenPort: () => 10123,
        schedule: (fn) => { scheduled = fn; },
        setDraining: () => {},
        drainAndShutdown: async () => { calls.push("drain"); },
        spawnStart: (port) => { calls.push(`start:${port}`); },
        markRecycling: () => { calls.push("recycle"); },
        exitProcess: (code) => { calls.push(`exit:${code}`); },
      });

      await scheduled!();
      expect(calls).toEqual(["drain", "start:10123", "recycle", "exit:0"]);
    } finally {
      if (prev === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prev;
    }
  });

  test("OCX_SERVICE with viable Background Service exits 1 for supervisor respawn", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    const prev = process.env.OCX_SERVICE;
    process.env.OCX_SERVICE = "1";

    try {
      acceptSystemRestart({
        isDraining: () => false,
        getActiveTurnCount: () => 0,
        isServiceViable: () => true,
        schedule: (fn) => { scheduled = fn; },
        drainAndShutdown: async () => { calls.push("drain"); },
        spawnStart: () => { calls.push("start"); },
        markRecycling: () => { calls.push("recycle"); },
        exitProcess: (code) => { calls.push(`exit:${code}`); },
      });

      await scheduled!();
      expect(calls).toEqual(["drain", "exit:1"]);
    } finally {
      if (prev === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prev;
    }
  });

  test("spawn sync throw exits 1 without marking recycle", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      acceptSystemRestart({
        isDraining: () => false,
        getActiveTurnCount: () => 0,
        isSupervisedServiceChild: () => false,
        listenPort: () => 10123,
        schedule: (fn) => { scheduled = fn; },
        setDraining: () => {},
        drainAndShutdown: async () => { calls.push("drain"); },
        spawnStart: () => {
          calls.push("start");
          const err = new Error(
            "ENOENT: no such file or directory, uv_spawn 'C:\\Users\\Alice\\AppData\\Local\\bun\\bun.exe'",
          ) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
        markRecycling: () => { calls.push("recycle"); },
        exitProcess: (code) => { calls.push(`exit:${code}`); },
      });

      await scheduled!();
      expect(calls).toEqual(["drain", "start", "exit:1"]);
      expect(warnings.some((w) => w.includes("ENOENT"))).toBe(true);
      expect(warnings.some((w) => /Alice|AppData|bun\.exe/i.test(w))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("replacement readiness rejection exits 1 without marking recycle", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 0,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      setDraining: () => {},
      drainAndShutdown: async () => { calls.push("drain"); },
      spawnStart: async () => {
        calls.push("start");
        throw Object.assign(new Error("replacement never became healthy"), { code: "readiness_timeout" });
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual(["drain", "start", "exit:1"]);
  });

  test("drain rejection still reaches one replacement handoff and terminal exit", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 1,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      setDraining: () => { calls.push("latched"); },
      drainAndShutdown: async () => {
        calls.push("drain");
        throw new Error("fixture cleanup rejection");
      },
      stopListener: () => { calls.push("stop"); },
      spawnStart: (port) => { calls.push(`start:${port}`); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual(["latched", "drain", "stop", "start:10123", "recycle", "exit:1"]);
  });

  test("spawn failure clears OCX_SERVICE so exit cleanup can restore fences", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    const prev = process.env.OCX_SERVICE;
    process.env.OCX_SERVICE = "1";

    try {
      acceptSystemRestart({
        isDraining: () => false,
        getActiveTurnCount: () => 0,
        // A stale service marker without a viable service must use the unsupervised spawn path.
        isSupervisedServiceChild: () => false,
        listenPort: () => 10123,
        schedule: (fn) => { scheduled = fn; },
        setDraining: () => {},
        drainAndShutdown: async () => { calls.push("drain"); },
        spawnStart: () => {
          calls.push("start");
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        markRecycling: () => { calls.push("recycle"); },
        exitProcess: (code) => { calls.push(`exit:${code}`); },
      });

      await scheduled!();
      expect(calls).toEqual(["drain", "start", "exit:1"]);
      expect(process.env.OCX_SERVICE).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prev;
    }
  });

  test("does not schedule a second drain while already draining", async () => {
    let scheduled = 0;
    const result = acceptSystemRestart({
      isDraining: () => true,
      getActiveTurnCount: () => 2,
      schedule: () => { scheduled += 1; },
    });
    expect(result.alreadyDraining).toBe(true);
    expect(result.activeTurnCount).toBe(2);
    expect(scheduled).toBe(0);
  });

  test("latches so a second accept before drain starts is a no-op", async () => {
    let scheduled = 0;
    const io = {
      isDraining: () => false,
      getActiveTurnCount: () => 1,
      schedule: () => { scheduled += 1; },
    };
    const first = acceptSystemRestart(io);
    const second = acceptSystemRestart(io);
    expect(first.alreadyDraining).toBe(false);
    expect(second.alreadyDraining).toBe(true);
    expect(scheduled).toBe(1);
  });

  test("profile-first ordering queues and hands off exactly once across repeated accepts", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;
    let scheduleCount = 0;
    const io = {
      isShutdownDraining: () => false,
      getActiveTurnCount: () => 0,
      beginShutdownDrain: () => { calls.push("shutdown-latched"); return true; },
      schedule: (fn: () => void | Promise<void>) => { scheduleCount += 1; scheduled = fn; },
      drainAndShutdown: async () => { calls.push("shutdown"); },
      isSupervisedServiceChild: () => false,
      spawnStart: () => { calls.push("start"); },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code: number) => { calls.push(`exit:${code}`); },
    };
    const first = acceptSystemRestart(io);
    const second = acceptSystemRestart(io);
    expect(first.alreadyDraining).toBe(false);
    expect(second.alreadyDraining).toBe(true);
    expect(scheduleCount).toBe(1);
    await scheduled!();
    expect(calls).toEqual(["shutdown-latched", "shutdown", "start", "recycle", "exit:0"]);
  });
});

describe("replacement readiness budget", () => {
  test("allows the ordinary 65s Windows reclaim boundary without wall-clock delay", async () => {
    let now = 0;
    const ready = await waitForReplacementReady(222, 111, 10123, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      findLive: async () => now >= 65_000
        ? { pid: 222, port: 10123, source: "runtime" }
        : null,
    });

    expect(REPLACEMENT_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(65_000);
    expect(ready).toBe(true);
    expect(now).toBeGreaterThanOrEqual(65_000);
    expect(now).toBeLessThan(REPLACEMENT_READY_TIMEOUT_MS);
  });

  test("ends the readiness probe at its exact virtual deadline", async () => {
    let now = 0;
    const ready = await waitForReplacementReady(222, 111, 10123, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      findLive: async () => null,
    });

    expect(ready).toBe(false);
    expect(now).toBe(REPLACEMENT_READY_TIMEOUT_MS);
  });

  test("passes the absolute readiness deadline into a delayed internal probe", async () => {
    let now = 0;
    let probes = 0;
    let forwardedDeadline: number | undefined;
    const ready = await waitForReplacementReady(222, 111, 10123, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      findLive: async (probeIo) => {
        probes += 1;
        forwardedDeadline = probeIo?.deadlineAt;
        expect(probeIo?.nowFn?.()).toBe(now);
        expect(typeof probeIo?.sleepFn).toBe("function");
        now = probeIo!.deadlineAt! + 1;
        return { pid: 222, port: 10123, source: "runtime" };
      },
    });

    expect(ready).toBe(false);
    expect(probes).toBe(1);
    expect(forwardedDeadline).toBe(REPLACEMENT_READY_TIMEOUT_MS);
    expect(now).toBe(REPLACEMENT_READY_TIMEOUT_MS + 1);
  });
});

describe("POST /api/system/restart", () => {
  test("returns 202 with drain timeout and does not tear down injection", async () => {
    setSystemRestartIoForTests({
      isDraining: () => false,
      getActiveTurnCount: () => 1,
      schedule: () => {},
      setDraining: () => {},
    });
    const req = new Request("http://127.0.0.1:10100/api/system/restart", { method: "POST" });
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const body = await res!.json() as {
      success: boolean;
      activeTurnCount: number;
      drainTimeoutMs: number;
      alreadyDraining: boolean;
      message: string;
    };
    expect(body.success).toBe(true);
    expect(body.activeTurnCount).toBe(1);
    expect(body.drainTimeoutMs).toBe(60_000);
    expect(body.alreadyDraining).toBe(false);
    expect(body.message.toLowerCase()).toContain("drain");
  });

  test("rejects an invalid expected PID before scheduling restart", async () => {
    let scheduled = 0;
    setSystemRestartIoForTests({
      schedule: () => { scheduled += 1; },
    });
    const req = new Request("http://127.0.0.1:10100/api/system/restart", {
      method: "POST",
      headers: { [SYSTEM_RESTART_EXPECTED_PID_HEADER]: "not-a-pid" },
    });
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res?.status).toBe(400);
    expect(scheduled).toBe(0);
  });

  test("rejects a stale expected PID before scheduling restart", async () => {
    let scheduled = 0;
    setSystemRestartIoForTests({
      schedule: () => { scheduled += 1; },
    });
    const stalePid = process.pid === 1 ? 2 : 1;
    const req = new Request("http://127.0.0.1:10100/api/system/restart", {
      method: "POST",
      headers: { [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(stalePid) },
    });
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res?.status).toBe(409);
    expect(scheduled).toBe(0);
  });

  test("accepts a matching expected PID", async () => {
    let scheduled = 0;
    setSystemRestartIoForTests({
      isDraining: () => false,
      schedule: () => { scheduled += 1; },
      setDraining: () => {},
    });
    const req = new Request("http://127.0.0.1:10100/api/system/restart", {
      method: "POST",
      headers: { [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid) },
    });
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res?.status).toBe(202);
    expect(scheduled).toBe(1);
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

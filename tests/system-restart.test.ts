/**
 * #563 — memory-card drain-and-restart acceptance + respawn policy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { setDraining } from "../src/server/lifecycle";
import {
  MEMORY_DRAIN_RESTART_MS,
  acceptSystemRestart,
  setSystemRestartIoForTests,
} from "../src/server/management/system-restart";
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
  setDraining(false);
});

describe("acceptSystemRestart", () => {
  test("schedules a 60s drain, spawns start on the live port, marks recycle, then exits 0", async () => {
    const calls: string[] = [];
    let scheduled: (() => void | Promise<void>) | null = null;

    const result = acceptSystemRestart({
      isDraining: () => false,
      getActiveTurnCount: () => 3,
      isSupervisedServiceChild: () => false,
      listenPort: () => 10123,
      schedule: (fn) => { scheduled = fn; },
      setDraining: (value) => { calls.push(`draining:${value}`); },
      drainAndShutdown: async (_server, timeoutMs) => {
        calls.push(`drain:${timeoutMs}`);
      },
      spawnStart: (port) => { calls.push(`start:${port}`); },
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
    await scheduled!();
    expect(calls).toEqual(["draining:true", "drain:60000", "start:10123", "recycle", "exit:0"]);
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

  test("spawn async rejection exits 1 without marking recycle", async () => {
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
        throw new Error("spawn error before start");
      },
      markRecycling: () => { calls.push("recycle"); },
      exitProcess: (code) => { calls.push(`exit:${code}`); },
    });

    await scheduled!();
    expect(calls).toEqual(["drain", "start", "exit:1"]);
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
        // ensure/tray: marker set, but no installed service → unsupervised spawn path
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
});
import { ManagementRequest as Request } from "./helpers/management-auth";

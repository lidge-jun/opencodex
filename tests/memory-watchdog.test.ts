/**
 * RSS memory watchdog (#314 WP3): ring bound, rate-limited warn, idempotent
 * start, singleton accessor, and the /api/system/memory endpoint shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  getActiveMemoryWatchdog,
  observedMemoryCounter,
  startMemoryWatchdog,
  type MemorySampleBase,
} from "../src/server/memory-watchdog";
import { handleManagementAPI } from "../src/server/management-api";
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
  getActiveMemoryWatchdog()?.stop();
});

function sampleAt(at: number, rssMb: number, externalMb = 1, arrayBuffersMb = 1): MemorySampleBase {
  return {
    at,
    rss: rssMb * 1024 * 1024,
    heapUsed: 1000,
    heapTotal: 2000,
    external: externalMb * 1024 * 1024,
    arrayBuffers: arrayBuffersMb * 1024 * 1024,
  };
}

describe("startMemoryWatchdog", () => {
  test("ring never exceeds ringSize and keeps the newest samples", async () => {
    let t = 0;
    const wd = startMemoryWatchdog({
      intervalMs: 1,
      ringSize: 5,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    const snap = wd.snapshot();
    expect(snap.samples.length).toBeLessThanOrEqual(5);
    expect(snap.samples.length).toBeGreaterThan(0);
    const ats = snap.samples.map(s => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats); // newest kept, ordered
  });

  test("threshold warn fires once per rate-limit window and never below threshold", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 600), // above threshold every tick, clock ~frozen vs 30min window
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 600MB (rss)");
    expect(warns[0]).toContain("500MB");
    // No paths/hostnames in the warn line.
    expect(warns[0]).not.toContain("/Users/");
    expect(warns[0]).not.toContain("C:\\");
  });

  test("threshold warn uses external and ArrayBuffers when RSS is below threshold (#509)", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 100, 600, 300),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 600MB (external)");

    const snap = getActiveMemoryWatchdog()!.snapshot();
    expect(snap.observedMetric).toBe("external");
    expect(snap.observedBytes).toBe(600 * 1024 * 1024);

    getActiveMemoryWatchdog()?.stop();
    warns.length = 0;
    t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt((t += 1), 100, 300, 700),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("observed memory 700MB (arrayBuffers)");
  });

  test("observedMemoryCounter uses max, not a sum", () => {
    expect(observedMemoryCounter(sampleAt(1, 100, 90, 80))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "rss",
    });
    expect(observedMemoryCounter(sampleAt(1, 10, 100, 90))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "external",
    });
    expect(observedMemoryCounter(sampleAt(1, 10, 90, 100))).toEqual({
      observedBytes: 100 * 1024 * 1024,
      observedMetric: "arrayBuffers",
    });
  });

  test("below-threshold samples never warn", async () => {
    const warns: string[] = [];
    let t = 0;
    startMemoryWatchdog({
      intervalMs: 1,
      warnThresholdBytes: 500 * 1024 * 1024,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: msg => warns.push(msg),
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(warns).toEqual([]);
  });

  test("start is idempotent: the previous instance is stopped and replaced", () => {
    const first = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    const second = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    expect(getActiveMemoryWatchdog()).toBe(second);
    expect(getActiveMemoryWatchdog()).not.toBe(first);
    second.stop();
    expect(getActiveMemoryWatchdog()).toBeNull();
  });

  test("stop() of a superseded instance does not clear the active singleton", () => {
    const first = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    const second = startMemoryWatchdog({ intervalMs: 60_000, warn: () => {} });
    first.stop(); // already superseded — must not null out `second`
    expect(getActiveMemoryWatchdog()).toBe(second);
  });
});

describe("GET /api/system/memory", () => {
  test("returns runtime identity, memory scalars, gate decision, and sliced watchdog samples", async () => {
    let t = 1000;
    startMemoryWatchdog({
      intervalMs: 1,
      ringSize: 200,
      now: () => t,
      sample: () => sampleAt(++t, 100),
      warn: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
	    const body = await res!.json() as {
	      pid: number; bunVersion: string; platform: string; rss: number;
	      heapUsed: number; external: number; arrayBuffers: number; observedBytes: number; observedMetric: string;
	      jscHeap: { heapSize: number } | null;
	      responseState: { count: number; totalBytes: number; largestBytes: number; oldestAgeMs: number };
	      streamMode: string; eagerRelay: unknown;
	      watchdog: { samples: unknown[]; warnThresholdBytes: number; observedBytes: number; observedMetric: string } | null;
	    };
    expect(body.pid).toBe(process.pid);
    expect(body.bunVersion).toBe(Bun.version);
	    expect(body.rss).toBeGreaterThan(0);
	    expect(body.heapUsed).toBeGreaterThan(0);
	    expect(body.external).toBeGreaterThanOrEqual(0);
	    expect(body.arrayBuffers).toBeGreaterThanOrEqual(0);
	    expect(body.observedBytes).toBeGreaterThan(0);
	    expect(["rss", "external", "arrayBuffers"]).toContain(body.observedMetric);
	    expect(body.jscHeap?.heapSize).toBeGreaterThan(0);
    // responseState is a scalar-only continuation-store attribution block: every field is a
    // finite number (no paths, tokens, or account identifiers), so it is safe on this surface.
    expect(typeof body.responseState.count).toBe("number");
    expect(typeof body.responseState.totalBytes).toBe("number");
    expect(typeof body.responseState.largestBytes).toBe("number");
    expect(typeof body.responseState.oldestAgeMs).toBe("number");
    expect(body.responseState.count).toBeGreaterThanOrEqual(0);
    expect(body.streamMode).toBe("auto");
    // Non-win32 test runners report no gate decision; win32 reports one.
    if (process.platform === "win32") expect(body.eagerRelay).not.toBeNull();
    else expect(body.eagerRelay).toBeNull();
	    expect(body.watchdog).not.toBeNull();
	    expect(body.watchdog!.samples.length).toBeLessThanOrEqual(60);
	    expect(typeof body.watchdog!.observedBytes).toBe("number");
	    expect(["rss", "external", "arrayBuffers"]).toContain(body.watchdog!.observedMetric);
	  });

  test("watchdog null when no instance is running", async () => {
    getActiveMemoryWatchdog()?.stop();
    const req = new Request("http://127.0.0.1:10100/api/system/memory");
    const res = await handleManagementAPI(req, new URL(req.url), config());
    const body = await res!.json() as { watchdog: unknown };
    expect(body.watchdog).toBeNull();
  });
});

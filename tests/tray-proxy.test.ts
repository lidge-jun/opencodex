import { describe, expect, test } from "bun:test";
import {
  discoverStableProxyForRestart,
  isProxyReplacement,
  runProxyRestart,
  runTrayProxyStart,
  type ProxyRestartIo,
  type ProxyRestartLive,
  type TrayProxyStartIo,
} from "../src/cli/tray-proxy";

function startIo(overrides: Partial<TrayProxyStartIo> = {}) {
  const calls: string[] = [];
  const io: TrayProxyStartIo = {
    findLive: async () => null,
    diagnoseService: () => ({ installed: false, startable: false, summary: "not installed" }),
    startService: async () => { calls.push("service"); },
    startDirect: () => { calls.push("direct"); },
    waitForProxy: async () => ({ port: 10100 }),
    info: message => { calls.push(`info:${message}`); },
    error: message => { calls.push(`error:${message}`); },
    ...overrides,
  };
  return { io, calls };
}

describe("tray proxy coordinator", () => {
  test("returns immediately when a proxy is already live", async () => {
    const { io, calls } = startIo({ findLive: async () => ({ port: 20200 }) });
    expect(await runTrayProxyStart(io)).toBe(true);
    expect(calls).toEqual(["info:Proxy already running on port 20200."]);
  });

  test("restart fallback refuses a target that reappears during the final start check", async () => {
    const { io, calls } = startIo({
      findLive: async () => ({ port: 20200 }),
      existingIsSuccess: false,
    });
    expect(await runTrayProxyStart(io)).toBe(false);
    expect(calls.some(call => call.startsWith("error:Proxy appeared"))).toBe(true);
    expect(calls).not.toContain("direct");
    expect(calls).not.toContain("service");
  });

  test("refuses an installed but unviable service instead of bypassing it", async () => {
    const { io, calls } = startIo({
      diagnoseService: () => ({ installed: true, startable: false, summary: "stale" }),
    });
    expect(await runTrayProxyStart(io)).toBe(false);
    expect(calls.some(call => call.startsWith("error:Cannot start"))).toBe(true);
    expect(calls).not.toContain("direct");
    expect(calls).not.toContain("service");
  });

  test("uses a viable service and otherwise falls back to a direct start", async () => {
    const service = startIo({
      diagnoseService: () => ({ installed: true, startable: true, summary: "healthy" }),
    });
    expect(await runTrayProxyStart(service.io)).toBe(true);
    expect(service.calls).toContain("service");
    expect(service.calls).not.toContain("direct");

    const direct = startIo();
    expect(await runTrayProxyStart(direct.io)).toBe(true);
    expect(direct.calls).toContain("direct");
    expect(direct.calls).not.toContain("service");
  });

  test("fails when the selected start path never becomes healthy", async () => {
    const { io, calls } = startIo({ waitForProxy: async () => null });
    expect(await runTrayProxyStart(io)).toBe(false);
    expect(calls).toContain("direct");
    expect(calls.some(call => call.includes("did not become healthy"))).toBe(true);
  });

  test("propagates the selected start failure without trying an alternate path", async () => {
    const service = startIo({
      diagnoseService: () => ({ installed: true, startable: true, summary: "healthy" }),
      startService: async () => { service.calls.push("service"); throw new Error("service failed"); },
    });
    await expect(runTrayProxyStart(service.io)).rejects.toThrow("service failed");
    expect(service.calls).toContain("service");
    expect(service.calls).not.toContain("direct");

    const direct = startIo({
      startDirect: () => { direct.calls.push("direct"); throw new Error("spawn failed"); },
    });
    await expect(runTrayProxyStart(direct.io)).rejects.toThrow("spawn failed");
    expect(direct.calls).toContain("direct");
    expect(direct.calls).not.toContain("service");
  });

  test("restart degrades to the normal start path only when no proxy is live", async () => {
    const calls: string[] = [];
    const io: ProxyRestartIo = {
      findLive: async () => ({ status: "absent" }),
      startWhenStopped: async () => { calls.push("start"); return true; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["start"]);

    calls.length = 0;
    io.startWhenStopped = async () => { calls.push("start"); return false; };
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start" });
    expect(calls).toEqual(["start"]);

    calls.length = 0;
    io.startWhenStopped = async () => { calls.push("skip"); return "skipped"; };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "skipped" });
    expect(calls).toEqual(["skip"]);

    calls.length = 0;
    const error = new Error("spawn failed");
    io.startWhenStopped = async () => { calls.push("start"); throw error; };
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error });
    expect(calls).toEqual(["start"]);
  });

  test("a live proxy owns one in-place restart and must publish a replacement identity", async () => {
    const calls: string[] = [];
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const replacement: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async () => { calls.push("fallback-start"); return true; },
      requestInPlaceRestart: async observed => {
        calls.push(`request:${observed.pid}`);
        return { accepted: true };
      },
      waitForReplacement: async observed => {
        calls.push(`wait:${observed.pid}`);
        return replacement;
      },
    });
    expect(result).toEqual({ ok: true, mode: "restarted", live: replacement });
    expect(calls).toEqual(["request:10", "wait:10"]);
  });

  test("request uncertainty observes for a replacement and never falls back to stop/start", async () => {
    const calls: string[] = [];
    const error = new Error("response connection closed");
    const result = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: 10, port: 10100, source: "runtime" },
      }),
      startWhenStopped: async () => { calls.push("fallback-start"); return true; },
      requestInPlaceRestart: async () => {
        calls.push("request");
        return { accepted: false, uncertain: true, error };
      },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    });
    expect(result).toEqual({ ok: false, phase: "request", error });
    expect(calls).toEqual(["request", "wait"]);
  });

  test("a replacement proves success even when the request response was lost", async () => {
    const error = new Error("response connection closed");
    const replacement: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: 10, port: 10100, source: "runtime" },
      }),
      startWhenStopped: async () => true,
      requestInPlaceRestart: async () => ({ accepted: false, uncertain: true, error }),
      waitForReplacement: async () => replacement,
    });
    expect(result).toEqual({ ok: true, mode: "restarted", live: replacement });
  });

  test("a definite request rejection does not wait or start another proxy", async () => {
    const calls: string[] = [];
    const error = new Error("target changed");
    const result = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: 10, port: 10100, source: "runtime" },
      }),
      startWhenStopped: async () => { calls.push("fallback-start"); return true; },
      requestInPlaceRestart: async () => {
        calls.push("request");
        return { accepted: false, uncertain: false, error };
      },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    });
    expect(result).toEqual({ ok: false, phase: "request", error });
    expect(calls).toEqual(["request"]);
  });

  test("an accepted restart that never publishes a replacement fails closed", async () => {
    const calls: string[] = [];
    const result = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: 10, port: 10100, source: "runtime" },
      }),
      startWhenStopped: async () => { calls.push("fallback-start"); return true; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    });
    expect(result).toEqual({ ok: false, phase: "replacement" });
    expect(calls).toEqual(["request", "wait"]);
  });

  test("an unverified live target fails closed before the restart request", async () => {
    const calls: string[] = [];
    const result = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: null, port: 10100, source: "config" },
      }),
      startWhenStopped: async () => { calls.push("fallback-start"); return true; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    });
    expect(result).toEqual({ ok: false, phase: "identity" });
    expect(calls).toEqual([]);
  });

  test("replacement identity requires a new runtime PID on the same port", () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    expect(isProxyReplacement(previous, null)).toBe(false);
    expect(isProxyReplacement(previous, { pid: null, port: 10100, source: "runtime" })).toBe(false);
    expect(isProxyReplacement(previous, { pid: 10, port: 10100, source: "runtime" })).toBe(false);
    expect(isProxyReplacement(previous, { pid: 20, port: 20200, source: "runtime" })).toBe(false);
    expect(isProxyReplacement(previous, { pid: 20, port: 10100, source: "config" })).toBe(false);
    expect(isProxyReplacement(previous, { pid: 20, port: 10100, source: "runtime" })).toBe(true);
  });

  test("stable absence requires two empty observations and rejects a reappearing target", async () => {
    let calls = 0;
    const absent = await discoverStableProxyForRestart({
      findLive: async () => { calls += 1; return null; },
      waitBetweenChecks: async () => {},
    });
    expect(absent).toEqual({ status: "absent" });
    expect(calls).toBe(2);

    calls = 0;
    const appeared = await discoverStableProxyForRestart({
      findLive: async () => {
        calls += 1;
        return calls === 1 ? null : { pid: 20, port: 10100, source: "runtime" };
      },
      waitBetweenChecks: async () => {},
    });
    expect(appeared.status).toBe("uncertain");
    expect(calls).toBe(2);
  });

  test("uncertain discovery never starts, requests, or reports a false restart", async () => {
    const calls: string[] = [];
    const error = new Error("probe timed out");
    const result = await runProxyRestart({
      findLive: async () => ({ status: "uncertain", error }),
      startWhenStopped: async () => { calls.push("start"); return true; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    });
    expect(result).toEqual({ ok: false, phase: "request", error });
    expect(calls).toEqual([]);
  });

  test("thrown discovery and replacement errors keep their fail-closed phase", async () => {
    const discoveryError = new Error("discovery failed");
    const discovery = await runProxyRestart({
      findLive: async () => { throw discoveryError; },
      startWhenStopped: async () => true,
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
    });
    expect(discovery).toEqual({ ok: false, phase: "request", error: discoveryError });

    const replacementError = new Error("replacement failed");
    const replacement = await runProxyRestart({
      findLive: async () => ({
        status: "live",
        live: { pid: 10, port: 10100, source: "runtime" },
      }),
      startWhenStopped: async () => true,
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => { throw replacementError; },
    });
    expect(replacement).toEqual({ ok: false, phase: "replacement", error: replacementError });
  });
});

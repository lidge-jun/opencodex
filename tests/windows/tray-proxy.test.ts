import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  discoverStableProxyForRestart,
  isProxyReplacement,
  pollReplacementDeparture,
  reobserveRestartReplacement,
  restartStartOutcome,
  runProxyRestart,
  runTrayProxyStart,
  type ProxyRestartIo,
  type ProxyRestartLive,
  type TrayProxyStartIo,
  type ProxyRestartDiscovery,
} from "../../src/cli/tray-proxy";

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
      startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
    };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["start"]);

    calls.length = 0;
    io.startWhenStopped = async () => { calls.push("start"); return { status: "failed", launch: "never" }; };
    io.waitBetweenAttempts = async () => {};
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error: undefined });
    // A proven pre-launch refusal permits another attempt.
    expect(calls).toEqual(["start", "start", "start"]);

    calls.length = 0;
    io.startWhenStopped = async () => { calls.push("skip"); return { status: "skipped" }; };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "skipped" });
    expect(calls).toEqual(["skip"]);

    calls.length = 0;
    const error = new Error("spawn failed");
    io.startWhenStopped = async () => { calls.push("start"); throw error; };
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error });
    expect(calls).toEqual(["start"]);
  });

  test("accepted live restart recovers with autostart disabled", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const forced: boolean[] = [];
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async recoveringLiveRestart => {
        forced.push(recoveringLiveRestart);
        return recoveringLiveRestart ? { status: "started" } : { status: "skipped" };
      },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      reobserveAfterReplacement: async () => ({ status: "absent" }),
      // The recovery start is confirmed only by a different runtime PID on the original port.
      recheckAfterFailedStart: async () => ({ status: "live", live: { pid: 20, port: 10100, source: "runtime" } }),
    });
    expect(result).toEqual({ ok: true, mode: "started" });
    expect(forced).toEqual([true]);
  });

  test("a recovery start is never confirmed by the original pid reappearing", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const calls: string[] = [];
    for (const confirmation of [
      { status: "live", live: previous },
      { status: "absent" },
      { status: "live", live: { pid: 20, port: 10100, source: "config" } },
    ] as const) {
      const result = await runProxyRestart({
        findLive: async () => ({ status: "live", live: previous }),
        // The start path reports started because it found a healthy proxy: the old one.
        startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
        requestInPlaceRestart: async () => ({ accepted: true }),
        waitForReplacement: async () => null,
        reobserveAfterReplacement: async () => ({ status: "absent" }),
        recheckAfterFailedStart: async () => confirmation,
        waitBetweenAttempts: async () => {},
      });
      expect(result).toEqual({ ok: false, phase: "replacement" });
    }
    // One start per run and never a second one over the reappeared process.
    expect(calls).toEqual(["start", "start", "start"]);
  });

  test("a skipped recovery cannot report a vanished proxy as success", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async () => ({ status: "skipped" }),
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      reobserveAfterReplacement: async () => ({ status: "absent" }),
    });
    expect(result).toEqual({ ok: false, phase: "replacement" });
  });

  test("a start that fails transiently succeeds without re-running the command", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const io: ProxyRestartIo = {
      findLive: async () => ({ status: "absent" }),
      startWhenStopped: async () => {
        attempts += 1;
        calls.push(`start:${attempts}`);
        if (attempts < 3) return { status: "failed", launch: "exited", error: new Error(`transient race ${attempts}`) } as const;
        return { status: "started" } as const;
      },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => { calls.push("wait"); },
    };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["start:1", "wait", "start:2", "wait", "start:3"]);
  });

  test("an ambiguous failed launch is never retried after an absent observation", async () => {
    let launches = 0;
    const error = new Error("child has not become healthy");
    const result = await runProxyRestart({
      findLive: async () => ({ status: "absent" }),
      startWhenStopped: async () => { launches += 1; throw error; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: false, phase: "start", error });
    expect(launches).toBe(1);
  });

  test("an uncertain recheck preserves the first launch failure", async () => {
    let launches = 0;
    let observations = 0;
    const error = new Error("late child");
    const result = await runProxyRestart({
      findLive: async () => ++observations === 1 ? { status: "absent" } : { status: "uncertain" },
      startWhenStopped: async () => { launches += 1; return { status: "failed", launch: "unknown", error }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: false, phase: "start", error });
    expect(launches).toBe(1);
    expect(observations).toBe(2);
  });

  test("launch evidence distinguishes an exited child from a late child", () => {
    expect(restartStartOutcome(false, null).status).toBe("failed");
    expect(restartStartOutcome(false, { exitCode: 1, signalCode: null })).toEqual({ status: "failed", launch: "exited", error: undefined });
    expect(restartStartOutcome(false, { exitCode: null, signalCode: null })).toEqual({ status: "failed", launch: "unknown", error: undefined });
  });

  test("a launched child may be retried only after its exit is observed", async () => {
    let launches = 0;
    const result = await runProxyRestart({
      findLive: async () => ({ status: "absent" }),
      startWhenStopped: async () => ++launches === 1
        ? { status: "failed", launch: "exited", error: new Error("child exited") }
        : { status: "started" },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: true, mode: "started" });
    expect(launches).toBe(2);
  });

  test("a failed start that leaves a live proxy attests success without a second start", async () => {
    // Post-health steps may report failure on an already-serving proxy; respawning
    // would race it for the port. The re-observation tells refusal apart from that.
    const calls: string[] = [];
    const live: ProxyRestartLive = { pid: 50, port: 10100, source: "runtime" };
    let observations = 0;
    const io: ProxyRestartIo = {
      findLive: async () => {
        observations += 1;
        return observations === 1 ? { status: "absent" } : { status: "live", live };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "failed", launch: "unknown" }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    };
    expect(await runProxyRestart(io)).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["start"]);
  });

  test("a throwing start on a live proxy reports the error without starting again", async () => {
    const calls: string[] = [];
    const live: ProxyRestartLive = { pid: 50, port: 10100, source: "runtime" };
    let observations = 0;
    const thrown = new Error("post-health integration failed");
    const io: ProxyRestartIo = {
      findLive: async () => {
        observations += 1;
        return observations === 1 ? { status: "absent" } : { status: "live", live };
      },
      startWhenStopped: async () => { calls.push("start"); throw thrown; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    };
    // One attempt only: the attested proxy must not be duplicated, but its error
    // is real and must not convert to success.
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error: thrown });
    expect(calls).toEqual(["start"]);
  });

  test("a slow child stays single-launch when the first recheck misses it", async () => {
    const calls: string[] = [];
    const live: ProxyRestartLive = { pid: 60, port: 10100, source: "runtime" };
    // Absent at discovery and after the first beat; bound by the second check.
    const seen: Array<ProxyRestartDiscovery> = [
      { status: "absent" },
      { status: "absent" },
      { status: "live", live },
    ];
    const io: ProxyRestartIo = {
      findLive: async () => seen.shift() ?? { status: "absent" },
      startWhenStopped: async () => { calls.push("start"); return { status: "failed", launch: "unknown" }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    };
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error: undefined });
    expect(calls).toEqual(["start"]);
  });

  test("a config-only observation after a failed start keeps the failure", async () => {
    // A config-sourced live row is not proof a proxy serves: it must not convert
    // a failed start into a reported success.
    const calls: string[] = [];
    let observations = 0;
    const io: ProxyRestartIo = {
      findLive: async () => {
        observations += 1;
        return observations === 1
          ? { status: "absent" }
          : { status: "live", live: { pid: null, port: 10100, source: "config" } };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "failed", launch: "unknown" }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    };
    expect(await runProxyRestart(io)).toEqual({ ok: false, phase: "start", error: undefined });
    expect(calls).toEqual(["start"]);
  });

  test("a proxy that crashed mid-restart is started fresh after strong re-observation", async () => {
    const calls: string[] = [];
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let observations = 0;
    const result = await runProxyRestart({
      findLive: async () => {
        observations += 1;
        // Initial discovery sees the live target; the post-failure re-observation
        // finds nothing: the old process died without publishing a replacement.
        return observations === 1
          ? { status: "live", live: previous }
          : observations === 2
            ? { status: "absent" }
            // The recovery start's confirmation sees the fresh replacement.
            : { status: "live", live: { pid: 20, port: 10100, source: "runtime" } };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: true }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["request", "wait", "start"]);
  });

  test("an uncertain request never earns a recovery start after an absent observation", async () => {
    const calls: string[] = [];
    const error = new Error("response connection closed");
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let observations = 0;
    const result = await runProxyRestart({
      findLive: async () => {
        observations += 1;
        return observations === 1 ? { status: "live", live: previous } : { status: "absent" };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
      requestInPlaceRestart: async () => { calls.push("request"); return { accepted: false, uncertain: true, error }; },
      waitForReplacement: async () => { calls.push("wait"); return null; },
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: false, phase: "request", error });
    expect(calls).toEqual(["request", "wait"]);
  });

  test("recovery never reports success when the old pid reappears after a refused start", async () => {
    const calls: string[] = [];
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let observations = 0;
    const result = await runProxyRestart({
      findLive: async () => {
        observations += 1;
        // Discovery sees the target, the post-replacement re-observation sees nothing, and
        // after the refused recovery start the ORIGINAL pid is serving again.
        if (observations === 1) return { status: "live", live: previous };
        if (observations === 2) return { status: "absent" };
        return { status: "live", live: previous };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "failed", launch: "never" }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: false, phase: "replacement" });
    expect(calls).toEqual(["start"]);
  });

  test("a recovery recheck that finds a different pid still attests the replacement", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let observations = 0;
    const result = await runProxyRestart({
      findLive: async () => {
        observations += 1;
        if (observations === 1) return { status: "live", live: previous };
        if (observations === 2) return { status: "absent" };
        return { status: "live", live: { pid: 20, port: 10100, source: "runtime" } };
      },
      startWhenStopped: async () => ({ status: "failed", launch: "exited" }),
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: true, mode: "started" });
  });

  test("a replacement that lands past the deadline still proves success", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const late: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    let observations = 0;
    const result = await runProxyRestart({
      findLive: async () => {
        observations += 1;
        return observations === 1
          ? { status: "live", live: previous }
          : { status: "live", live: late };
      },
      startWhenStopped: async () => { throw new Error("must not start"); },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: true, mode: "restarted", live: late });
  });

  test("the same PID after a missed replacement still fails closed", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async () => { throw new Error("must not start"); },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
    });
    expect(result).toEqual({ ok: false, phase: "replacement" });
  });

  test("the re-observer receives the previous identity to judge replacements", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let seen: ProxyRestartLive | undefined;
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async () => { throw new Error("must not start"); },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
      reobserveAfterReplacement: async observed => {
        seen = observed;
        return { status: "absent" };
      },
    });
    expect(seen).toEqual(previous);
    // The recovery start threw and the recheck still sees the ORIGINAL pid: that is not a
    // replacement this command produced, so recovery fails closed as a missed replacement.
    expect(result).toEqual({ ok: false, phase: "replacement" });
  });

  test("pollReplacementDeparture attests a PID that changes inside the budget", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const late: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    const rounds: Array<ProxyRestartDiscovery> = [
      { status: "live", live: previous },
      { status: "live", live: previous },
      { status: "live", live: late },
    ];
    let waits = 0;
    const verdict = await pollReplacementDeparture(
      async () => rounds.shift() ?? { status: "absent" },
      previous,
      () => true,
      async () => { waits += 1; },
    );
    expect(verdict).toEqual({ status: "live", live: late });
    expect(waits).toBe(2);
  });

  test("pollReplacementDeparture survives uncertainty before a new runtime PID", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const late: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    let rounds = 0;
    const verdict = await pollReplacementDeparture(
      async () => ++rounds === 1 ? { status: "uncertain", error: new Error("probe raced") } : { status: "live", live: late },
      previous,
      () => true,
      async () => {},
    );
    expect(verdict).toEqual({ status: "live", live: late });
    expect(rounds).toBe(2);
  });

  test("the production reserve binding observes a replacement after uncertainty", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const next: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    let calls = 0;
    const deadlineAt = Date.now() + 5_000;
    const verdict = await reobserveRestartReplacement(previous, deadlineAt, async end => {
      expect(end).toBeLessThanOrEqual(deadlineAt);
      return ++calls === 1 ? { status: "uncertain" } : { status: "live", live: next };
    });
    expect(verdict).toEqual({ status: "live", live: next });
    expect(calls).toBe(2);
  });

  test("pollReplacementDeparture stops polling once the budget is spent", async () => {
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    let observations = 0;
    let waits = 0;
    const verdict = await pollReplacementDeparture(
      async () => {
        observations += 1;
        return { status: "live", live: previous };
      },
      previous,
      () => observations < 2,
      async () => { waits += 1; },
    );
    expect(verdict).toEqual({ status: "live", live: previous });
    // Two observations, one beat between them; the third round never starts.
    expect(observations).toBe(2);
    expect(waits).toBe(1);
  });

  test("re-observation uses a fresh window, not the expired discovery deadline", async () => {
    // Regression: the post-failure re-observation must not reuse the shared observe
    // deadline — it expired while waiting for the replacement, so it would answer
    // `uncertain` forever and crash recovery could never run.
    const calls: string[] = [];
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => {
        calls.push("findLive");
        // Initial discovery sees the live target; every later call simulates the
        // expired shared deadline.
        return calls.length === 1
          ? { status: "live", live: previous }
          : { status: "uncertain", error: new Error("restart_discovery_deadline_expired") };
      },
      startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      waitBetweenAttempts: async () => {},
      reobserveAfterReplacement: async () => { calls.push("reobserve"); return { status: "absent" }; },
      recheckAfterFailedStart: async () => ({ status: "live", live: { pid: 20, port: 10100, source: "runtime" } }),
    });
    expect(result).toEqual({ ok: true, mode: "started" });
    expect(calls).toEqual(["findLive", "reobserve", "start"]);
  });

  test("a live proxy owns one in-place restart and must publish a replacement identity", async () => {
    const calls: string[] = [];
    const previous: ProxyRestartLive = { pid: 10, port: 10100, source: "runtime" };
    const replacement: ProxyRestartLive = { pid: 20, port: 10100, source: "runtime" };
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async () => { calls.push("fallback-start"); return { status: "started" }; },
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
      startWhenStopped: async () => { calls.push("fallback-start"); return { status: "started" }; },
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
      startWhenStopped: async () => ({ status: "started" }),
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
      startWhenStopped: async () => { calls.push("fallback-start"); return { status: "started" }; },
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
      startWhenStopped: async () => { calls.push("fallback-start"); return { status: "started" }; },
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
      startWhenStopped: async () => { calls.push("fallback-start"); return { status: "started" }; },
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
      startWhenStopped: async () => { calls.push("start"); return { status: "started" }; },
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
      startWhenStopped: async () => ({ status: "started" }),
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
      startWhenStopped: async () => ({ status: "started" }),
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => { throw replacementError; },
    });
    expect(replacement).toEqual({ ok: false, phase: "replacement", error: replacementError });
  });

  test("update dot preserves base safety icon and opens dashboard", () => {
    const source = readFileSync(repoPath("src", "tray", "windows-tray.ps1"), "utf8");
    expect(source).toContain('if ($startup.status -eq "at-risk") {');
    expect(source).toContain('if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }');
    expect(source).toContain('if ($script:updateAvailable) { $onlineUpdateIcon } else { $onlineIcon }');
    expect(source).toContain('if ($script:updateAvailable) { $offlineUpdateIcon } else { $offlineIcon }');
    expect(source).toContain('$updateItem = $menu.Items.Add((Get-TrayText "Update available" "有可用更新"))');
    expect(source).toContain('$updateItem.add_Click({ Start-OcxCommand @("gui") })');
  });
});

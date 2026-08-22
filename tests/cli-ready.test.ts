/**
 * Injected tests for `ocx ready` (parseReadyArgs + runReady).
 *
 * These REPLACE the prior subprocess/network/no-proxy tests for the ready
 * command. Everything is driven over injected findLive / probe / sleep / now /
 * stdout stubs, so the suite never opens a real loopback socket, spawns a
 * subprocess, or touches the real HOME/CODEX_HOME.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_READY_WAIT_TIMEOUT_SECONDS,
  MAX_READY_WAIT_TIMEOUT_SECONDS,
  parseReadyArgs,
  runReady,
  type ReadyArgs,
  type ReadyIo,
  type ReadyLive,
  type ReadyProbe,
} from "../src/cli/ready";

// ── parseReadyArgs ────────────────────────────────────────────────────────────

describe("parseReadyArgs", () => {
  function ok(args: ReadyArgs, json: boolean, wait: boolean, timeoutSeconds: number): void {
    expect(args.json).toBe(json);
    expect(args.wait).toBe(wait);
    expect(args.timeoutSeconds).toBe(timeoutSeconds);
  }

  test("empty argv → single probe, default json/wait, default timeout", () => {
    const r = parseReadyArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) ok(r.args, false, false, DEFAULT_READY_WAIT_TIMEOUT_SECONDS);
  });

  test("--json alone", () => {
    const r = parseReadyArgs(["--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) ok(r.args, true, false, DEFAULT_READY_WAIT_TIMEOUT_SECONDS);
  });

  test("--wait alone uses default timeout", () => {
    const r = parseReadyArgs(["--wait"]);
    expect(r.ok).toBe(true);
    if (r.ok) ok(r.args, false, true, DEFAULT_READY_WAIT_TIMEOUT_SECONDS);
  });

  test("--wait --json --timeout N", () => {
    const r = parseReadyArgs(["--wait", "--json", "--timeout", "10"]);
    expect(r.ok).toBe(true);
    if (r.ok) ok(r.args, true, true, 10);
  });

  test("default timeout is 45s", () => {
    expect(DEFAULT_READY_WAIT_TIMEOUT_SECONDS).toBe(45);
  });

  test("max timeout is 300s", () => {
    expect(MAX_READY_WAIT_TIMEOUT_SECONDS).toBe(300);
  });

  test("--timeout 300 is accepted (upper bound)", () => {
    const r = parseReadyArgs(["--wait", "--timeout", "300"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.timeoutSeconds).toBe(300);
  });

  test("--timeout without --wait is a usage error (code 64)", () => {
    expect(parseReadyArgs(["--timeout", "5"])).toEqual({ ok: false, code: 64 });
  });

  test("unknown flag is a usage error", () => {
    expect(parseReadyArgs(["--nope"])).toEqual({ ok: false, code: 64 });
  });

  test("positional argument is a usage error", () => {
    expect(parseReadyArgs(["now"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout with non-numeric value is a usage error", () => {
    expect(parseReadyArgs(["--wait", "--timeout", "abc"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout with missing value is a usage error", () => {
    expect(parseReadyArgs(["--wait", "--timeout"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout zero is a usage error (must be positive)", () => {
    expect(parseReadyArgs(["--wait", "--timeout", "0"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout above 300 is a usage error (max enforced)", () => {
    expect(parseReadyArgs(["--wait", "--timeout", "301"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout negative is a usage error", () => {
    expect(parseReadyArgs(["--wait", "--timeout", "-5"])).toEqual({ ok: false, code: 64 });
  });

  test("--timeout decimal is a usage error", () => {
    expect(parseReadyArgs(["--wait", "--timeout", "1.5"])).toEqual({ ok: false, code: 64 });
  });
});

// ── runReady over injected io ─────────────────────────────────────────────────

function captureIo(): { io: ReadyIo; out: string[] } {
  const out: string[] = [];
  const io: ReadyIo = {
    stdout: { log: (s: string) => { out.push(s); } },
  };
  return { io, out };
}

const LIVE: ReadyLive = { pid: 4242, port: 10100, hostname: undefined };
const READY_PROBE: ReadyProbe = { ready: true, status: "ready", pid: 4242, port: 10100 };
const PENDING_PROBE: ReadyProbe = { ready: false, status: "pending", pid: 4242, port: 10100 };
const FAILED_PROBE: ReadyProbe = { ready: false, status: "failed", pid: 4242, port: 10100 };

describe("runReady single probe (no --wait)", () => {
  test("ready probe exits 0 and prints the ready plain line", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => LIVE, probe: async () => READY_PROBE },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("Proxy ready (PID 4242, port 10100)");
  });

  test("ready probe --json emits sanitized JSON and exits 0", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: true, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => LIVE, probe: async () => READY_PROBE },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ ready: true, status: "ready", pid: 4242, port: 10100 });
    // Sanitized: no urls/paths/errors/provider data.
    expect(JSON.stringify(parsed)).not.toContain("http");
    expect(JSON.stringify(parsed)).not.toContain("error");
  });

  test("pending probe exits 1 with the pending line", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => LIVE, probe: async () => PENDING_PROBE },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("not ready yet (pending)");
  });

  test("failed probe exits 1 with the failed line", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => LIVE, probe: async () => FAILED_PROBE },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("sync failed");
  });

  test("no live proxy exits 1 with unreachable (--json sanitized)", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: true, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => null, probe: async () => READY_PROBE },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ ready: false, status: "unreachable", pid: null, port: null });
    expect(JSON.stringify(parsed)).not.toContain("http");
    expect(JSON.stringify(parsed)).not.toContain("error");
  });

  test("foreign/invalid probe body (null) counts as unreachable, exits 1", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      { ...io, findLive: async () => LIVE, probe: async () => null },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("not reachable");
  });

  test("the probe receives expectedPid from the discovered live pid", async () => {
    const { io } = captureIo();
    const seen: Array<{ expectedPid?: number }> = [];
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async (_port, opts) => { seen.push(opts); return READY_PROBE; },
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ hostname: undefined, expectedPid: 4242 }]);
  });
});

describe("runReady --wait (single bounded loop, deterministic)", () => {
  test("transitions discovery → ready within the deadline, exits 0", async () => {
    const { io, out } = captureIo();
    let t = 0;
    let findCalls = 0;
    const probeBodies = [null, PENDING_PROBE, READY_PROBE];
    let probeCalls = 0;
    const code = await runReady(
      { json: false, wait: true, timeoutSeconds: 5 },
      {
        ...io,
        // First discovery returns null (proxy not up yet); second returns LIVE.
        findLive: async () => { findCalls++; return findCalls < 2 ? null : LIVE; },
        probe: async () => probeBodies[Math.min(probeCalls++, probeBodies.length - 1)]!,
        now: () => (t += 100), // First read is 100, so the deadline is 100 + 5000 = 5100; 100, 200, 300 … never crosses it.
        sleep: async () => {},
      },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("Proxy ready");
    expect(findCalls).toBeGreaterThanOrEqual(2);
    expect(probeCalls).toBeGreaterThanOrEqual(2);
  });

  test("times out when the proxy never appears, exits 1 (--json)", async () => {
    const { io, out } = captureIo();
    let t = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => null,
        probe: async () => READY_PROBE,
        now: () => (t += 500), // First read is 500, so the deadline is 500 + 1000 = 1500; the after-find read of 1500 ends the loop.
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ ready: false, status: "unreachable", pid: null, port: null });
  });

  test("times out when the body stays pending, exits 1 with pending", async () => {
    const { io, out } = captureIo();
    let t = 0;
    const code = await runReady(
      { json: false, wait: true, timeoutSeconds: 3 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => PENDING_PROBE,
        now: () => (t += 1000), // First read is 1000, so the deadline is 1000 + 3000 = 4000; the after-probe read of 4000 ends the loop.
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("not ready yet (pending)");
  });

  test("a proxy that reported pending and then exits reports unreachable, not stale pending", async () => {
    const { io, out } = captureIo();
    let t = 0;
    let discoveryCount = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 8 },
      {
        ...io,
        // First discovery finds the proxy (pending), then it vanishes: every
        // later discovery returns null. The cached pending status must not
        // survive to the timeout report — the honest answer is unreachable.
        findLive: async () => (++discoveryCount === 1 ? LIVE : null),
        probe: async () => PENDING_PROBE,
        // 500ms steps: first read sets the deadline, then each find/probe/sleep
        // advances past a null discovery well before the deadline so the
        // timeout report carries the cleared unreachable state.
        now: () => (t += 500),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("")) as { ready: boolean; status: string; pid: unknown; port: unknown };
    expect(parsed).toEqual({ ready: false, status: "unreachable", pid: null, port: null });
  });

  test("failed is terminal: exits 1 immediately without polling or consuming timeout", async () => {
    const { io, out } = captureIo();
    let findCalls = 0;
    let probeCalls = 0;
    let sleepCalls = 0;
    let nowCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 300 },
      {
        ...io,
        findLive: async () => { findCalls++; return LIVE; },
        probe: async () => { probeCalls++; return FAILED_PROBE; },
        now: () => { nowCalls++; return 0; },
        sleep: async () => { sleepCalls++; },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(""))).toEqual({ ready: false, status: "failed", pid: 4242, port: 10100 });
    expect(findCalls).toBe(1);
    expect(probeCalls).toBe(1);
    expect(sleepCalls).toBe(0);
    // The hard-deadline loop reads the clock at each checkpoint (init, before
    // find, after find, after probe) so timeout can still win at/after the
    // deadline; the terminal failed path then returns BEFORE any sleep/poll,
    // so the 300s timeout is never consumed waiting after a before-deadline
    // failure.
    expect(nowCalls).toBe(4);
  });

  test("never counts a foreign/invalid probe as ready, then times out", async () => {
    const { io, out } = captureIo();
    let t = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => null, // foreign / invalid contract every time
        now: () => (t += 500),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    // Foreign/invalid bodies never promote to pending; status stays unreachable.
    expect(parsed.status).toBe("unreachable");
    expect(parsed.ready).toBe(false);
  });

  test("uses the configured --timeout value as the single deadline", async () => {
    const { io } = captureIo();
    const seenNow: number[] = [];
    let t = -1000; // so the first read (which establishes the deadline) is 0
    await runReady(
      { json: false, wait: true, timeoutSeconds: 7 },
      {
        ...io,
        findLive: async () => null,
        probe: async () => READY_PROBE,
        now: () => { t += 1000; seenNow.push(t); return t; },
        sleep: async () => {},
      },
    );
    // First read is 0, so the deadline is exactly 0 + 7*1000 = 7000. The loop
    // must stop on the FIRST reading at/after it, i.e. the last value read is
    // 7000 — proving timeoutSeconds actually controls the deadline.
    expect(seenNow.at(-1)).toBe(7000);
    expect(seenNow.filter(n => n >= 7000)).toEqual([7000]);
  });
});

// ── deadline correctness: timeout wins at/after the deadline ──────────────────
// Deterministic regression for the deadline contract: a ready probe that
// resolves AT OR AFTER the deadline must NOT win — the bounded wait already
// expired, so the exit code is 1. A ready probe that resolves strictly before
// the deadline wins (code 0). The clock is a queued stub so the exact
// post-probe reading is pinned, not a side effect of real elapsed time.
describe("runReady --wait deadline correctness", () => {
  // Queue-based clock: returns values[i], then holds the last value. This lets
  // the test pin the exact reading after the awaited discovery/probe instead of
  // relying on real elapsed time.
  function seqNow(values: number[]): () => number {
    let i = 0;
    return () => {
      const v = values[Math.min(i, values.length - 1)];
      i++;
      return v;
    };
  }

  test("timeout=1000ms: a ready probe resolving at 1501ms (past deadline) → code 1", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => READY_PROBE,
        // deadline = 0 + 1000 = 1000.
        // checkpoints: init=0 → before-find=0 (starts find) → after-find=0 (<1000,
        // starts probe) → after-probe=1501 (≥ deadline, ready does NOT win).
        now: seqNow([0, 0, 0, 1501]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    // Timeout won: the ready signal is not advertised.
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ready).toBe(false);
  });

  test("timeout=1000ms: a ready probe resolving at 999ms (strictly before deadline) → code 0", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => READY_PROBE,
        // deadline = 0 + 1000 = 1000; the post-probe clock reads 999 < 1000
        // (and 999 is held for every subsequent read).
        now: seqNow([0, 999]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("Proxy ready");
  });

  test("exact deadline: a ready probe resolving AT the deadline (now === deadline) → code 1 (timeout wins)", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => READY_PROBE,
        // deadline = 0 + 1000 = 1000.
        // checkpoints: init=0 → before-find=0 → after-find=0 → after-probe=1000.
        // The contract is "reached/exceeded → timeout wins", so now === deadline
        // does NOT count as before-deadline.
        now: seqNow([0, 0, 0, 1000]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ready).toBe(false);
  });

  test("exact deadline: a failed probe resolving AT the deadline → code 1 (timeout wins over terminal failed)", async () => {
    const { io, out } = captureIo();
    let sleepCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => FAILED_PROBE,
        // deadline = 0 + 1000 = 1000.
        // checkpoints: init=0 → before-find=0 → after-find=0 → after-probe=1000.
        // Post-probe clock is checked BEFORE terminal-failed handling, so
        // now === deadline → timeout wins (code 1, sanitized last status).
        now: seqNow([0, 0, 0, 1000]),
        sleep: async () => { sleepCalls++; },
      },
    );
    expect(code).toBe(1);
    expect(sleepCalls).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ ready: false, status: "failed", pid: 4242, port: 10100 });
    expect(JSON.stringify(parsed)).not.toContain("http");
    expect(JSON.stringify(parsed)).not.toContain("error");
  });

  test("past deadline: a failed probe resolving after the deadline → code 1 (timeout wins over terminal failed)", async () => {
    const { io, out } = captureIo();
    let sleepCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => FAILED_PROBE,
        // deadline = 0 + 1000 = 1000.
        // checkpoints: init=0 → before-find=0 → after-find=0 → after-probe=1501.
        // Past-deadline failed must not take the terminal-failed shortcut.
        now: seqNow([0, 0, 0, 1501]),
        sleep: async () => { sleepCalls++; },
      },
    );
    expect(code).toBe(1);
    expect(sleepCalls).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ ready: false, status: "failed", pid: 4242, port: 10100 });
    expect(JSON.stringify(parsed)).not.toContain("http");
    expect(JSON.stringify(parsed)).not.toContain("error");
  });

  test("every sleep is capped to the positive remaining time (never past the deadline, never negative)", async () => {
    const { io } = captureIo();
    const sleeps: number[] = [];
    const code = await runReady(
      { json: false, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => PENDING_PROBE,
        // deadline = 0 + 1000 = 1000.
        // iter1: init=0 → before-find=0 → after-find=0 → after-probe=800.
        //   remaining for sleep = 1000-800 = 200 → sleep capped to 200 (not 500).
        // iter2: before-find=1600 → remaining=-600 ≤ 0 → return 1, no sleep.
        now: seqNow([0, 0, 0, 800, 1600]),
        sleep: async (ms) => { sleeps.push(ms); },
      },
    );
    expect(code).toBe(1);
    // The single sleep was capped to the remaining 200ms, never the full 500ms
    // poll interval, and never negative.
    expect(sleeps).toEqual([200]);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });

  // ── hard-deadline I/O gating (P1) ────────────────────────────────────────────
  // The deadline must gate I/O, not just sleeps. Before EVERY discovery and
  // EVERY probe the loop computes remaining = deadline - now() and refuses to
  // start that I/O when it is non-positive; after each awaited discovery/probe
  // it re-reads the clock and a reached/exceeded deadline wins (code 1). No
  // second discovery/probe may start once the deadline is reached.
  test("deadline already expired before first I/O → finds=0, probes=0, code 1", async () => {
    const { io, out } = captureIo();
    let findCalls = 0;
    let probeCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => { findCalls++; return LIVE; },
        probe: async () => { probeCalls++; return READY_PROBE; },
        // deadline = 0 + 1000 = 1000; before-find reads 1001 ≥ 1000 → no I/O.
        now: seqNow([0, 1001]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    expect(findCalls).toBe(0);
    expect(probeCalls).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ready).toBe(false);
  });

  test("first find crosses deadline → finds=1, probes=0, no second find, code 1", async () => {
    const { io, out } = captureIo();
    let findCalls = 0;
    let probeCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => { findCalls++; return LIVE; },
        probe: async () => { probeCalls++; return READY_PROBE; },
        // deadline=1000; before-find=0 (find starts, finds=1), after-find=1000
        // (≥ deadline → no probe, return 1).
        now: seqNow([0, 0, 1000]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    expect(findCalls).toBe(1);
    expect(probeCalls).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ready).toBe(false);
  });

  test("find before deadline but probe crosses it → finds=1, probes=1, no second find, code 1", async () => {
    const { io, out } = captureIo();
    let findCalls = 0;
    let probeCalls = 0;
    const code = await runReady(
      { json: true, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        findLive: async () => { findCalls++; return LIVE; },
        probe: async () => { probeCalls++; return READY_PROBE; },
        // deadline=1000; before-find=0 → after-find=0 (<1000, probe starts,
        // probes=1) → after-probe=1000 (≥ deadline, ready does NOT win, return 1).
        now: seqNow([0, 0, 0, 1000]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(1);
    expect(findCalls).toBe(1);
    expect(probeCalls).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ready).toBe(false);
  });

  test("injected remainingMs equals logical remaining time, stays positive, never exceeds it", async () => {
    const { io } = captureIo();
    const findRemaining: number[] = [];
    const probeRemaining: number[] = [];
    // deadline = 0 + 1000 = 1000; every find/probe starts while the clock reads
    // 0, so the injected remaining equals deadline-0 = 1000 exactly. The
    // after-probe reading then crosses the deadline to terminate the loop.
    await runReady(
      { json: false, wait: true, timeoutSeconds: 1 },
      {
        ...io,
        now: seqNow([0, 0, 0, 1001]),
        findLive: async (remainingMs) => { findRemaining.push(remainingMs ?? -1); return LIVE; },
        probe: async (_port, _opts, remainingMs) => { probeRemaining.push(remainingMs ?? -1); return PENDING_PROBE; },
        sleep: async () => {},
      },
    );
    // Both discovery and probe received the logical remaining = 1000ms: positive
    // and equal to deadline-now_at_call (cannot exceed the remaining budget).
    expect(findRemaining).toEqual([1000]);
    expect(probeRemaining).toEqual([1000]);
    for (const r of [...findRemaining, ...probeRemaining]) {
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(1000);
    }
  });

  test("ready strictly before deadline still exits 0 (no regression)", async () => {
    const { io, out } = captureIo();
    const code = await runReady(
      { json: false, wait: true, timeoutSeconds: 2 },
      {
        ...io,
        findLive: async () => LIVE,
        probe: async () => READY_PROBE,
        // deadline = 0 + 2000 = 2000; post-probe reads 500 < 2000 → ready wins.
        now: seqNow([0, 0, 0, 500]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("Proxy ready");
  });
});

// ── handleStart readinessGate wiring (source-level integration guard) ─────────
// A bounded source-level assertion reading ONLY src/cli/index.ts. It verifies
// that the SAME identifier `readinessGate` is (1) created in handleStart via
// createReadinessGate(), (2) passed to startServer in the retry path, and
// (3) passed to reconcileClientStartupBeforeReady before that helper gives a
// deferred gate to syncCodexOnStartIfEnabled. The successful transition is held
// until the Claude roster fence settles; this source guard complements the
// executable delayed-roster test in tests/claude-agent-startup-sync.test.ts.
describe("handleStart readinessGate wiring (source-level)", () => {
  const cliSource = readFileSync(join(import.meta.dir, "../src/cli/index.ts"), "utf8");

  test("readinessGate is created, threaded into startServer, and into the startup sync — in order", () => {
    const createMatch = cliSource.match(/const\s+readinessGate\s*=\s*createReadinessGate\(\)/);
    expect(createMatch, "handleStart must create readinessGate via createReadinessGate()").not.toBeNull();

    const startMatch = cliSource.match(/startServer\s*\(\s*port\s*,\s*\{\s*[^}]*readinessGate[^}]*\}\s*\)/);
    expect(startMatch, "startServer must be called with readinessGate among its deps in the retry path").not.toBeNull();

    const reconcileMatch = cliSource.match(
      /reconcileClientStartupBeforeReady\s*\(\s*readinessGate\s*,/,
    );
    expect(reconcileMatch, "startup reconciliation must receive the server readinessGate").not.toBeNull();

    const syncMatch = cliSource.match(
      /gate\s*=>\s*syncCodexOnStartIfEnabled\s*\(\s*port\s*,\s*config\s*,\s*undefined\s*,\s*gate\s*\)/,
    );
    expect(syncMatch, "Codex startup sync must receive the deferred reconciliation gate").not.toBeNull();

    // Source order must be: create → startServer → reconciliation → Codex sync.
    const createIdx = createMatch!.index!;
    const startIdx = startMatch!.index!;
    const reconcileIdx = reconcileMatch!.index!;
    const syncIdx = syncMatch!.index!;
    expect(createIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(reconcileIdx);
    expect(reconcileIdx).toBeLessThan(syncIdx);
  });

  test("the readinessGate identifier is the SAME symbol at all three call sites", () => {
    // Exactly one declaration of readinessGate in handleStart's scope; every
    // call site references that identifier (no shadowing, no second local).
    const declarations = cliSource.match(/\breadinessGate\s*=/g);
    expect(declarations, "readinessGate must be assigned exactly once").toHaveLength(1);
    // Three references total: one declaration + startServer + reconciliation helper.
    const references = cliSource.match(/\breadinessGate\b/g);
    expect(references?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

// ── P1: ready pre-parse before maybeAutoRestoreCodexShim (source-level) ────────
// `ocx ready` must reject invalid arguments with exit 64 BEFORE the global
// maybeAutoRestoreCodexShim preflight (or any discovery/probe/filesystem-capable
// step) runs. These source-level guards pin that ordering and the single-parse
// contract so a future edit cannot silently move parsing back into handleReady
// or after auto-restore. The head block lives in src/cli/root.ts (Phase 1 of the
// CLI deepening); the dispatch switch stays in src/cli/index.ts. No
// subprocess/network/HOME is used.
describe("ready pre-parse before maybeAutoRestoreCodexShim (source-level, P1)", () => {
  const rootSource = readFileSync(join(import.meta.dir, "../src/cli/root.ts"), "utf8");
  const cliSource = readFileSync(join(import.meta.dir, "../src/cli/index.ts"), "utf8");

  test("ready pre-parse call runs BEFORE maybeAutoRestoreCodexShim", () => {
    const preparseIdx = rootSource.indexOf("parseReadyArgs(args.slice(1))");
    expect(preparseIdx, "pre-parse must call parseReadyArgs(args.slice(1))").toBeGreaterThanOrEqual(0);
    const autoIdx = rootSource.indexOf("maybeAutoRestoreCodexShim(head.command, head.args)");
    expect(autoIdx, "maybeAutoRestoreCodexShim must be called in runCli").toBeGreaterThanOrEqual(0);
    expect(preparseIdx, "ready pre-parse must precede maybeAutoRestoreCodexShim").toBeLessThan(autoIdx);
  });

  test("invalid ready exits 64 inside the pre-parse block, before auto-restore", () => {
    // parseCliHead (pure) returns readyArgs: undefined for invalid args; the
    // fail-closed runCli guard then exits 64 before any shim/discovery side
    // effect can run.
    const autoIdx = rootSource.indexOf("maybeAutoRestoreCodexShim(head.command, head.args)");
    const beforeAuto = rootSource.slice(0, autoIdx);
    expect(beforeAuto).toContain('command === "ready"');
    expect(beforeAuto).toContain("parseReadyArgs(args.slice(1))");
    expect(beforeAuto).toContain("process.exit(64)");
  });

  test("exactly one runtime parseReadyArgs(args.slice(1)) call site across the CLI head", () => {
    const rootMatches = rootSource.match(/parseReadyArgs\(args\.slice\(1\)\)/g);
    expect(rootMatches, "parseReadyArgs(args.slice(1)) must appear exactly once in root.ts (no re-parse)").toHaveLength(1);
    expect(cliSource).not.toContain("parseReadyArgs(");
  });

  test("handleReady accepts pre-parsed ReadyArgs and never re-parses", () => {
    const sig = cliSource.match(/async\s+function\s+handleReady\s*\(\s*\w+\s*:\s*ReadyArgs\s*\)\s*:\s*Promise<number>/);
    expect(sig, "handleReady(args: ReadyArgs): Promise<number> signature must exist").not.toBeNull();
    // The handleReady body (up to the next top-level function/switch) must not
    // call parseReadyArgs and must call runReady with the passed args.
    const start = sig!.index!;
    const rest = cliSource.slice(start);
    const bodyEnd = rest.search(/\nprocess\.exit\(await dispatchCommand\(head|switch \(command\)/);
    const body = rest.slice(0, bodyEnd === -1 ? undefined : bodyEnd);
    expect(body).not.toContain("parseReadyArgs");
    expect(body).toContain("runReady");
    // The normal ready result must propagate through dispatchCommand to the
    // single top-level process.exit — handleReady must return runReady's code,
    // not call process.exit itself (CodeRabbit #1455).
    expect(body).toContain("return runReady(args)");
    expect(body).not.toContain("process.exit");
  });

  test("valid ready dispatch reaches handleReady AFTER maybeAutoRestoreCodexShim, with fail-closed guard", () => {
    // Ordering: index.ts awaits runCli (which runs parseCliHead and the shim
    // preflight inside root.ts) BEFORE dispatch.ts runs the ready runner.
    const runCliIdx = cliSource.indexOf("await runCli(process.argv.slice(2))");
    expect(runCliIdx, "index.ts must await runCli before dispatch").toBeGreaterThanOrEqual(0);
    const dispatchIdx = cliSource.indexOf("process.exit(await dispatchCommand(head");
    expect(dispatchIdx, "index.ts must exit via dispatchCommand").toBeGreaterThanOrEqual(0);
    expect(runCliIdx).toBeLessThan(dispatchIdx);
    expect(rootSource).toContain("maybeAutoRestoreCodexShim(head.command, head.args)");
    // The ready runner lives in dispatch.ts (keyed "ready:"); slice its body
    // up to the next runner key, not a fixed width.
    const dispatchSource = readFileSync(join(import.meta.dir, "../src/cli/dispatch.ts"), "utf8");
    const readyCaseIdx = dispatchSource.indexOf("ready: async");
    expect(readyCaseIdx, 'a "ready" runner must exist in dispatch.ts').toBeGreaterThanOrEqual(0);
    // The ready runner is followed by the provider runner; slice to that key.
    const nextCaseIdx = dispatchSource.indexOf("provider: async", readyCaseIdx + 1);
    const caseBody = dispatchSource.slice(readyCaseIdx, nextCaseIdx === -1 ? undefined : nextCaseIdx);
    // Passes the stashed readyArgs; fail-closed guard exits 64 with NO I/O if
    // the impossible state (missing pre-parsed args) ever occurs. Phase 4 made
    // the runner return 64; index.ts turns the returned code into process.exit.
    expect(caseBody).toContain("readyArgs");
    expect(caseBody).toContain("handleReady");
    expect(caseBody).toContain("return 64");
  });
});

// ── P1: invalid matrices never reach discovery/probe (counters) ───────────────
// parseReadyArgs is pure (no I/O), and runReady only accepts already-valid
// ReadyArgs. So an invalid matrix exits 64 in the pre-parse block and can never
// reach runReady's findLive/probe. The valid counterpart below exercises
// find/probe exactly once, confirming the ONLY path to discovery/probe is
// valid-args → runReady. No subprocess/network/HOME.
describe("invalid ready matrices never invoke findLive/probe (P1 counters)", () => {
  const invalidMatrices: string[][] = [
    ["--timeout", "5"],
    ["--nope"],
    ["now"],
    ["--wait", "--timeout", "abc"],
    ["--wait", "--timeout"],
    ["--wait", "--timeout", "0"],
    ["--wait", "--timeout", "301"],
    ["--wait", "--timeout", "-5"],
    ["--wait", "--timeout", "1.5"],
  ];

  test("every invalid matrix returns exit code 64 (pure parser, no I/O)", () => {
    for (const argv of invalidMatrices) {
      expect(parseReadyArgs(argv)).toEqual({ ok: false, code: 64 });
    }
  });

  test("valid counterpart reaches runReady and calls find/probe exactly once (single probe)", async () => {
    let findCalls = 0;
    let probeCalls = 0;
    const code = await runReady(
      { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
      {
        stdout: { log: () => {} },
        findLive: async () => { findCalls++; return LIVE; },
        probe: async () => { probeCalls++; return READY_PROBE; },
      },
    );
    expect(code).toBe(0);
    expect(findCalls).toBe(1);
    expect(probeCalls).toBe(1);
  });
});

// ── production findLiveProxy deadline wiring (source-level) ───────────────────
// The production default find must forward an ABSOLUTE deadline (real wall
// clock + remaining budget) into findLiveProxy in the --wait path, so the
// sequential candidate probes inside findLiveProxy are bounded by the single
// wait deadline. It must NOT use the injected logical now: AbortSignal time is
// real wall-clock time, so Date.now is authoritative for the network deadline.
// The non-wait path keeps findLiveProxy's built-in default (no deadlineAt).
describe("runReady production findLiveProxy deadline wiring (source-level)", () => {
  const readySource = readFileSync(join(import.meta.dir, "../src/cli/ready.ts"), "utf8");

  test("the --wait path derives deadlineAt from Date.now() + remainingMs (not the injected now)", () => {
    // Date.now (real wall clock) is authoritative for the AbortSignal deadline;
    // the injected logical now must not govern the network timeout.
    expect(readySource).toContain("deadlineAt: Date.now() + remainingMs");
    // The shared per-probe cap is forwarded alongside the absolute deadline.
    expect(readySource).toContain("timeoutMs: DEFAULT_PROBE_TIMEOUT_MS");
  });

  test("the non-wait path keeps findLiveProxy's built-in default (no deadlineAt)", () => {
    // The default find forwards only verifyPidFn: () => null when remainingMs is
    // undefined so the built-in per-probe timeout (no deadline) is preserved for
    // the single probe and no OS pid verification runs outside a deadline.
    // Whitespace-tolerant so the assertion survives reformatting of the ternary.
    expect(readySource).toMatch(/remainingMs === undefined\s*\?\s*\{ verifyPidFn: \(\) => null \}/);
    // deadlineAt is only ever passed conditionally (in the wait branch), never
    // as an unconditional findLiveProxy({ deadlineAt: ... }).
    expect(readySource).not.toContain("findLiveProxy({ deadlineAt");
  });

  test("readiness discovery never runs killable-pid OS verification (deadline-bounded, non-destructive)", () => {
    // verifyPidIdentity spawns WMIC/PowerShell (up to seconds on Windows) and is
    // only needed for kill targets. Readiness must not run it: the check would
    // be unbounded by the wait deadline.
    expect(readySource).toContain("verifyPidFn: () => null");
  });
});

// ── handleStart service-wrapper exit guard (source-level) ─────────────────────
// #764 follow-up: in OCX_SERVICE context a healthy proxy from ANY source must
// end handleStart with exit 0, so the opencodex-service.cmd `:loop` wrapper
// (retry on non-zero) does not respawn every 5s against a listener it can never
// claim. Source-level pin so a future edit cannot drop the guard silently.
describe("handleStart OCX_SERVICE exit guard (source-level)", () => {
  const cliSource = readFileSync(join(import.meta.dir, "../src/cli/index.ts"), "utf8");

  test("an already-live proxy exits 0 in OCX_SERVICE context", () => {
    expect(cliSource).toMatch(/process\.env\.OCX_SERVICE === "1"/);
    expect(cliSource).toMatch(/process\.exit\(0\)/);
    const guard = cliSource.match(/if\s*\(process\.env\.OCX_SERVICE === "1"\)\s*\{[\s\S]{0,400}?process\.exit\(0\)/);
    expect(guard, "OCX_SERVICE guard must exit 0 when the port is already served").not.toBeNull();
    const nonService = cliSource.match(/Proxy already running[\s\S]{0,200}?process\.exit\(1\)/);
    expect(nonService, "non-service path keeps the exit 1 conflict error").not.toBeNull();
  });

  test("service.ts teardown kills surviving wrapper processes on stop", () => {
    const serviceSource = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");
    expect(serviceSource).toMatch(/killWindowsServiceWrapperProcesses/);
    const callSite = serviceSource.match(/stopServiceIfInstalled[\s\S]{0,1200}?killWindowsServiceWrapperProcesses\(\)/);
    expect(callSite, "wrapper kill must run during stopServiceIfInstalled").not.toBeNull();
  });

  test("wrapper kill matches the canonical paths of THIS installation, not bare filenames", () => {
    // Review follow-up: matching by bare filename would force-terminate a
    // wrapper from another OpenCodex home (or any process whose command line
    // merely contains the name). The kill must target the exact canonical
    // paths windowsServiceScriptPath()/windowsLauncherVbsPath() produce.
    const serviceSource = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");
    expect(serviceSource).toMatch(/windowsServiceScriptPath\(\)/);
    expect(serviceSource).toMatch(/windowsLauncherVbsPath\(\)/);
    const killBody = serviceSource.match(/function killWindowsServiceWrapperProcesses\(\)[\s\S]*?\n}/);
    expect(killBody, "killWindowsServiceWrapperProcesses body must exist").not.toBeNull();
    expect(killBody![0]).toContain("windowsServiceScriptPath()");
    expect(killBody![0]).toContain("windowsLauncherVbsPath()");
    // Bare wrapper filenames must NOT be the match target.
    expect(killBody![0]).not.toMatch(/\$pats = @\('opencodex-service\.cmd'\)/);
  });

  test("wrapper kill requires the canonical path as a complete command-line token", () => {
    // Review follow-up: a substring match could force-terminate an unrelated
    // process whose command line merely contains the canonical path. The
    // PowerShell filter must check token boundaries (whitespace/quote before
    // and after the path), not a bare IndexOf.
    //
    // The script itself now lives in lib/windows-service-wrappers, shared with
    // the update job so the two teardown paths cannot drift apart again, so the
    // token-boundary rule is asserted where it is implemented.
    const sharedSource = readFileSync(
      join(import.meta.dir, "../src/lib/windows-service-wrappers.ts"),
      "utf8",
    );
    const killScript = sharedSource.match(/export function windowsWrapperKillScript\([\s\S]*?\n}/);
    expect(killScript, "windowsWrapperKillScript body must exist").not.toBeNull();
    expect(killScript![0]).not.toMatch(/IndexOf\(\$p, \[System\.StringComparison\]::OrdinalIgnoreCase\) -ge 0/);
    expect(killScript![0]).toMatch(/Substring\(/);
    expect(killScript![0]).toMatch(/before/);
    expect(killScript![0]).toMatch(/after/);
  });
});

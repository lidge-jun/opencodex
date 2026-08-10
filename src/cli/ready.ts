/**
 * `ocx ready` — pure parser + dependency-injected runner.
 *
 * Lives outside cli/index.ts (which dispatches argv at module top level) so the
 * full behavior is unit-testable without spawning a subprocess, opening a
 * loopback socket, or touching the real HOME/CODEX_HOME. The runner returns an
 * exit code; cli/index.ts only calls it and exits with the returned code.
 *
 * Contract (per P1 review):
 *  - Single wait loop. `--wait` waits for proxy discovery AND readiness within
 *    one bounded deadline (default 45s, max 300s). Without `--wait` a single
 *    identity-checked probe runs.
 *  - Invalid arguments return exit code 64 BEFORE any discovery/network work.
 *  - Output is sanitized: only the fixed `ready|pending|failed|unreachable`
 *    vocabulary, plus pid/port; never carries sync message, warning, path,
 *    provider, account, or error data.
 */
import { DEFAULT_PROBE_TIMEOUT_MS, findLiveProxy, probeReadiness } from "../server/proxy-liveness";

/** Default --wait deadline (45s). */
export const DEFAULT_READY_WAIT_TIMEOUT_SECONDS = 45;
/** Maximum allowed --wait deadline (300s). */
export const MAX_READY_WAIT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 500;
/**
 * Cap a remaining deadline budget to a positive per-call IO timeout. Stays
 * positive (>= 1ms) and never exceeds the logical remaining time nor the
 * shared per-call ceiling (DEFAULT_PROBE_TIMEOUT_MS). Passed by the production
 * defaults to findLiveProxy's / probeReadiness's timeoutMs so their fetch waits
 * are bounded by the deadline.
 */
function capIoTimeout(remainingMs: number): number {
  return Math.max(1, Math.min(remainingMs, DEFAULT_PROBE_TIMEOUT_MS));
}

/** Fixed sanitized CLI status vocabulary. */
export type CliReadinessStatus = "ready" | "pending" | "failed" | "unreachable";

export interface ReadyArgs {
  json: boolean;
  wait: boolean;
  timeoutSeconds: number;
}

export type ReadyParseResult =
  | { ok: true; args: ReadyArgs }
  | { ok: false; code: 64 };

/**
 * Pure argument parser. Accepts `--json`, `--wait`, and
 * `--wait --timeout <seconds>` (positive integer 1..300). Any unknown flag,
 * positional argument, missing/invalid --timeout value, or `--timeout` without
 * `--wait` is a usage error that must surface exit code 64.
 */
export function parseReadyArgs(argv: string[]): ReadyParseResult {
  let json = false;
  let wait = false;
  let timeoutSeconds: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--wait") {
      wait = true;
      continue;
    }
    if (flag === "--timeout") {
      const raw = argv[i + 1];
      // Positive finite integer seconds only; /^[0-9]+$/ rejects negatives, decimals, hex, and "".
      if (raw === undefined || !/^[0-9]+$/.test(raw)) return { ok: false, code: 64 };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_READY_WAIT_TIMEOUT_SECONDS) return { ok: false, code: 64 };
      timeoutSeconds = n;
      i++;
      continue;
    }
    // Any unknown flag or positional argument is a usage error.
    return { ok: false, code: 64 };
  }
  // --timeout only applies to --wait; pairing it with a single probe is a usage error.
  if (timeoutSeconds !== undefined && !wait) return { ok: false, code: 64 };
  return {
    ok: true,
    args: {
      json,
      wait,
      timeoutSeconds: timeoutSeconds ?? DEFAULT_READY_WAIT_TIMEOUT_SECONDS,
    },
  };
}

export interface ReadyLive {
  pid: number | null;
  port: number;
  hostname?: string;
}

export interface ReadyProbe {
  ready: boolean;
  status: "ready" | "pending" | "failed" | null;
  pid: number | null;
  port: number | null;
}

export interface ReadyIo {
  /**
   * Injected proxy discovery (defaults to the identity-checked findLiveProxy).
   * Receives the positive remaining deadline budget (ms) in the --wait path so
   * the production default can bound its fetch by the single deadline; receives
   * `undefined` in the non-wait path so the default keeps its built-in timeout.
   */
  findLive?: (remainingMs: number | undefined) => Promise<ReadyLive | null>;
  /**
   * Injected readiness probe (defaults to the strict probeReadiness). The third
   * argument is the positive remaining deadline budget (ms) in the --wait path,
   * and `undefined` in the non-wait path (default probe timeout preserved).
   */
  probe?: (
    port: number,
    opts: { hostname?: string; expectedPid?: number },
    remainingMs: number | undefined,
  ) => Promise<ReadyProbe | null>;
  /** Injected sleep so tests can poll without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock so the deadline is deterministic without real time. */
  now?: () => number;
  /** Injected stdout (only `.log` is used). */
  stdout?: { log: (s: string) => void };
}

function sanitizeProbeStatus(status: ReadyProbe["status"]): Exclude<CliReadinessStatus, "ready"> {
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "unreachable";
}

function report(
  args: ReadyArgs,
  ready: boolean,
  status: CliReadinessStatus,
  pid: number | null,
  port: number | null,
  stdout: { log: (s: string) => void },
): void {
  if (args.json) {
    stdout.log(JSON.stringify({ ready, status, pid, port }));
    return;
  }
  switch (status) {
    case "ready":
      stdout.log(`Proxy ready (PID ${pid ?? "?"}, port ${port ?? "?"})`);
      return;
    case "pending":
      stdout.log("Proxy running but not ready yet (pending).");
      return;
    case "failed":
      stdout.log("Proxy running but not ready (sync failed).");
      return;
    case "unreachable":
      stdout.log("Proxy not reachable or readiness unavailable.");
      return;
  }
}

/**
 * Run `ocx ready` over injected I/O. Returns the exit code (0 only when ready,
 * 1 for not-ready/timeout, 64 for usage errors — though usage errors are
 * normally caught by parseReadyArgs before this runs). The runner performs NO
 * real subprocess/network work when the io injections are supplied.
 */
export async function runReady(args: ReadyArgs, io: ReadyIo = {}): Promise<number> {
  const find = io.findLive ?? (async (remainingMs: number | undefined) => {
    // In the --wait path, forward an ABSOLUTE deadline derived from the real
    // wall clock (Date.now, NOT the injected logical now) plus the remaining
    // budget: the per-probe AbortSignal timeout is real wall-clock time, so the
    // injected test clock must not govern the network deadline. findLiveProxy's
    // deadlineAt budget recomputes remaining before each candidate probe and
    // bounds each fetch by it (plus the per-probe cap below). Non-wait path
    // keeps the built-in default.
    // verifyPidFn is disabled: readiness is non-destructive, so the killable-pid
    // OS command-line verification (WMIC/PowerShell, seconds on Windows) would
    // run OUTSIDE the deadline budget for no readiness value. The /healthz
    // identity marker and the strict /readyz contract validation remain.
    const live = await findLiveProxy(
      remainingMs === undefined
        ? { verifyPidFn: () => null }
        : { deadlineAt: Date.now() + remainingMs, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, verifyPidFn: () => null },
    );
    return live ? { pid: live.pid, port: live.port, hostname: live.hostname } : null;
  });
  const probe = io.probe ?? (async (port, opts, remainingMs) =>
    probeReadiness(port, opts, remainingMs === undefined ? {} : { timeoutMs: capIoTimeout(remainingMs) }));
  const sleep = io.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;
  const stdout = io.stdout ?? console;

  if (!args.wait) {
    // Default: exactly one identity-checked readiness probe. No wait deadline —
    // bounded only by the probe's own default timeout (remainingMs=undefined so
    // the production defaults keep their built-in 750ms ceiling; no semantic
    // regression vs. the single-probe behavior).
    const live = await find(undefined);
    if (!live) {
      report(args, false, "unreachable", null, null, stdout);
      return 1;
    }
    const p = await probe(live.port, { hostname: live.hostname, expectedPid: live.pid ?? undefined }, undefined);
    if (p?.ready) {
      report(args, true, "ready", p.pid, live.port, stdout);
      return 0;
    }
    const status: CliReadinessStatus = sanitizeProbeStatus(p?.status ?? null);
    report(args, false, status, p?.pid ?? live.pid ?? null, live.port, stdout);
    return 1;
  }

  // --wait: ONE loop bounded by a single deadline (default 45s, max 300s). The
  // deadline is the single source of truth:
  //  - Before EVERY discovery and EVERY probe we compute remaining = deadline -
  //    now(); if it is non-positive we return code 1 WITHOUT starting that I/O.
  //  - After each awaited discovery/probe we re-read the clock; reached/exceeded
  //    means timeout wins (code 1), so a ready probe resolving at/after the
  //    deadline does NOT promote to ready.
  //  - No second discovery/probe may start once the deadline is reached.
  //  - Each sleep is capped to the positive remaining time. The remaining
  //    budget is also forwarded to the production discovery/probe defaults so
  //    their individual fetch waits are bounded by this same deadline.
  const deadline = now() + args.timeoutSeconds * 1000;
  let lastStatus: CliReadinessStatus = "unreachable";
  let lastPid: number | null = null;
  let lastPort: number | null = null;
  for (;;) {
    // Before discovery: refuse to start I/O when the deadline has elapsed.
    const remainingBeforeFind = deadline - now();
    if (remainingBeforeFind <= 0) {
      report(args, false, lastStatus, lastPid, lastPort, stdout);
      return 1;
    }
    const live = await find(remainingBeforeFind);
    // After discovery: re-read the clock. Reached/exceeded → timeout wins and
    // no probe is started (no second discovery/probe after the deadline).
    let clock = now();
    if (clock >= deadline) {
      report(args, false, lastStatus, lastPid, lastPort, stdout);
      return 1;
    }
    if (live) {
      lastPort = live.port;
      // Before probe: remaining derived from the post-discovery reading
      // (guaranteed positive because clock < deadline above). This bounds the
      // probe's fetch wait by the single deadline.
      const remainingBeforeProbe = deadline - clock;
      const p = await probe(
        live.port,
        { hostname: live.hostname, expectedPid: live.pid ?? undefined },
        remainingBeforeProbe,
      );
      lastStatus = sanitizeProbeStatus(p?.status ?? null);
      lastPid = p?.pid ?? live.pid ?? null;
      // After every awaited probe: re-read the clock BEFORE terminal-failed or
      // ready handling. Reached/exceeded → timeout wins (code 1) with the last
      // sanitized status — a failed/ready probe resolving at/after the deadline
      // must not take the terminal-failed shortcut or promote to ready.
      clock = now();
      if (clock >= deadline) {
        report(args, false, lastStatus, lastPid, live.port, stdout);
        return 1;
      }
      // `failed` is terminal only while still before the deadline: the startup
      // sync has settled unsuccessfully, so waiting cannot change this gate.
      // Report it immediately instead of consuming the rest of the timeout.
      if (p?.status === "failed") {
        report(args, false, "failed", lastPid, live.port, stdout);
        return 1;
      }
      if (p?.ready) {
        report(args, true, "ready", p.pid, live.port, stdout);
        return 0;
      }
    } else {
      // Discovery stopped finding the proxy: it may have exited since the last
      // probe. Clear the cached status/identity so a stale `pending` (or its
      // pid/port) cannot mislead a supervisor at timeout — the honest answer is
      // `unreachable` with no identity.
      lastStatus = "unreachable";
      lastPid = null;
      lastPort = null;
    }
    // Cap the sleep to the positive remaining time so we never sleep past the
    // deadline. `clock` is the latest reading (post-discovery when no live
    // proxy was found, post-probe otherwise) and is known to be < deadline.
    const remainingForSleep = deadline - clock;
    if (remainingForSleep <= 0) {
      report(args, false, lastStatus, lastPid, lastPort, stdout);
      return 1;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remainingForSleep));
  }
}

/**
 * Memory watchdog: observe + warn by default, opt-in graceful restart.
 *
 * WHY: the Bun/mimalloc native allocator can retain committed memory the JS heap already released
 * (field: private/committed ~79 GB, working set ~5.8 GB, box frozen at the system commit limit;
 * mirrored by Claude Code #36132). No in-app JS cache cap fixes native retention — the only proven
 * mitigation is to notice the pressure and, optionally, hand off to the already-tested graceful
 * restart path. This module NEVER decides thresholds in absolute GB: every trigger is a fraction of
 * total system RAM, so one code path behaves the same on a 16 GB laptop and a 128 GB worker.
 *
 * DRIVER SHAPE (async collect, sync decide): a self-rescheduling probe loop captures snapshots
 * asynchronously (the Windows probe is a child process — never a synchronous event-loop block) and
 * each completed probe triggers exactly one evaluation. The first probe fires immediately at
 * start; a generation guard drops late probe results after stop/replace.
 *
 * SAFETY MODEL:
 *   - Default action is WARN ONLY. It cannot lose data or kill the process.
 *   - SYSTEM-COMMIT axis is observe-only (v1): crossing the high-water logs one latched warning
 *     and never arms a restart — the commit pressure may come from another process, and
 *     restarting OpenCodex would not free it. Auto-restart integration waits for field
 *     measurement (see docs).
 *   - Auto-restart is opt-in (config.memoryWatchdog.autoRestart / env). When it fires it reuses
 *     drainAndShutdown() — which drains in-flight turns and flushes the response-state snapshot —
 *     then exits with a distinct code so a supervisor can respawn.
 *   - Quiet-window restart: the drain budget for a memory-driven restart is restartGraceMs (default
 *     30s), much longer than a generic shutdown. Because drainAndShutdown rejects new turns and exits
 *     the instant the in-flight set empties, the restart normally lands on a natural idle gap — so a
 *     running turn is only cut when it outlives the whole grace window (bounded so the restart always
 *     fires). A mid-stream turn that is still cut is regenerated on retry (context is preserved via
 *     the flushed previous_response_id snapshot); the provider generation itself cannot be resumed.
 *   - Restart-loop guards, honestly scoped: a cooldown (minRestartIntervalMs, normalized to at
 *     least restartGraceMs) and a max-restart cap limit repeated restart REQUESTS. Both counters
 *     live in process memory, and a fired restart ends the process — so on their own they cannot
 *     bind across the process boundary. A small best-effort history file (timestamps only, see
 *     memory-restart-history.ts) re-seeds them in the respawned process; when that file cannot be
 *     read or written, cross-boundary protection falls back to the SUPERVISOR's own restart
 *     limit/backoff policy, which operators should configure regardless. maxRestarts is therefore
 *     a rolling-window rate limit (RESTART_HISTORY_WINDOW_MS), not a permanent all-time cap.
 *   - Exit code 75 (EX_TEMPFAIL) is a REQUEST to the supervisor to respawn — nothing more. A
 *     supervisor that treats it as a normal exit will simply leave the proxy stopped.
 *   - The decision core (evaluate) is pure and injectable (clock + reader + restart hook) so the
 *     logic is unit-tested without real timers or a real process exit.
 */

import { captureMemorySnapshot, type MemorySnapshot } from "../lib/memory-usage";
import { responseStateMetrics, type ResponseStateMetrics } from "../responses/state";
import { drainAndShutdown } from "./lifecycle";
import { loadMemoryRestartHistory, recordMemoryRestart } from "./memory-restart-history";
import type { OcxConfig } from "../types";

/** Exit code used for an intentional memory-driven restart (distinct from crash/normal exit). */
export const MEMORY_RESTART_EXIT_CODE = 75; // EX_TEMPFAIL: "transient, retry" — a supervisor should respawn.

/**
 * Hard bounds for the quiet-window drain budget. The floor keeps a "grace" meaningful (below 1s
 * it is an immediate abort); the ceiling bounds how long a restart may hold the proxy in the
 * draining state (new requests 503) when a stuck turn never finishes — 10 minutes, matching the
 * default cooldown so the default config stays self-consistent even at the extreme.
 */
export const RESTART_GRACE_MIN_MS = 1_000;
export const RESTART_GRACE_MAX_MS = 600_000;

const MiB = 1024 * 1024;

export interface ResolvedWatchdogConfig {
  enabled: boolean;
  intervalMs: number;
  warnFraction: number;
  criticalFraction: number;
  autoRestart: boolean;
  /** When true, auto-restart only fires if a supervisor is detected (so we never exit into "just dead"). */
  requireSupervisor: boolean;
  minRestartIntervalMs: number;
  maxRestarts: number;
  /** Drain budget (ms) for a memory-driven restart: wait up to this long for in-flight turns to
   * finish before aborting, so the restart lands on a natural idle gap (quiet-window). */
  restartGraceMs: number;
  /**
   * System-commit high-water fraction for the OBSERVE-ONLY warning axis (v1). Crossing it logs a
   * separate warning; it NEVER arms a restart — the cause may be another process, so restarting
   * OpenCodex would not help. Internal default 0.90; env-only override
   * (OCX_MEMORY_WATCHDOG_COMMIT_HIGH_WATER, experimental — for field measurement, not the UI).
   */
  systemCommitHighWater: number;
  growthWindowMs: number;
}

const DEFAULTS: ResolvedWatchdogConfig = {
  enabled: true,
  intervalMs: 60_000,
  warnFraction: 0.60,
  criticalFraction: 0.75,
  autoRestart: false,
  requireSupervisor: true,
  minRestartIntervalMs: 600_000, // 10 min
  maxRestarts: 3,
  restartGraceMs: 30_000, // quiet-window: wait up to 30s for in-flight turns before aborting
  systemCommitHighWater: 0.90, // conservative: a healthy system sits well below (field baseline ~0.2-0.7)
  growthWindowMs: 600_000, // 10 min growth-rate window (diagnostic)
};

/** Parse a boolean-ish string; undefined when unset/unrecognized. */
function parseFlagValue(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function envFlag(name: string): boolean | undefined {
  return parseFlagValue(process.env[name]);
}

function envNum(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function clampFraction(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.10, value));
}

/** Positive finite number, else fallback — config-file values bypass envNum's guard. */
function posNumOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Positive finite duration clamped into [min, max]; anything else falls back. */
function clampMs(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * cooldown >= grace: a shorter cooldown could let the watchdog arm a second restart while the
 * first drain is still inside its grace window. defaultRestart also stops the sampling timer, so
 * for the default path this is belt-and-braces — but injected restart hooks (tests, embedders)
 * rely on it. Normalization (raise the cooldown) mirrors the warn/critical nudge and is the safe
 * direction: it never extends the 503 drain window, only spaces restarts further apart.
 */
function normalizeRestartTiming(cfg: ResolvedWatchdogConfig): ResolvedWatchdogConfig {
  if (cfg.minRestartIntervalMs < cfg.restartGraceMs) cfg.minRestartIntervalMs = cfg.restartGraceMs;
  return cfg;
}

/**
 * Resolve config → runtime knobs. Precedence: env override > config file > default. Fractions are
 * clamped to [0.10, 0.99]; a criticalFraction <= warnFraction is nudged above warn so the two
 * levels never collapse. Durations are validated the same way on every entry path (env, config
 * file, management API): non-finite/non-positive values fall back, restartGraceMs is clamped into
 * [RESTART_GRACE_MIN_MS, RESTART_GRACE_MAX_MS], and the cooldown is raised to at least the grace.
 */
export function resolveWatchdogConfig(config: OcxConfig): ResolvedWatchdogConfig {
  const c = config.memoryWatchdog ?? {};
  const enabled = envFlag("OCX_MEMORY_WATCHDOG_DISABLED") === true
    ? false
    : (envFlag("OCX_MEMORY_WATCHDOG_ENABLED") ?? c.enabled ?? DEFAULTS.enabled);

  const warnFraction = clampFraction(
    envNum("OCX_MEMORY_WATCHDOG_WARN_FRACTION") ?? c.warnFraction,
    DEFAULTS.warnFraction,
  );
  let criticalFraction = clampFraction(
    envNum("OCX_MEMORY_WATCHDOG_CRITICAL_FRACTION") ?? c.criticalFraction,
    DEFAULTS.criticalFraction,
  );
  if (criticalFraction <= warnFraction) criticalFraction = Math.min(0.99, warnFraction + 0.10);

  const maxRestartsRaw = envNum("OCX_MEMORY_WATCHDOG_MAX_RESTARTS") ?? c.maxRestarts;
  return normalizeRestartTiming({
    enabled,
    // Sub-second sampling is pure CPU churn for a signal that moves over minutes — floor at 1s.
    intervalMs: Math.max(1_000, posNumOr(envNum("OCX_MEMORY_WATCHDOG_INTERVAL_MS") ?? c.intervalMs, DEFAULTS.intervalMs)),
    warnFraction,
    criticalFraction,
    autoRestart: envFlag("OCX_MEMORY_WATCHDOG_AUTO_RESTART") ?? c.autoRestart ?? DEFAULTS.autoRestart,
    requireSupervisor:
      envFlag("OCX_MEMORY_WATCHDOG_REQUIRE_SUPERVISOR") ?? c.requireSupervisor ?? DEFAULTS.requireSupervisor,
    minRestartIntervalMs:
      posNumOr(envNum("OCX_MEMORY_WATCHDOG_MIN_RESTART_INTERVAL_MS") ?? c.minRestartIntervalMs, DEFAULTS.minRestartIntervalMs),
    // 0 is meaningful ("never auto-restart"), so only reject negatives/non-finite here.
    maxRestarts: maxRestartsRaw !== undefined && Number.isFinite(maxRestartsRaw) && maxRestartsRaw >= 0
      ? Math.floor(maxRestartsRaw)
      : DEFAULTS.maxRestarts,
    restartGraceMs: clampMs(
      envNum("OCX_MEMORY_WATCHDOG_RESTART_GRACE_MS") ?? c.restartGraceMs,
      RESTART_GRACE_MIN_MS, RESTART_GRACE_MAX_MS, DEFAULTS.restartGraceMs,
    ),
    // Env-only (experimental): no config-file/UI knob until the axis is validated by field
    // measurement — a persisted setting for an unproven threshold would just be dead config.
    systemCommitHighWater: (() => {
      const raw = envNum("OCX_MEMORY_WATCHDOG_COMMIT_HIGH_WATER");
      if (raw === undefined) return DEFAULTS.systemCommitHighWater;
      return Math.min(0.99, Math.max(0.50, raw));
    })(),
    growthWindowMs: DEFAULTS.growthWindowMs,
  });
}

// ---------------------------------------------------------------------------
// Supervisor detection
// ---------------------------------------------------------------------------

/**
 * Best-effort detection of an external process supervisor that will respawn us after an intentional
 * exit. Pure over an env map so it is unit-testable. Heuristics: explicit OCX_SUPERVISED flag, pm2
 * (pm_id / PM2_HOME), systemd (INVOCATION_ID / NOTIFY_SOCKET). When nothing matches we assume NO
 * supervisor — the safe default, because exiting without a respawner is worse than staying up.
 */
export function detectSupervisor(
  env: Record<string, string | undefined> = process.env,
): { supervised: boolean; hint: string } {
  const explicit = parseFlagValue(env.OCX_SUPERVISED);
  if (explicit === true) return { supervised: true, hint: "OCX_SUPERVISED" };
  if (env.pm_id !== undefined || (env.PM2_HOME ?? "") !== "") return { supervised: true, hint: "pm2" };
  if ((env.INVOCATION_ID ?? "") !== "" || (env.NOTIFY_SOCKET ?? "") !== "") return { supervised: true, hint: "systemd" };
  if (explicit === false) return { supervised: false, hint: "OCX_SUPERVISED=off" };
  return { supervised: false, hint: "none" };
}

// ---------------------------------------------------------------------------
// Pure decision core
// ---------------------------------------------------------------------------

export type WatchdogLevel = "ok" | "warn" | "critical";
export type WatchdogAction = "none" | "warn" | "restart";

export interface WatchdogState {
  samples: { t: number; bytes: number; fraction: number }[];
  /** Highest level already reported since the last drop back to ok — prevents per-interval log spam. */
  reportedLevel: WatchdogLevel;
  /**
   * Latch for the observe-only system-commit warning: set on the first high-water crossing,
   * re-armed only when a MEASURED fraction drops back below the high-water. A probe that merely
   * fails to measure (systemCommitAvailable=false) holds the latch — measurement loss is not
   * recovery, and a flapping probe must not re-warn every time it comes back.
   */
  commitReported: boolean;
  restartCount: number;
  lastRestartAt: number;
}

export interface WatchdogDecision {
  level: WatchdogLevel;
  action: WatchdogAction;
  fraction: number;
  pressureMb: number;
  totalMb: number;
  source: string;
  growthMbPerHour: number | null;
  reason: string;
  /** Actual Windows Private Bytes (MB); null when the platform/probe does not provide it. */
  processPrivateMb: number | null;
  /** System commit axis (observe-only): all null when the probe did not measure it. */
  systemCommitFraction: number | null;
  systemCommitUsedMb: number | null;
  systemCommitLimitMb: number | null;
  /** "warn" exactly once per high-water crossing; NEVER "restart" — see §6 of the v1 spec. */
  commitAction: "none" | "warn";
  commitReason: string;
}

export function createWatchdogState(): WatchdogState {
  return { samples: [], reportedLevel: "ok", commitReported: false, restartCount: 0, lastRestartAt: 0 };
}

function levelFor(fraction: number, cfg: ResolvedWatchdogConfig): WatchdogLevel {
  if (fraction >= cfg.criticalFraction) return "critical";
  if (fraction >= cfg.warnFraction) return "warn";
  return "ok";
}

/** bytes/hour over the retained window, or null when there is not enough spread to be meaningful. */
function growthBytesPerHour(state: WatchdogState): number | null {
  if (state.samples.length < 2) return null;
  const first = state.samples[0]!;
  const last = state.samples[state.samples.length - 1]!;
  const dtMs = last.t - first.t;
  if (dtMs <= 0) return null;
  return ((last.bytes - first.bytes) / dtMs) * 3_600_000;
}

/**
 * Pure evaluation of one snapshot. Mutates `state` (sample ring, report latches, restart
 * bookkeeping) and returns the decision. Two independent axes:
 *   - PROCESS pressure (processPressureBytes / physicalMemoryBytes): unchanged semantics — emits
 *     action "restart" only when level is critical AND auto-restart is enabled AND the cooldown +
 *     max-restart guards allow it; otherwise a critical level degrades to a "warn" action.
 *   - SYSTEM commit (systemCommittedBytes / systemCommitLimitBytes): observe-only. Crossing the
 *     high-water emits commitAction "warn" exactly once (latched, re-armed on measured recovery);
 *     it NEVER contributes to the restart decision — the cause may be another process, and
 *     restarting OpenCodex would not free it. Skipped null-safely when not measured.
 */
export function evaluate(
  state: WatchdogState,
  snapshot: MemorySnapshot,
  cfg: ResolvedWatchdogConfig,
  nowMs: number,
  supervised = true,
): WatchdogDecision {
  const bytes = snapshot.processPressureBytes;
  const total = snapshot.physicalMemoryBytes > 0 ? snapshot.physicalMemoryBytes : bytes;
  const fraction = total > 0 ? bytes / total : 0;

  state.samples.push({ t: nowMs, bytes, fraction });
  const cutoff = nowMs - cfg.growthWindowMs;
  while (state.samples.length > 2 && state.samples[0]!.t < cutoff) state.samples.shift();

  const level = levelFor(fraction, cfg);
  const growth = growthBytesPerHour(state);

  let action: WatchdogAction = "none";
  let reason = "";

  if (level === "ok") {
    state.reportedLevel = "ok"; // recovered — re-arm warnings for the next crossing
  } else if (level === "warn") {
    if (state.reportedLevel === "ok") { action = "warn"; reason = "crossed warn fraction"; }
    state.reportedLevel = state.reportedLevel === "critical" ? "critical" : "warn";
  } else {
    // critical
    const cooledDown = nowMs - state.lastRestartAt >= cfg.minRestartIntervalMs || state.lastRestartAt === 0;
    const underCap = state.restartCount < cfg.maxRestarts;
    const supervisorOk = !cfg.requireSupervisor || supervised;
    if (cfg.autoRestart && supervisorOk && cooledDown && underCap) {
      action = "restart";
      reason = "crossed critical fraction; auto-restart armed";
      state.restartCount += 1;
      state.lastRestartAt = nowMs;
    } else {
      if (state.reportedLevel !== "critical") { action = "warn"; }
      reason = !cfg.autoRestart
        ? "critical; auto-restart disabled"
        : !supervisorOk
          ? "critical; auto-restart suppressed: no supervisor"
          : underCap
            ? "critical; restart deferred by cooldown"
            : "critical; max-restart guard reached";
    }
    state.reportedLevel = "critical";
  }

  // System-commit axis (observe-only, null-safe). Never touches `action` above.
  let commitAction: "none" | "warn" = "none";
  let commitReason = "";
  let commitFraction: number | null = null;
  if (
    snapshot.systemCommitAvailable
    && snapshot.systemCommittedBytes !== null
    && snapshot.systemCommitLimitBytes !== null
    && snapshot.systemCommitLimitBytes > 0
  ) {
    commitFraction = snapshot.systemCommittedBytes / snapshot.systemCommitLimitBytes;
    if (commitFraction >= cfg.systemCommitHighWater) {
      if (!state.commitReported) {
        commitAction = "warn";
        commitReason = "system commit charge crossed high-water (observe-only; the cause may be another process — no restart)";
        state.commitReported = true;
      }
    } else {
      state.commitReported = false; // measured recovery below high-water → re-arm
    }
  }
  // Not measured (non-Windows / probe failure): skip entirely — the latch holds either way.

  return {
    level,
    action,
    fraction,
    pressureMb: Math.round(bytes / MiB),
    totalMb: Math.round(total / MiB),
    source: snapshot.processSource,
    growthMbPerHour: growth === null ? null : Math.round(growth / MiB),
    reason,
    processPrivateMb: snapshot.processPrivateBytes === null ? null : Math.round(snapshot.processPrivateBytes / MiB),
    systemCommitFraction: commitFraction,
    systemCommitUsedMb: snapshot.systemCommittedBytes === null ? null : Math.round(snapshot.systemCommittedBytes / MiB),
    systemCommitLimitMb: snapshot.systemCommitLimitBytes === null ? null : Math.round(snapshot.systemCommitLimitBytes / MiB),
    commitAction,
    commitReason,
  };
}

// ---------------------------------------------------------------------------
// Recommendation (advisory only — never mutates config or state)
// ---------------------------------------------------------------------------

export interface WatchdogRecommendation {
  warnFraction: number;
  criticalFraction: number;
  autoRestart: boolean;
  rationale: string;
}

/**
 * Suggest thresholds from the observed steady-state. Advisory only: it computes numbers a human (or
 * the Adjust UI) can choose to apply, and never touches config or running state. Warn is placed a
 * margin above the observed peak fraction so it does not false-fire on normal usage; critical sits a
 * further margin above warn. autoRestart is only suggested when a supervisor exists AND memory is
 * trending up (a flat process does not benefit from restarts). With < 2 samples it echoes the
 * current config and says so.
 */
export function recommend(
  state: WatchdogState,
  cfg: ResolvedWatchdogConfig,
  supervised: boolean,
): WatchdogRecommendation {
  if (state.samples.length < 2) {
    return {
      warnFraction: cfg.warnFraction,
      criticalFraction: cfg.criticalFraction,
      autoRestart: cfg.autoRestart,
      rationale: "insufficient samples; keeping current thresholds",
    };
  }
  const observedMax = Math.max(...state.samples.map(s => s.fraction));
  const clamp = (v: number) => Math.min(0.99, Math.max(0.10, v));
  const warnFraction = clamp(observedMax + 0.10);
  const criticalFraction = clamp(Math.max(warnFraction + 0.10, observedMax + 0.20));
  const growth = growthBytesPerHour(state);
  const trendingUp = growth !== null && growth > 0;
  const autoRestart = supervised && trendingUp;
  const growthMbH = growth === null ? "n/a" : `${Math.round(growth / MiB)}MB/h`;
  const rationale =
    `observed peak ${(observedMax * 100).toFixed(1)}% of RAM over ${state.samples.length} samples; ` +
    `growth ${growthMbH}; supervisor ${supervised ? "detected" : "not detected"} ` +
    `→ autoRestart ${autoRestart ? "suggested" : "not suggested"}`;
  return { warnFraction, criticalFraction, autoRestart, rationale };
}

// ---------------------------------------------------------------------------
// Runtime driver (timer + logging + restart hook)
// ---------------------------------------------------------------------------

export interface WatchdogDeps {
  now: () => number;
  /** Async snapshot capture (Windows probes a child process). Must not throw or block the loop. */
  capture: (nowMs: number, signal?: AbortSignal) => Promise<MemorySnapshot>;
  /** Whether an external supervisor will respawn us; gates auto-restart when requireSupervisor is on. */
  supervised: boolean;
  /** Perform the graceful restart. Default: drain + flush snapshot, then exit with the restart code. */
  restart: (cfg: ResolvedWatchdogConfig) => void | Promise<void>;
  log: (line: string) => void;
  /** Persist a restart decision timestamp (cross-process guard seed). Optional so tests stay disk-free. */
  recordRestart?: (atMs: number) => void;
}

/** One restart owns the exit: concurrent or repeated invocations must not start a second drain. */
let restartInFlight = false;

function defaultRestart(cfg: ResolvedWatchdogConfig): void {
  if (restartInFlight) return;
  restartInFlight = true;
  // The decision is made — stop sampling so mid-drain ticks can neither spam logs nor (with a
  // mis-tuned cooldown) arm a second restart while this drain is still inside its grace window.
  stopMemoryWatchdog();
  void (async () => {
    try {
      // Quiet-window: drainAndShutdown rejects new turns and returns the moment the in-flight set
      // empties, so this waits for a natural idle gap and only aborts turns that outlive the budget.
      await drainAndShutdown(undefined, cfg.restartGraceMs);
    } finally {
      // drainAndShutdown resets its draining flag, but nothing can interleave here: the server is
      // already stopped and this exit runs in the same microtask chain as the drain's resolution.
      process.exit(MEMORY_RESTART_EXIT_CODE);
    }
  })();
}

const DEFAULT_DEPS: WatchdogDeps = {
  now: Date.now,
  capture: (nowMs, signal) => captureMemorySnapshot(nowMs, signal),
  supervised: detectSupervisor().supervised,
  restart: defaultRestart,
  log: line => console.warn(line),
  recordRestart: recordMemoryRestart,
};

function formatLine(d: WatchdogDecision): string {
  const pct = (d.fraction * 100).toFixed(1);
  const growth = d.growthMbPerHour === null ? "n/a" : `${d.growthMbPerHour}MB/h`;
  return `[opencodex] memory watchdog ${d.level.toUpperCase()}: ${d.pressureMb}MB / ${d.totalMb}MB (${pct}% of RAM, source=${d.source}, growth=${growth}) — ${d.reason}`;
}

function formatCommitLine(d: WatchdogDecision): string {
  const pct = d.systemCommitFraction === null ? "?" : (d.systemCommitFraction * 100).toFixed(1);
  return `[opencodex] memory watchdog SYSTEM-COMMIT: ${d.systemCommitUsedMb}MB / ${d.systemCommitLimitMb}MB (${pct}% of commit limit) — ${d.commitReason}`;
}

interface RunningWatchdog {
  /** Monotonic start id — a late probe completion from a stopped/replaced watchdog is ignored. */
  generation: number;
  /** Pending self-rescheduled probe timer; null while a probe is in flight. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Aborts the in-flight capture (kills the child probe) on stop. */
  abort: AbortController | null;
  state: WatchdogState;
  last: WatchdogDecision | null;
  cfg: ResolvedWatchdogConfig;
  deps: WatchdogDeps;
  // Observability cache — computed once per probe completion (§7), NOT on every 5s dashboard poll.
  lastSnapshot: MemorySnapshot | null;
  responseState: ResponseStateMetrics | null;
  lastProbeAt: number | null;
  lastSuccessfulSystemProbeAt: number | null;
}

let running: RunningWatchdog | null = null;
let generationCounter = 0;

/**
 * Apply one completed probe snapshot: evaluate → log/restart actions. Sync and deterministic —
 * exported for tests (the async probe loop is just "capture, then this, then reschedule").
 */
export function tick(
  state: WatchdogState,
  cfg: ResolvedWatchdogConfig,
  deps: WatchdogDeps,
  snapshot: MemorySnapshot,
): WatchdogDecision {
  const nowMs = deps.now();
  const decision = evaluate(state, snapshot, cfg, nowMs, deps.supervised);
  if (decision.action === "warn") {
    deps.log(formatLine(decision));
  } else if (decision.action === "restart") {
    deps.log(formatLine(decision));
    // Persist first: even if the restart hook fails, the DECISION happened and must count
    // toward the cross-process cooldown/cap when the next process seeds from history.
    try { deps.recordRestart?.(nowMs); } catch { /* best-effort */ }
    // A failing restart hook must be visible, not an unhandled rejection or a thrown tick:
    // the watchdog keeps running (warn-only until the cooldown re-arms) either way.
    try {
      const result: unknown = deps.restart(cfg);
      if (result instanceof Promise) {
        result.catch((err: unknown) => deps.log(`[opencodex] memory watchdog restart hook failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    } catch (err) {
      deps.log(`[opencodex] memory watchdog restart hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Observe-only commit axis: an independent log line, never a restart (see evaluate()).
  if (decision.commitAction === "warn") {
    deps.log(formatCommitLine(decision));
  }
  return decision;
}

/**
 * One probe cycle: capture (async, non-blocking) → evaluate exactly once → cache observability →
 * self-reschedule. Self-rescheduling (next setTimeout armed only after this probe fully completes)
 * structurally prevents overlapping probes; the generation guard drops results that complete after
 * stopMemoryWatchdog()/a restart replaced the singleton, so a late probe can never revive state.
 */
async function probeOnce(generation: number): Promise<void> {
  const r = running;
  if (!r || r.generation !== generation) return;
  r.timer = null;
  r.abort = new AbortController();
  let snapshot: MemorySnapshot | null = null;
  try {
    snapshot = await r.deps.capture(r.deps.now(), r.abort.signal);
  } catch {
    snapshot = null; // capture is contractually non-throwing; treat a bug as a skipped cycle
  }
  if (!running || running.generation !== generation) return; // stopped mid-probe — drop late result
  running.abort = null;
  try {
    if (snapshot) {
      running.last = tick(running.state, running.cfg, running.deps, snapshot);
      running.lastSnapshot = snapshot;
      // §7: COMPLETION time, not capture start — a slow probe must read as fresh, not stale.
      const completedAt = running.deps.now();
      running.lastProbeAt = completedAt;
      if (snapshot.systemCommitAvailable) running.lastSuccessfulSystemProbeAt = completedAt;
      // Response-state metrics serialize every entry — compute once per probe, not per poll.
      try { running.responseState = responseStateMetrics(); } catch { running.responseState = null; }
    }
  } catch {
    /* an evaluation failure must never crash the proxy */
  }
  scheduleNextProbe(generation, running.cfg.intervalMs);
}

function scheduleNextProbe(generation: number, delayMs: number): void {
  if (!running || running.generation !== generation) return;
  const timer = setTimeout(() => { void probeOnce(generation); }, delayMs);
  (timer as { unref?: () => void }).unref?.();
  running.timer = timer;
}

/**
 * Start the watchdog. No-op (returns false) when disabled. Idempotent: a second call replaces the
 * previous instance (its generation is invalidated, so in-flight probes are dropped). The first
 * probe fires IMMEDIATELY — a proxy booting into an already-critical box is evaluated as soon as
 * the first capture completes, not one interval later. Timers are unref'd.
 */
export function startMemoryWatchdog(config: OcxConfig, deps: Partial<WatchdogDeps> = {}): boolean {
  const cfg = resolveWatchdogConfig(config);
  if (!cfg.enabled) return false;
  stopMemoryWatchdog();
  const d: WatchdogDeps = { ...DEFAULT_DEPS, ...deps };
  const state = createWatchdogState();
  // Seed the restart guards from the best-effort history so cooldown/maxRestarts bind across the
  // process boundary a fired restart creates. A missing/corrupt file seeds zeros (fresh slate).
  const seeded = loadMemoryRestartHistory(d.now());
  state.lastRestartAt = seeded.lastRestartAt;
  state.restartCount = seeded.recentCount;
  const generation = ++generationCounter;
  running = {
    generation,
    timer: null,
    abort: null,
    state,
    last: null,
    cfg,
    deps: d,
    lastSnapshot: null,
    responseState: null,
    lastProbeAt: null,
    lastSuccessfulSystemProbeAt: null,
  };
  void probeOnce(generation);
  return true;
}

/**
 * Live-update knobs on a running watchdog without a restart (Adjust UI / management API). The same
 * final validation as resolveWatchdogConfig applies: fractions are clamped and critical is kept
 * above warn, durations are clamped/normalized (grace bounds, cooldown >= grace, 1s interval
 * floor). An intervalMs change re-arms the timer. Returns the applied config, or null when the
 * watchdog is not running.
 */
export function applyWatchdogRuntimeConfig(
  partial: Partial<ResolvedWatchdogConfig>,
): ResolvedWatchdogConfig | null {
  if (!running) return null;
  const next: ResolvedWatchdogConfig = { ...running.cfg, ...partial };
  next.warnFraction = clampFraction(next.warnFraction, DEFAULTS.warnFraction);
  next.criticalFraction = clampFraction(next.criticalFraction, DEFAULTS.criticalFraction);
  if (next.criticalFraction <= next.warnFraction) {
    next.criticalFraction = Math.min(0.99, next.warnFraction + 0.10);
  }
  next.restartGraceMs = clampMs(next.restartGraceMs, RESTART_GRACE_MIN_MS, RESTART_GRACE_MAX_MS, running.cfg.restartGraceMs);
  next.minRestartIntervalMs = posNumOr(next.minRestartIntervalMs, running.cfg.minRestartIntervalMs);
  normalizeRestartTiming(next);
  next.intervalMs = Math.max(1_000, posNumOr(next.intervalMs, running.cfg.intervalMs));
  const intervalChanged = next.intervalMs !== running.cfg.intervalMs;
  running.cfg = next;
  // Self-rescheduling loop: a probe in flight (timer === null) picks the new interval up on its
  // own completion; only a PENDING timer needs re-arming to honor the new cadence promptly.
  if (intervalChanged && running.timer !== null) {
    clearTimeout(running.timer);
    running.timer = null;
    scheduleNextProbe(running.generation, next.intervalMs);
  }
  return next;
}

/**
 * Stop the watchdog (graceful shutdown / tests). Idempotent. Cancels the pending probe timer,
 * aborts an in-flight capture (killing its child probe process), and clears the singleton — a
 * probe result that still arrives sees no matching generation and is dropped instead of reviving
 * state.
 */
export function stopMemoryWatchdog(): void {
  if (!running) return;
  if (running.timer !== null) clearTimeout(running.timer);
  try { running.abort?.abort(); } catch { /* already settled */ }
  running = null;
}

/** Last decision + guard state, for the management API / diagnostics. Null when never sampled. */
export function memoryWatchdogSnapshot(): (WatchdogDecision & { restartCount: number }) | null {
  if (!running || !running.last) return null;
  return { ...running.last, restartCount: running.state.restartCount };
}

/** Snapshot-derived observability block (§7) — cached at probe completion, null before the first. */
export interface WatchdogMemoryReport {
  processPrivateBytes: number | null;
  processPressureBytes: number;
  processSource: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  physicalMemoryBytes: number;
  availablePhysicalBytes: number | null;
  systemCommittedBytes: number | null;
  systemCommitLimitBytes: number | null;
  systemCommitFraction: number | null;
  systemCommitAvailable: boolean;
  probeError?: string;
}

export interface WatchdogReport {
  enabled: boolean;
  decision: WatchdogDecision | null;
  samplesCount: number;
  growthMbPerHour: number | null;
  resolvedConfig: ResolvedWatchdogConfig;
  supervisor: { supervised: boolean; hint: string };
  recommendation: WatchdogRecommendation;
  restartCount: number;
  /** Last completed probe's measurements; null until the first probe completes. */
  memory: WatchdogMemoryReport | null;
  /** Response-state cache metrics, computed once per probe completion (not per poll). */
  responseState: ResponseStateMetrics | null;
  /** Last probe COMPLETION time (RSS fallback included); null before the first. */
  lastProbeAt: number | null;
  /** Last probe that measured the system commit values successfully; null when never. */
  lastSuccessfulSystemProbeAt: number | null;
}

/**
 * Full observability report for the dashboard (Monitor + Recommend). Read-only: it never mutates
 * config or state, and the per-probe blocks (memory/responseState) come from the probe-completion
 * cache so a 5s dashboard poll never re-serializes the response store. Returns null when the
 * watchdog is not running (disabled); the caller reports that as { enabled: false }.
 */
export function memoryWatchdogReport(): WatchdogReport | null {
  if (!running) return null;
  const supervisor = detectSupervisor();
  const s = running.lastSnapshot;
  return {
    enabled: true,
    decision: running.last,
    samplesCount: running.state.samples.length,
    growthMbPerHour: running.last?.growthMbPerHour ?? null,
    resolvedConfig: running.cfg,
    supervisor,
    recommendation: recommend(running.state, running.cfg, supervisor.supervised),
    restartCount: running.state.restartCount,
    memory: s === null ? null : {
      processPrivateBytes: s.processPrivateBytes,
      processPressureBytes: s.processPressureBytes,
      processSource: s.processSource,
      rssBytes: s.rssBytes,
      heapUsedBytes: s.heapUsedBytes,
      externalBytes: s.externalBytes,
      physicalMemoryBytes: s.physicalMemoryBytes,
      availablePhysicalBytes: s.availablePhysicalBytes,
      systemCommittedBytes: s.systemCommittedBytes,
      systemCommitLimitBytes: s.systemCommitLimitBytes,
      systemCommitFraction: s.systemCommitAvailable && s.systemCommittedBytes !== null && s.systemCommitLimitBytes !== null && s.systemCommitLimitBytes > 0
        ? s.systemCommittedBytes / s.systemCommitLimitBytes
        : null,
      systemCommitAvailable: s.systemCommitAvailable,
      ...(s.probeError !== undefined ? { probeError: s.probeError } : {}),
    },
    responseState: running.responseState,
    lastProbeAt: running.lastProbeAt,
    lastSuccessfulSystemProbeAt: running.lastSuccessfulSystemProbeAt,
  };
}

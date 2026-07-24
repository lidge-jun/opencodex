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
 * SAFETY MODEL:
 *   - Default action is WARN ONLY. It cannot lose data or kill the process.
 *   - Auto-restart is opt-in (config.memoryWatchdog.autoRestart / env). When it fires it reuses
 *     drainAndShutdown() — which drains in-flight turns and flushes the response-state snapshot —
 *     then exits with a distinct code so a supervisor can respawn.
 *   - Quiet-window restart: the drain budget for a memory-driven restart is restartGraceMs (default
 *     30s), much longer than a generic shutdown. Because drainAndShutdown rejects new turns and exits
 *     the instant the in-flight set empties, the restart normally lands on a natural idle gap — so a
 *     running turn is only cut when it outlives the whole grace window (bounded so the restart always
 *     fires). A mid-stream turn that is still cut is regenerated on retry (context is preserved via
 *     the flushed previous_response_id snapshot); the provider generation itself cannot be resumed.
 *   - A cooldown (minRestartIntervalMs) and a max-restart guard prevent restart loops.
 *   - The decision core (evaluate) is pure and injectable (clock + reader + restart hook) so the
 *     logic is unit-tested without real timers or a real process exit.
 */

import { pressureBytes, pressureSource, readMemorySnapshot, type MemorySnapshot } from "../lib/memory-usage";
import { drainAndShutdown } from "./lifecycle";
import type { OcxConfig } from "../types";

/** Exit code used for an intentional memory-driven restart (distinct from crash/normal exit). */
export const MEMORY_RESTART_EXIT_CODE = 75; // EX_TEMPFAIL: "transient, retry" — a supervisor should respawn.

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

/**
 * Resolve config → runtime knobs. Precedence: env override > config file > default. Fractions are
 * clamped to [0.10, 0.99]; a criticalFraction <= warnFraction is nudged above warn so the two
 * levels never collapse.
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

  return {
    enabled,
    intervalMs: envNum("OCX_MEMORY_WATCHDOG_INTERVAL_MS") ?? c.intervalMs ?? DEFAULTS.intervalMs,
    warnFraction,
    criticalFraction,
    autoRestart: envFlag("OCX_MEMORY_WATCHDOG_AUTO_RESTART") ?? c.autoRestart ?? DEFAULTS.autoRestart,
    requireSupervisor:
      envFlag("OCX_MEMORY_WATCHDOG_REQUIRE_SUPERVISOR") ?? c.requireSupervisor ?? DEFAULTS.requireSupervisor,
    minRestartIntervalMs:
      envNum("OCX_MEMORY_WATCHDOG_MIN_RESTART_INTERVAL_MS") ?? c.minRestartIntervalMs ?? DEFAULTS.minRestartIntervalMs,
    maxRestarts: envNum("OCX_MEMORY_WATCHDOG_MAX_RESTARTS") ?? c.maxRestarts ?? DEFAULTS.maxRestarts,
    restartGraceMs:
      envNum("OCX_MEMORY_WATCHDOG_RESTART_GRACE_MS") ?? c.restartGraceMs ?? DEFAULTS.restartGraceMs,
    growthWindowMs: DEFAULTS.growthWindowMs,
  };
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
}

export function createWatchdogState(): WatchdogState {
  return { samples: [], reportedLevel: "ok", restartCount: 0, lastRestartAt: 0 };
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
 * Pure evaluation of one sample. Mutates `state` (sample ring, report latch, restart bookkeeping)
 * and returns the decision. Emits action "restart" only when level is critical AND auto-restart is
 * enabled AND the cooldown + max-restart guards allow it; otherwise a critical level degrades to a
 * "warn" action (loud log, no restart).
 */
export function evaluate(
  state: WatchdogState,
  snapshot: MemorySnapshot,
  cfg: ResolvedWatchdogConfig,
  nowMs: number,
  supervised = true,
): WatchdogDecision {
  const bytes = pressureBytes(snapshot);
  const total = snapshot.totalSystemBytes > 0 ? snapshot.totalSystemBytes : bytes;
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

  return {
    level,
    action,
    fraction,
    pressureMb: Math.round(bytes / MiB),
    totalMb: Math.round(total / MiB),
    source: pressureSource(snapshot),
    growthMbPerHour: growth === null ? null : Math.round(growth / MiB),
    reason,
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
  read: () => MemorySnapshot;
  /** Whether an external supervisor will respawn us; gates auto-restart when requireSupervisor is on. */
  supervised: boolean;
  /** Perform the graceful restart. Default: drain + flush snapshot, then exit with the restart code. */
  restart: (cfg: ResolvedWatchdogConfig) => void | Promise<void>;
  log: (line: string) => void;
}

function defaultRestart(cfg: ResolvedWatchdogConfig): void {
  void (async () => {
    try {
      // Quiet-window: drainAndShutdown rejects new turns and returns the moment the in-flight set
      // empties, so this waits for a natural idle gap and only aborts turns that outlive the budget.
      await drainAndShutdown(undefined, cfg.restartGraceMs);
    } finally {
      process.exit(MEMORY_RESTART_EXIT_CODE);
    }
  })();
}

const DEFAULT_DEPS: WatchdogDeps = {
  now: Date.now,
  read: readMemorySnapshot,
  supervised: detectSupervisor().supervised,
  restart: defaultRestart,
  log: line => console.warn(line),
};

function formatLine(d: WatchdogDecision): string {
  const pct = (d.fraction * 100).toFixed(1);
  const growth = d.growthMbPerHour === null ? "n/a" : `${d.growthMbPerHour}MB/h`;
  return `[opencodex] memory watchdog ${d.level.toUpperCase()}: ${d.pressureMb}MB / ${d.totalMb}MB (${pct}% of RAM, source=${d.source}, growth=${growth}) — ${d.reason}`;
}

interface RunningWatchdog {
  timer: ReturnType<typeof setInterval>;
  state: WatchdogState;
  last: WatchdogDecision | null;
  cfg: ResolvedWatchdogConfig;
  deps: WatchdogDeps;
}

let running: RunningWatchdog | null = null;

/** One sampling tick: read → evaluate → act. Exported for deterministic tests. */
export function tick(state: WatchdogState, cfg: ResolvedWatchdogConfig, deps: WatchdogDeps): WatchdogDecision {
  const snapshot = deps.read();
  const decision = evaluate(state, snapshot, cfg, deps.now(), deps.supervised);
  if (decision.action === "warn") {
    deps.log(formatLine(decision));
  } else if (decision.action === "restart") {
    deps.log(formatLine(decision));
    void deps.restart(cfg);
  }
  return decision;
}

/**
 * Start the watchdog. No-op (returns false) when disabled. Idempotent: a second call replaces the
 * previous timer. The interval is unref'd so it never keeps the event loop alive on its own.
 */
export function startMemoryWatchdog(config: OcxConfig, deps: Partial<WatchdogDeps> = {}): boolean {
  const cfg = resolveWatchdogConfig(config);
  if (!cfg.enabled) return false;
  stopMemoryWatchdog();
  const d: WatchdogDeps = { ...DEFAULT_DEPS, ...deps };
  const state = createWatchdogState();
  const timer = setInterval(() => {
    try {
      running!.last = tick(running!.state, running!.cfg, running!.deps);
    } catch {
      /* a sampling failure must never crash the proxy */
    }
  }, cfg.intervalMs);
  (timer as { unref?: () => void }).unref?.();
  running = { timer, state, last: null, cfg, deps: d };
  return true;
}

/**
 * Live-update knobs on a running watchdog without a restart (Adjust UI / management API). Fractions
 * are clamped and critical is kept above warn, mirroring resolveWatchdogConfig. An intervalMs change
 * re-arms the timer. Returns the applied config, or null when the watchdog is not running.
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
  const intervalChanged = next.intervalMs !== running.cfg.intervalMs && next.intervalMs > 0;
  running.cfg = next;
  if (intervalChanged) {
    clearInterval(running.timer);
    const timer = setInterval(() => {
      try {
        running!.last = tick(running!.state, running!.cfg, running!.deps);
      } catch {
        /* a sampling failure must never crash the proxy */
      }
    }, next.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    running.timer = timer;
  }
  return next;
}

/** Stop the watchdog timer (graceful shutdown / tests). Idempotent. */
export function stopMemoryWatchdog(): void {
  if (!running) return;
  clearInterval(running.timer);
  running = null;
}

/** Last decision + guard state, for the management API / diagnostics. Null when never sampled. */
export function memoryWatchdogSnapshot(): (WatchdogDecision & { restartCount: number }) | null {
  if (!running || !running.last) return null;
  return { ...running.last, restartCount: running.state.restartCount };
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
}

/**
 * Full observability report for the dashboard (Monitor + Recommend). Read-only: it never mutates
 * config or state. Returns null when the watchdog is not running (disabled); the caller reports that
 * as { enabled: false } so old/disabled servers degrade gracefully.
 */
export function memoryWatchdogReport(): WatchdogReport | null {
  if (!running) return null;
  const supervisor = detectSupervisor();
  return {
    enabled: true,
    decision: running.last,
    samplesCount: running.state.samples.length,
    growthMbPerHour: running.last?.growthMbPerHour ?? null,
    resolvedConfig: running.cfg,
    supervisor,
    recommendation: recommend(running.state, running.cfg, supervisor.supervised),
    restartCount: running.state.restartCount,
  };
}

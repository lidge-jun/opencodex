import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";
import { isTelemetryEnvOptOut, resolveTelemetryStatus, type TelemetryConsentStatus } from "./consent";
import {
  computeInstallDayHash,
  ensureTelemetryInstallId,
  markTelemetryFirstReportSent,
} from "./install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel, type ResolveInstallChannelOptions } from "./payload";
import { sendTelemetryPayload, type TelemetrySendOptions, type TelemetrySendResult } from "./sender";
import {
  endTelemetryEnvOptOut,
  formatUtcDay,
  readTelemetryState,
  readTelemetryStateFile,
  recordTelemetryEnvOptOut,
  utcMidnightMs,
  withPendingTelemetryDecision,
  writeTelemetryState,
  type TelemetryState,
} from "./state";

export {
  TELEMETRY_STATE_FILE,
  clearPendingTelemetryDecision,
  endTelemetryEnvOptOut,
  formatUtcDay,
  readTelemetryState,
  readTelemetryStateFile,
  recordPendingTelemetryDecision,
  recordTelemetryEnvOptOut,
  telemetryStatePath,
  utcMidnightMs,
  withPendingTelemetryDecision,
  writeTelemetryState,
  type TelemetryEnvOptOutOwner,
  type TelemetryState,
} from "./state";

export const TELEMETRY_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TELEMETRY_STARTUP_BASE_DELAY_MS = 30_000;
export const TELEMETRY_STARTUP_JITTER_MS = 60_000;
export const TELEMETRY_INTERVAL_JITTER_MS = 15 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_BACKLOG_DAYS = 7;

export function latestCompletedUtcDay(now = Date.now()): string {
  return formatUtcDay(utcMidnightMs(now) - DAY_MS);
}

/**
 * Resolve the oldest completed UTC day (within the 7-day window) that is eligible to be sent next:
 * - `status.effective` must be true.
 * - Strictly AFTER the UTC day of `decidedAt ?? noticeShownAt` (D1).
 * - Strictly AFTER `state.ineligibleThroughDay` when set (D2).
 * - Nothing while an env opt-out marker is still set: that period may have run until today (D2).
 * - Not already recorded in `state.sentDays`.
 */
export function resolveNextEligibleTelemetryDay(
  status: TelemetryConsentStatus,
  state: TelemetryState,
  now = Date.now(),
): { day: string | null; reason: string } {
  if (!status.effective) {
    return { day: null, reason: status.reason };
  }
  if (state.envOptOutActiveSince || (state.envOptOutOwners?.length ?? 0) > 0) {
    return { day: null, reason: "env-opt-out-pending" };
  }
  const consentTimestamp = status.decidedAt ?? status.noticeShownAt;
  if (!consentTimestamp) {
    return { day: null, reason: "missing-consent-timestamp" };
  }
  const consentMs = Date.parse(consentTimestamp);
  if (Number.isNaN(consentMs)) {
    return { day: null, reason: "invalid-consent-timestamp" };
  }
  const consentDay = formatUtcDay(consentMs);
  const todayMs = utcMidnightMs(now);

  for (let offset = MAX_BACKLOG_DAYS; offset >= 1; offset--) {
    const candidateDay = formatUtcDay(todayMs - offset * DAY_MS);
    if (candidateDay <= consentDay) continue;
    if (state.ineligibleThroughDay && candidateDay <= state.ineligibleThroughDay) continue;
    if (state.sentDays[candidateDay]) continue;
    return { day: candidateDay, reason: "eligible" };
  }
  return { day: null, reason: "up-to-date" };
}

export function computeTelemetryStartupDelayMs(random: () => number = Math.random): number {
  return TELEMETRY_STARTUP_BASE_DELAY_MS + Math.floor(random() * TELEMETRY_STARTUP_JITTER_MS);
}

export function computeTelemetryIntervalDelayMs(
  baseMs = TELEMETRY_TICK_INTERVAL_MS,
  random: () => number = Math.random,
): number {
  return baseMs + Math.floor(random() * TELEMETRY_INTERVAL_JITTER_MS);
}

export interface TelemetryTickOptions extends TelemetrySendOptions, ResolveInstallChannelOptions {
  configDir?: string;
  config?: Pick<OcxConfig, "telemetry">
  readConfig?: () => Pick<OcxConfig, "telemetry">;
  aggregateDay?: (day: string, options?: { signal?: AbortSignal }) => Promise<DailyTelemetryAggregate>;
}

export interface TelemetryTickResult {
  sent: boolean;
  day?: string;
  reason: string;
  sendResult?: TelemetrySendResult;
}

const activeTickControllers = new Set<AbortController>();

function abortActiveTicks(reason: string): void {
  for (const controller of activeTickControllers) {
    controller.abort(new Error(reason));
  }
  activeTickControllers.clear();
}

/**
 * Run one telemetry tick:
 * - Re-reads config passively from disk and re-evaluates `resolveTelemetryStatus`.
 * - Persists `ineligibleThroughDay` and deletes the install id whenever an env opt-out is observed.
 * - Sends only completed UTC days strictly after the UTC day of `decidedAt ?? noticeShownAt`
 *   and strictly after `ineligibleThroughDay`.
 * - Re-checks consent and env immediately before transmission and cancels in-flight work on stop/nudge.
 * - Sends at most ONE day per tick, oldest first, at most the last 7 completed days.
 */
export async function runTelemetryTick(options: TelemetryTickOptions = {}): Promise<TelemetryTickResult> {
  const now = options.now ?? Date.now();
  const configDir = options.configDir ?? getConfigDir();
  const readCurrentEnv = (): Record<string, string | undefined> => options.env ?? process.env;
  const readRawConfig = (): Pick<OcxConfig, "telemetry"> | undefined => {
    if (options.readConfig) return options.readConfig();
    const diskConfig = readConfigDiagnostics({ passive: true }).config;
    if (options.config) {
      if (diskConfig.telemetry !== undefined) {
        const currentEnv = readCurrentEnv();
        const optStatus = resolveTelemetryStatus(options.config, currentEnv);
        const diskStatus = resolveTelemetryStatus(diskConfig, currentEnv);
        return !optStatus.effective ? options.config : !diskStatus.effective ? diskConfig : options.config;
      }
      return options.config;
    }
    return diskConfig;
  };
  // A decision held from before config.json existed applies until the config carries its own.
  const readCurrentConfig = (): Pick<OcxConfig, "telemetry"> | undefined =>
    withPendingTelemetryDecision(readRawConfig(), configDir) ?? undefined;

  const initialEnv = readCurrentEnv();
  if (isTelemetryEnvOptOut(initialEnv) !== null) {
    recordTelemetryEnvOptOut(configDir, now);
    const status = resolveTelemetryStatus(readCurrentConfig(), initialEnv);
    return { sent: false, reason: status.reason };
  }

  const status = resolveTelemetryStatus(readCurrentConfig(), initialEnv);
  if (!status.effective) {
    return { sent: false, reason: status.reason };
  }

  const stateFile = readTelemetryStateFile(configDir);
  if (stateFile.unreadable) {
    // A state file that exists but cannot be read may have held opt-out days; never send over it.
    return { sent: false, reason: "state-unreadable" };
  }
  if (stateFile.state.envOptOutActiveSince || (stateFile.state.envOptOutOwners?.length ?? 0) > 0) {
    // Ends the period only once no opted-out proxy is still running; otherwise extends it to today.
    endTelemetryEnvOptOut(configDir, now);
  }
  const current = readTelemetryStateFile(configDir);
  if (current.unreadable) return { sent: false, reason: "state-unreadable" };
  const state = current.state;
  if (state.retryAfterUntil) {
    const retryUntilMs = Date.parse(state.retryAfterUntil);
    if (!Number.isNaN(retryUntilMs) && now < retryUntilMs) {
      return { sent: false, reason: "retry-after-backoff" };
    }
  }

  const { day: targetDay, reason: eligibilityReason } = resolveNextEligibleTelemetryDay(status, state, now);
  if (!targetDay) {
    return { sent: false, reason: eligibilityReason };
  }

  const tickController = new AbortController();
  activeTickControllers.add(tickController);
  const parentSignal = options.signal;
  const onParentAbort = () => tickController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    activeTickControllers.delete(tickController);
    return { sent: false, day: targetDay, reason: "aborted" };
  }
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    let aggregate: DailyTelemetryAggregate;
    try {
      aggregate = await (options.aggregateDay
        ? options.aggregateDay(targetDay, { signal: tickController.signal })
        : aggregateTelemetryForDay(targetDay, { signal: tickController.signal }));
    } catch (error) {
      if (tickController.signal.aborted) {
        return { sent: false, day: targetDay, reason: "aborted" };
      }
      throw error;
    }

    const preSendEnv = readCurrentEnv();
    if (isTelemetryEnvOptOut(preSendEnv) !== null) {
      recordTelemetryEnvOptOut(configDir, now);
      const latestStatus = resolveTelemetryStatus(readCurrentConfig(), preSendEnv);
      return { sent: false, day: targetDay, reason: latestStatus.reason };
    }
    if (tickController.signal.aborted) {
      return { sent: false, day: targetDay, reason: "aborted" };
    }
    const preSendStatus = resolveTelemetryStatus(readCurrentConfig(), preSendEnv);
    if (!preSendStatus.effective) {
      return { sent: false, day: targetDay, reason: preSendStatus.reason };
    }
    // The file may have become unreadable while the day was aggregated; never send over it.
    const preSendFile = readTelemetryStateFile(configDir);
    if (preSendFile.unreadable) {
      return { sent: false, day: targetDay, reason: "state-unreadable" };
    }
    const preSendState = preSendFile.state;
    const recheckedEligibility = resolveNextEligibleTelemetryDay(preSendStatus, preSendState, now);
    if (recheckedEligibility.day !== targetDay) {
      return { sent: false, day: targetDay, reason: recheckedEligibility.reason };
    }

    const { identity } = ensureTelemetryInstallId(configDir);
    // An id minted after an opt-out is a returning install, not a new one.
    const newInstall = identity.firstReportSent !== true && preSendState.everReported !== true;
    const installDayHash = computeInstallDayHash(identity.installId, targetDay);
    const payload = buildTelemetryPayloadV1({
      aggregate,
      installDayHash,
      newInstall,
      now,
      installChannel: resolveInstallChannel({ ...options, env: preSendEnv }),
    });
    const sendResult = await sendTelemetryPayload(payload, {
      ...options,
      signal: tickController.signal,
      now,
    });
    if (!sendResult.ok) {
      if (tickController.signal.aborted) {
        return { sent: false, day: targetDay, reason: "aborted", sendResult };
      }
      if (typeof sendResult.retryAfterMs === "number" && sendResult.retryAfterMs > 0) {
        const retryAfterUntil = new Date(now + sendResult.retryAfterMs).toISOString();
        updateReadableTelemetryState(configDir, now, state => {
          state.retryAfterUntil = retryAfterUntil;
        });
        return { sent: false, day: targetDay, reason: "retry-after-backoff", sendResult };
      }
      return { sent: false, day: targetDay, reason: "send-failed", sendResult };
    }
    markTelemetryFirstReportSent(configDir);
    const nowIso = new Date(now).toISOString();
    updateReadableTelemetryState(configDir, now, state => {
      state.sentDays[targetDay] = nowIso;
      state.everReported = true;
      state.lastSentDay = targetDay;
      state.lastSentAt = nowIso;
      state.retryAfterUntil = null;
    });
    return { sent: true, day: targetDay, reason: "sent", sendResult };
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
    activeTickControllers.delete(tickController);
  }
}

/**
 * Bookkeeping after a send. A file that became unreadable during the send is left as it is: rewriting
 * it from an empty state would drop the opt-out days it held, and every later tick refuses to send
 * until it can be read again.
 */
function updateReadableTelemetryState(configDir: string, now: number, update: (state: TelemetryState) => void): void {
  const file = readTelemetryStateFile(configDir);
  if (file.unreadable) return;
  update(file.state);
  writeTelemetryState(file.state, configDir, now);
}

let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let detachShutdownHook: (() => void) | null = null;
let activeTick: Promise<TelemetryTickResult> | null = null;
let running = false;

function triggerBackgroundTick(): void {
  if (!running) return;
  if (isTelemetryEnvOptOut(process.env) !== null) {
    try { recordTelemetryEnvOptOut(); } catch { /* best-effort */ }
    stopTelemetryScheduler();
    return;
  }
  if (activeTick) return;
  activeTick = runTelemetryTick()
    .catch((): TelemetryTickResult => ({ sent: false, reason: "tick-error" }))
    .finally(() => {
      activeTick = null;
    });
}

export function startTelemetryScheduler(options: { startupDelayMs?: number; intervalMs?: number } = {}): () => void {
  if (isTelemetryEnvOptOut(process.env) !== null) {
    try { recordTelemetryEnvOptOut(); } catch { /* best-effort */ }
    return () => {};
  }
  if (running) return stopTelemetryScheduler;
  running = true;
  detachShutdownHook = registerOptionalShutdownHook("telemetry", stopTelemetryScheduler);
  const startupDelay = options.startupDelayMs ?? computeTelemetryStartupDelayMs();
  const intervalMs = options.intervalMs ?? computeTelemetryIntervalDelayMs();
  startupTimer = setTimeout(() => {
    startupTimer = null;
    triggerBackgroundTick();
  }, startupDelay);
  startupTimer.unref?.();
  intervalTimer = setInterval(() => {
    triggerBackgroundTick();
  }, intervalMs);
  intervalTimer.unref?.();
  return stopTelemetryScheduler;
}

export function stopTelemetryScheduler(): void {
  running = false;
  abortActiveTicks("Telemetry scheduler stopped");
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  if (detachShutdownHook) {
    const detach = detachShutdownHook;
    detachShutdownHook = null;
    detach();
  }
}

export function nudgeTelemetryScheduler(): void {
  abortActiveTicks("Telemetry consent changed");
  if (!running) return;
  if (isTelemetryEnvOptOut(process.env) !== null) {
    try { recordTelemetryEnvOptOut(); } catch { /* best-effort */ }
    stopTelemetryScheduler();
    return;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    triggerBackgroundTick();
  }, 10);
  nudgeTimer.unref?.();
}

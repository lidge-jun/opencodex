import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig, OcxTelemetryConfig } from "../types";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";
import { isTelemetryEnvOptOut, resolveTelemetryStatus, type TelemetryConsentStatus } from "./consent";
import { parseCalendarUtcDayMs } from "./contract";
import {
  computeInstallDayHash,
  deleteTelemetryInstallId,
  ensureTelemetryInstallId,
  markTelemetryFirstReportSent,
} from "./install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel, type ResolveInstallChannelOptions } from "./payload";
import { sendTelemetryPayload, type TelemetrySendOptions, type TelemetrySendResult } from "./sender";

export const TELEMETRY_STATE_FILE = "telemetry-state.json";
export const TELEMETRY_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TELEMETRY_STARTUP_BASE_DELAY_MS = 30_000;
export const TELEMETRY_STARTUP_JITTER_MS = 60_000;
export const TELEMETRY_INTERVAL_JITTER_MS = 15 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_BACKLOG_DAYS = 7;
const STATE_RETENTION_DAYS = 30;

export interface TelemetryState {
  version: 1;
  sentDays: Record<string, string>;
  lastSentDay: string | null;
  lastSentAt: string | null;
  ineligibleThroughDay: string | null;
  retryAfterUntil: string | null;
  /**
   * Set whenever an env opt-out is observed and cleared only by a clean opted-out shutdown or by the
   * next tick that runs without the opt-out. While it is set, every day up to the current one is
   * ineligible, because a proxy started under `OCX_TELEMETRY=0` reads the env once and runs no ticks
   * that could keep `ineligibleThroughDay` current (D2).
   */
  envOptOutActiveSince?: string | null;
  /**
   * A decision made before `config.json` exists (the Windows installer opt-out, `ocx telemetry
   * disable` or the dashboard on a fresh install). Writing the config would turn the install into a
   * configured one and make `ocx init` skip setup, so the decision waits here and applies until a
   * decision is written into the config.
   */
  pendingDecision?: OcxTelemetryConfig | null;
  /** Set once any report was accepted, so an id minted after an opt-out is not counted as a new install. */
  everReported?: boolean;
}

export function telemetryStatePath(configDir = getConfigDir()): string {
  return join(configDir, TELEMETRY_STATE_FILE);
}

function emptyState(): TelemetryState {
  return {
    version: 1,
    sentDays: {},
    lastSentDay: null,
    lastSentAt: null,
    ineligibleThroughDay: null,
    retryAfterUntil: null,
    envOptOutActiveSince: null,
    pendingDecision: null,
    everReported: false,
  };
}

function parsePendingDecision(raw: unknown): OcxTelemetryConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.decision !== "accepted" && value.decision !== "declined") return null;
  const stamp = (key: string): string | null =>
    typeof value[key] === "string" && !Number.isNaN(Date.parse(value[key] as string)) ? (value[key] as string) : null;
  const decidedAt = stamp("decidedAt");
  if (!decidedAt) return null;
  return { decision: value.decision, decidedAt, noticeShownAt: stamp("noticeShownAt") ?? decidedAt };
}

export function readTelemetryState(configDir = getConfigDir()): TelemetryState {
  const path = telemetryStatePath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return emptyState();
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw?.version !== 1 || !raw.sentDays || typeof raw.sentDays !== "object" || Array.isArray(raw.sentDays)) {
      return emptyState();
    }
    const sentDays: Record<string, string> = {};
    for (const [day, at] of Object.entries(raw.sentDays as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof at === "string") {
        sentDays[day] = at;
      }
    }
    const ineligibleThroughDay =
      typeof raw.ineligibleThroughDay === "string" && parseCalendarUtcDayMs(raw.ineligibleThroughDay) !== null
        ? raw.ineligibleThroughDay
        : null;
    const retryAfterUntil =
      typeof raw.retryAfterUntil === "string" && !Number.isNaN(Date.parse(raw.retryAfterUntil))
        ? raw.retryAfterUntil
        : null;
    const envOptOutActiveSince =
      typeof raw.envOptOutActiveSince === "string" && !Number.isNaN(Date.parse(raw.envOptOutActiveSince))
        ? raw.envOptOutActiveSince
        : null;
    return {
      version: 1,
      sentDays,
      lastSentDay: typeof raw.lastSentDay === "string" ? raw.lastSentDay : null,
      lastSentAt: typeof raw.lastSentAt === "string" ? raw.lastSentAt : null,
      ineligibleThroughDay,
      retryAfterUntil,
      envOptOutActiveSince,
      pendingDecision: parsePendingDecision(raw.pendingDecision),
      everReported: raw.everReported === true,
    };
  } catch {
    return emptyState();
  }
}

export function writeTelemetryState(state: TelemetryState, configDir = getConfigDir(), now = Date.now()): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = telemetryStatePath(configDir);
  try { recordOwnedConfigPath(configDir, path); } catch { /* best-effort */ }
  const minKeepDay = formatUtcDay(utcMidnightMs(now) - STATE_RETENTION_DAYS * DAY_MS);
  const prunedSentDays: Record<string, string> = {};
  for (const [day, at] of Object.entries(state.sentDays ?? {})) {
    if (day >= minKeepDay) prunedSentDays[day] = at;
  }
  const payload: TelemetryState = {
    version: 1,
    sentDays: prunedSentDays,
    lastSentDay: state.lastSentDay ?? null,
    lastSentAt: state.lastSentAt ?? null,
    ineligibleThroughDay: state.ineligibleThroughDay ?? null,
    retryAfterUntil: state.retryAfterUntil ?? null,
    envOptOutActiveSince: state.envOptOutActiveSince ?? null,
    pendingDecision: state.pendingDecision ?? null,
    everReported: state.everReported === true,
  };
  atomicWriteFileNoFollow(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Hold a decision made before `config.json` exists. */
export function recordPendingTelemetryDecision(
  decision: OcxTelemetryConfig,
  configDir = getConfigDir(),
  now = Date.now(),
): void {
  const state = readTelemetryState(configDir);
  state.pendingDecision = structuredClone(decision);
  writeTelemetryState(state, configDir, now);
}

/** Drop the pending decision once a decision is written into `config.json`. */
export function clearPendingTelemetryDecision(configDir = getConfigDir(), now = Date.now()): void {
  const state = readTelemetryState(configDir);
  if (!state.pendingDecision) return;
  state.pendingDecision = null;
  writeTelemetryState(state, configDir, now);
}

/**
 * The telemetry block consent is resolved from: the config's own decision when it has one,
 * otherwise a decision held from before `config.json` existed, otherwise whatever the config says.
 */
export function withPendingTelemetryDecision<T extends Pick<OcxConfig, "telemetry">>(
  config: T | null | undefined,
  configDir = getConfigDir(),
): Pick<OcxConfig, "telemetry"> | null | undefined {
  if (config?.telemetry?.decision) return config;
  const pending = readTelemetryState(configDir).pendingDecision;
  if (!pending) return config;
  return { ...(config ?? {}), telemetry: structuredClone(pending) };
}

/**
 * Persist `ineligibleThroughDay = today's UTC day` and the active opt-out marker in
 * `telemetry-state.json` (atomic no-follow) and delete `telemetry-id.json` whenever an
 * `OCX_TELEMETRY` or `DO_NOT_TRACK` opt-out is observed.
 */
export function recordTelemetryEnvOptOut(configDir = getConfigDir(), now = Date.now()): void {
  const todayDay = formatUtcDay(utcMidnightMs(now));
  const state = readTelemetryState(configDir);
  if (!state.ineligibleThroughDay || state.ineligibleThroughDay < todayDay) {
    state.ineligibleThroughDay = todayDay;
  }
  state.envOptOutActiveSince ??= new Date(now).toISOString();
  writeTelemetryState(state, configDir, now);
  deleteTelemetryInstallId(configDir);
}

/**
 * End an observed env opt-out: every day up to today stays ineligible and the marker is cleared, so
 * only days strictly after today can be sent. Called by a clean shutdown of an opted-out proxy and
 * by the first tick that runs without the opt-out.
 */
export function endTelemetryEnvOptOut(configDir = getConfigDir(), now = Date.now()): void {
  const state = readTelemetryState(configDir);
  if (!state.envOptOutActiveSince) return;
  const todayDay = formatUtcDay(utcMidnightMs(now));
  if (!state.ineligibleThroughDay || state.ineligibleThroughDay < todayDay) {
    state.ineligibleThroughDay = todayDay;
  }
  state.envOptOutActiveSince = null;
  writeTelemetryState(state, configDir, now);
  deleteTelemetryInstallId(configDir);
}

export function utcMidnightMs(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function formatUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

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
  if (state.envOptOutActiveSince) {
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

  if (readTelemetryState(configDir).envOptOutActiveSince) {
    endTelemetryEnvOptOut(configDir, now);
  }
  const state = readTelemetryState(configDir);
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
    const preSendState = readTelemetryState(configDir);
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
        const freshState = readTelemetryState(configDir);
        freshState.retryAfterUntil = new Date(now + sendResult.retryAfterMs).toISOString();
        writeTelemetryState(freshState, configDir, now);
        return { sent: false, day: targetDay, reason: "retry-after-backoff", sendResult };
      }
      return { sent: false, day: targetDay, reason: "send-failed", sendResult };
    }
    markTelemetryFirstReportSent(configDir);
    const freshState = readTelemetryState(configDir);
    const nowIso = new Date(now).toISOString();
    freshState.sentDays[targetDay] = nowIso;
    freshState.everReported = true;
    freshState.lastSentDay = targetDay;
    freshState.lastSentAt = nowIso;
    freshState.retryAfterUntil = null;
    writeTelemetryState(freshState, configDir, now);
    return { sent: true, day: targetDay, reason: "sent", sendResult };
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
    activeTickControllers.delete(tickController);
  }
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

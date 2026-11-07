import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { readConfigDiagnostics } from "../config/diagnostics";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";
import { isTelemetryEnvOptOut, resolveTelemetryStatus } from "./consent";
import { computeInstallDayHash, ensureTelemetryInstallId, markTelemetryFirstReportSent } from "./install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel, type ResolveInstallChannelOptions } from "./payload";
import { sendTelemetryPayload, type TelemetrySendOptions, type TelemetrySendResult } from "./sender";

export const TELEMETRY_STATE_FILE = "telemetry-state.json";
export const TELEMETRY_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_BACKLOG_DAYS = 7;
const STATE_RETENTION_DAYS = 30;

export interface TelemetryState {
  version: 1;
  sentDays: Record<string, string>;
  lastSentDay: string | null;
  lastSentAt: string | null;
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
  };
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
    return {
      version: 1,
      sentDays,
      lastSentDay: typeof raw.lastSentDay === "string" ? raw.lastSentDay : null,
      lastSentAt: typeof raw.lastSentAt === "string" ? raw.lastSentAt : null,
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
  for (const [day, at] of Object.entries(state.sentDays)) {
    if (day >= minKeepDay) prunedSentDays[day] = at;
  }
  const payload: TelemetryState = {
    version: 1,
    sentDays: prunedSentDays,
    lastSentDay: state.lastSentDay,
    lastSentAt: state.lastSentAt,
  };
  atomicWriteFileNoFollow(path, `${JSON.stringify(payload, null, 2)}\n`);
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

export interface TelemetryTickOptions extends TelemetrySendOptions, ResolveInstallChannelOptions {
  configDir?: string;
  config?: Pick<OcxConfig, "telemetry">
  readConfig?: () => Pick<OcxConfig, "telemetry">;
  aggregateDay?: (day: string) => Promise<DailyTelemetryAggregate>;
}

export interface TelemetryTickResult {
  sent: boolean;
  day?: string;
  reason: string;
  sendResult?: TelemetrySendResult;
}

/**
 * Run one telemetry tick:
 * - Re-reads config passively from disk and re-evaluates `resolveTelemetryStatus`.
 * - Sends only completed UTC days on or after the UTC day of `decidedAt ?? noticeShownAt`
 *   (no pre-consent backfill).
 * - Sends at most ONE day per tick, oldest first, at most the last 7 completed days.
 */
export async function runTelemetryTick(options: TelemetryTickOptions = {}): Promise<TelemetryTickResult> {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? getConfigDir();
  const config = options.config
    ?? (options.readConfig ? options.readConfig() : readConfigDiagnostics({ passive: true }).config);
  const status = resolveTelemetryStatus(config, env);
  if (!status.effective) {
    return { sent: false, reason: status.reason };
  }
  const consentTimestamp = status.decidedAt ?? status.noticeShownAt;
  if (!consentTimestamp) {
    return { sent: false, reason: "missing-consent-timestamp" };
  }
  const consentMs = Date.parse(consentTimestamp);
  if (Number.isNaN(consentMs)) {
    return { sent: false, reason: "invalid-consent-timestamp" };
  }
  const consentDay = formatUtcDay(consentMs);
  const todayMs = utcMidnightMs(now);
  const state = readTelemetryState(configDir);

  let targetDay: string | null = null;
  for (let offset = MAX_BACKLOG_DAYS; offset >= 1; offset--) {
    const candidateDay = formatUtcDay(todayMs - offset * DAY_MS);
    if (candidateDay < consentDay) continue;
    if (state.sentDays[candidateDay]) continue;
    targetDay = candidateDay;
    break;
  }
  if (!targetDay) {
    return { sent: false, reason: "up-to-date" };
  }

  const { identity } = ensureTelemetryInstallId(configDir);
  const newInstall = identity.firstReportSent !== true;
  const installDayHash = computeInstallDayHash(identity.installId, targetDay);
  const aggregate = await (options.aggregateDay
    ? options.aggregateDay(targetDay)
    : aggregateTelemetryForDay(targetDay, { signal: options.signal }));
  const payload = buildTelemetryPayloadV1({
    aggregate,
    installDayHash,
    newInstall,
    now,
    installChannel: resolveInstallChannel(options),
  });
  const sendResult = await sendTelemetryPayload(payload, { ...options, now });
  if (!sendResult.ok) {
    return { sent: false, day: targetDay, reason: "send-failed", sendResult };
  }
  markTelemetryFirstReportSent(configDir);
  const nowIso = new Date(now).toISOString();
  state.sentDays[targetDay] = nowIso;
  state.lastSentDay = targetDay;
  state.lastSentAt = nowIso;
  writeTelemetryState(state, configDir, now);
  return { sent: true, day: targetDay, reason: "sent", sendResult };
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
    return () => {};
  }
  if (running) return stopTelemetryScheduler;
  running = true;
  detachShutdownHook = registerOptionalShutdownHook("telemetry", stopTelemetryScheduler);
  const startupDelay = options.startupDelayMs ?? (30_000 + Math.floor(Math.random() * 30_000));
  const intervalMs = options.intervalMs ?? TELEMETRY_TICK_INTERVAL_MS;
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
  if (!running) return;
  if (isTelemetryEnvOptOut(process.env) !== null) {
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

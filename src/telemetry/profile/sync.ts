import { readConfigDiagnostics } from "../../config/diagnostics";
import { getConfigDir } from "../../config/paths";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../../types";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "../aggregate";
import { isTelemetryEnvOptOut, resolveTelemetryStatus, type TelemetryConsentStatus } from "../consent";
import type { TelemetryModelFamily } from "../contract";
import { resolveNextEligibleTelemetryDay } from "../scheduler";
import { readTelemetryStateFile, withPendingTelemetryDecision, type TelemetryState } from "../state";
import { deleteProfile, submitProfileDay, type ProfileClientOptions } from "./client";
import { PROFILE_SCHEMA_VERSION, type ProfileDayV1, type ProfileFamilyRowV1 } from "./contract";
import {
  deleteTelemetryProfileFile,
  readTelemetryProfileFile,
  updateTelemetryProfileState,
  type TelemetryProfileState,
} from "./state";

export const PROFILE_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PROFILE_INTERVAL_JITTER_MS = 30 * 60 * 1000;
export const PROFILE_STARTUP_BASE_DELAY_MS = 2 * 60 * 1000;
export const PROFILE_STARTUP_JITTER_MS = 8 * 60 * 1000;

/**
 * The day totals a profile submits, built from the same local daily aggregate as anonymous
 * telemetry: only the request count, the five token buckets and per-family totals. Provider
 * kinds, outcomes, errors and active minutes are dropped. Null when the day had no requests.
 */
export function buildProfileDay(aggregate: DailyTelemetryAggregate): ProfileDayV1 | null {
  const byFamily = new Map<TelemetryModelFamily, ProfileFamilyRowV1>();
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let requests = 0;
  for (const row of aggregate.models) {
    if (row.requests <= 0) continue;
    const rowTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens + row.reasoningTokens;
    requests += row.requests;
    tokens.input += row.inputTokens;
    tokens.cacheRead += row.cacheReadTokens;
    tokens.cacheWrite += row.cacheWriteTokens;
    tokens.output += row.outputTokens;
    tokens.reasoning += row.reasoningTokens;
    const existing = byFamily.get(row.modelFamily);
    if (existing) {
      existing.requests += row.requests;
      existing.tokens += rowTokens;
    } else {
      byFamily.set(row.modelFamily, { family: row.modelFamily, requests: row.requests, tokens: rowTokens });
    }
  }
  if (requests === 0) return null;
  const families = [...byFamily.values()].sort((a, b) => b.tokens - a.tokens || a.family.localeCompare(b.family));
  return { schemaVersion: PROFILE_SCHEMA_VERSION, day: aggregate.day, requests, tokens, families };
}

export interface ProfileGate {
  status: TelemetryConsentStatus;
  telemetryState: TelemetryState | null;
  telemetryStateUnreadable: boolean;
}

/** Anonymous telemetry's effective state, read from disk like the anonymous scheduler does. */
export function readProfileTelemetryGate(options: {
  configDir?: string;
  env?: Record<string, string | undefined>;
  readConfig?: () => Pick<OcxConfig, "telemetry"> | undefined;
} = {}): ProfileGate {
  const configDir = options.configDir ?? getConfigDir();
  const env = options.env ?? process.env;
  const config = options.readConfig ? options.readConfig() : readConfigDiagnostics({ passive: true }).config;
  const status = resolveTelemetryStatus(withPendingTelemetryDecision(config, configDir), env);
  const file = readTelemetryStateFile(configDir);
  return { status, telemetryState: file.unreadable ? null : file.state, telemetryStateUnreadable: file.unreadable };
}

/**
 * The next day a connected profile would send: every anonymous eligibility rule (consent day,
 * env opt-out periods, the 7-day window) plus strictly after the connect day and not yet sent
 * for this profile.
 */
export function resolveNextProfileDay(
  profile: TelemetryProfileState,
  gate: ProfileGate,
  now = Date.now(),
): { day: string | null; reason: string } {
  if (!gate.status.effective) return { day: null, reason: "telemetry-off" };
  if (gate.telemetryStateUnreadable || !gate.telemetryState) return { day: null, reason: "state-unreadable" };
  const anonymousFloor = gate.telemetryState.ineligibleThroughDay;
  const ineligibleThroughDay = anonymousFloor && anonymousFloor > profile.connectedDay ? anonymousFloor : profile.connectedDay;
  return resolveNextEligibleTelemetryDay(
    gate.status,
    { ...gate.telemetryState, sentDays: profile.sentDays, ineligibleThroughDay },
    now,
  );
}

export interface ProfileTickOptions extends ProfileClientOptions {
  now?: number;
  configDir?: string;
  env?: Record<string, string | undefined>;
  readConfig?: () => Pick<OcxConfig, "telemetry"> | undefined;
  aggregateDay?: (day: string, options: { signal?: AbortSignal }) => Promise<DailyTelemetryAggregate>;
}

export interface ProfileTickResult {
  sent: boolean;
  deleted?: boolean;
  day?: string;
  reason: string;
}

/** Retry a pending deletion. Not gated on anonymous telemetry: deleting is the person's own request. */
async function retryPendingDelete(
  state: TelemetryProfileState,
  configDir: string,
  now: number,
  options: ProfileClientOptions,
): Promise<ProfileTickResult> {
  const result = await deleteProfile(state.secret, options);
  if (result.deleted) {
    // Only the file of the profile just deleted: a reconnect in the meantime has its own secret.
    const current = readTelemetryProfileFile(configDir).state;
    if (current && current.secret !== state.secret) return { sent: false, deleted: true, reason: "deleted" };
    if (!deleteTelemetryProfileFile(configDir)) return { sent: false, deleted: false, reason: "local-file-remains" };
    return { sent: false, deleted: true, reason: "deleted" };
  }
  if (result.retryAfterMs) {
    const retryAfterUntil = new Date(now + result.retryAfterMs).toISOString();
    updateTelemetryProfileState(state.secret, current => ({ ...current, retryAfterUntil }), { configDir, now, whilePendingDelete: true });
  }
  return { sent: false, deleted: false, reason: "deletion-pending" };
}

export async function runProfileTick(options: ProfileTickOptions = {}): Promise<ProfileTickResult> {
  const now = options.now ?? Date.now();
  const configDir = options.configDir ?? getConfigDir();
  const env = options.env ?? process.env;
  const file = readTelemetryProfileFile(configDir);
  if (file.unreadable) return { sent: false, reason: "state-unreadable" };
  const profile = file.state;
  if (!profile) return { sent: false, reason: "not-connected" };
  const retryUntil = profile.retryAfterUntil ? Date.parse(profile.retryAfterUntil) : Number.NaN;
  const backingOff = !Number.isNaN(retryUntil) && now < retryUntil;
  if (profile.pendingDelete) {
    if (backingOff) return { sent: false, reason: "retry-after-backoff" };
    return retryPendingDelete(profile, configDir, now, options);
  }
  if (profile.revoked) return { sent: false, reason: "revoked" };
  if (isTelemetryEnvOptOut(env) !== null) return { sent: false, reason: "telemetry-off" };
  const gate = readProfileTelemetryGate({ configDir, env, readConfig: options.readConfig });
  if (backingOff) return { sent: false, reason: "retry-after-backoff" };
  const { day, reason } = resolveNextProfileDay(profile, gate, now);
  if (!day) return { sent: false, reason };

  const aggregate = await (options.aggregateDay
    ? options.aggregateDay(day, { signal: options.signal })
    : aggregateTelemetryForDay(day, { signal: options.signal }));
  if (options.signal?.aborted) return { sent: false, day, reason: "aborted" };

  // Consent and the profile may have changed while the day was aggregated.
  const latestFile = readTelemetryProfileFile(configDir);
  const latest = latestFile.state;
  if (latestFile.unreadable || !latest || latest.pendingDelete || latest.revoked || latest.secret !== profile.secret) {
    return { sent: false, day, reason: "profile-changed" };
  }
  if (isTelemetryEnvOptOut(env) !== null) return { sent: false, day, reason: "telemetry-off" };
  const latestGate = readProfileTelemetryGate({ configDir, env, readConfig: options.readConfig });
  if (resolveNextProfileDay(latest, latestGate, now).day !== day) return { sent: false, day, reason: "eligibility-changed" };

  const nowIso = new Date(now).toISOString();
  const body = buildProfileDay(aggregate);
  if (!body) {
    updateTelemetryProfileState(latest.secret, current => ({ ...current, sentDays: { ...current.sentDays, [day]: nowIso } }), { configDir, now });
    return { sent: false, day, reason: "no-usage" };
  }
  const result = await submitProfileDay(latest.secret, body, options);
  if (!result.ok) {
    if (result.status === 401) {
      updateTelemetryProfileState(latest.secret, current => ({ ...current, revoked: true }), { configDir, now });
      return { sent: false, day, reason: "revoked" };
    }
    if (result.retryAfterMs) {
      const retryAfterUntil = new Date(now + result.retryAfterMs).toISOString();
      updateTelemetryProfileState(latest.secret, current => ({ ...current, retryAfterUntil }), { configDir, now });
      return { sent: false, day, reason: "retry-after-backoff" };
    }
    if (typeof result.status === "number" && result.status >= 400 && result.status < 500) {
      // A permanent refusal for this day (validation, too old, before the creation day): set the
      // day aside so the oldest-first order never stalls on it.
      updateTelemetryProfileState(latest.secret, current => ({ ...current, sentDays: { ...current.sentDays, [day]: `refused ${nowIso}` } }), { configDir, now });
      return { sent: false, day, reason: "refused" };
    }
    return { sent: false, day, reason: "send-failed" };
  }
  updateTelemetryProfileState(latest.secret, current => ({
    ...current,
    sentDays: { ...current.sentDays, [day]: nowIso },
    lastSentDay: day,
    lastSentAt: nowIso,
    retryAfterUntil: null,
  }), { configDir, now });
  return { sent: true, day, reason: "sent" };
}

let running = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let activeTick: Promise<ProfileTickResult> | null = null;
let activeController: AbortController | null = null;
let detachShutdownHook: (() => void) | null = null;

function triggerTick(): void {
  if (!running || activeTick) return;
  const controller = new AbortController();
  activeController = controller;
  activeTick = runProfileTick({ signal: controller.signal })
    .catch((): ProfileTickResult => ({ sent: false, reason: "tick-error" }))
    .finally(() => {
      activeTick = null;
      if (activeController === controller) activeController = null;
    });
}

/**
 * Start the profile loop. Started by the server only when a profile file exists, and by a connect;
 * independent of the anonymous scheduler so a pending deletion is retried even while anonymous
 * telemetry is off.
 */
export function startProfileScheduler(options: { startupDelayMs?: number; intervalMs?: number; random?: () => number } = {}): () => void {
  if (running) return stopProfileScheduler;
  running = true;
  const random = options.random ?? Math.random;
  detachShutdownHook = registerOptionalShutdownHook("telemetry-profile", stopProfileScheduler);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    triggerTick();
  }, options.startupDelayMs ?? PROFILE_STARTUP_BASE_DELAY_MS + Math.floor(random() * PROFILE_STARTUP_JITTER_MS));
  startupTimer.unref?.();
  intervalTimer = setInterval(triggerTick, options.intervalMs ?? PROFILE_TICK_INTERVAL_MS + Math.floor(random() * PROFILE_INTERVAL_JITTER_MS));
  intervalTimer.unref?.();
  return stopProfileScheduler;
}

export function stopProfileScheduler(): void {
  running = false;
  activeController?.abort(new Error("Profile scheduler stopped"));
  for (const timer of [startupTimer, nudgeTimer]) if (timer) clearTimeout(timer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  nudgeTimer = null;
  intervalTimer = null;
  const detach = detachShutdownHook;
  detachShutdownHook = null;
  detach?.();
}

export function isProfileSchedulerRunning(): boolean {
  return running;
}

/** Run a tick soon (after a connect or a pending disconnect), starting the loop only for a profile file that exists. */
export function nudgeProfileScheduler(): void {
  if (!running) {
    const file = readTelemetryProfileFile();
    if (!file.state && !file.unreadable) return;
    startProfileScheduler();
  }
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    triggerTick();
  }, 10);
  nudgeTimer.unref?.();
}



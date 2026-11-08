import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { OcxConfig, OcxTelemetryConfig } from "../types";
import { parseCalendarUtcDayMs } from "./contract";
import { deleteTelemetryInstallId } from "./install-id";

/**
 * `telemetry-state.json`: sent days, opt-out bookkeeping and the pending decision. Kept apart from
 * the scheduler so the server's background lifecycle can record an env opt-out without loading the
 * scheduler, aggregation, payload and sender modules.
 */

export const TELEMETRY_STATE_FILE = "telemetry-state.json";
const DAY_MS = 86_400_000;
const STATE_RETENTION_DAYS = 30;
/**
 * How often a proxy running under an env opt-out records itself again, so a state file rebuilt after
 * corruption (which forgets every owner) learns that the proxy is still opted out.
 */
export const TELEMETRY_ENV_OPT_OUT_REFRESH_MS = 6 * 60 * 60 * 1000;

/** A proxy that started under an env opt-out and has not stopped cleanly yet. */
export interface TelemetryEnvOptOutOwner {
  pid: number;
  since: string;
}
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
   * Proxies running under an env opt-out. A tick without the opt-out ends the period only once all
   * of them have exited, so a second proxy sharing the home cannot reopen days the first still covers.
   */
  envOptOutOwners?: TelemetryEnvOptOutOwner[];
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
    envOptOutOwners: [],
    pendingDecision: null,
    everReported: false,
  };
}

function parseOwners(raw: unknown): TelemetryEnvOptOutOwner[] {
  if (!Array.isArray(raw)) return [];
  const owners: TelemetryEnvOptOutOwner[] = [];
  for (const entry of raw.slice(0, 64)) {
    if (!entry || typeof entry !== "object") continue;
    const { pid, since } = entry as Record<string, unknown>;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof since === "string" && !Number.isNaN(Date.parse(since))) {
      owners.push({ pid, since });
    }
  }
  return owners;
}

function ownersAreValid(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length <= 64 && raw.every(entry => {
    if (!entry || typeof entry !== "object") return false;
    const { pid, since } = entry as Record<string, unknown>;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof since === "string" && !Number.isNaN(Date.parse(since));
  });
}

/** A held decision that is present but cannot be trusted returns "invalid", which blocks sending. */
function parsePendingDecision(raw: unknown, fileTime: Date): OcxTelemetryConfig | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const value = raw as Record<string, unknown>;
  if (value.decision !== "accepted" && value.decision !== "declined") return "invalid";
  const stamp = (key: string): string | null =>
    typeof value[key] === "string" && !Number.isNaN(Date.parse(value[key] as string)) ? (value[key] as string) : null;
  const decidedAt = stamp("decidedAt");
  if (!decidedAt) {
    // A decline needs no date to apply; dropping it could let a notice-only config send.
    if (value.decision !== "declined") return "invalid";
    const at = stamp("noticeShownAt") ?? fileTime.toISOString();
    return { decision: "declined", decidedAt: at, noticeShownAt: at };
  }
  return { decision: value.decision, decidedAt, noticeShownAt: stamp("noticeShownAt") ?? decidedAt };
}

/**
 * Read the state, noting whether a file exists but cannot be trusted (a symlink, oversized or
 * malformed, or with an opt-out field that is present but invalid). Such a file must not be read as
 * empty: that would forget opt-out days. Only a file that does not exist reads as empty.
 */
export function readTelemetryStateFile(configDir = getConfigDir()): { state: TelemetryState; unreadable: boolean } {
  const path = telemetryStatePath(configDir);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return { state: emptyState(), unreadable: !missing };
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { state: emptyState(), unreadable: true };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw?.version !== 1 || !raw.sentDays || typeof raw.sentDays !== "object" || Array.isArray(raw.sentDays)) {
      return { state: emptyState(), unreadable: true };
    }
    const sentDays: Record<string, string> = {};
    for (const [day, at] of Object.entries(raw.sentDays as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof at === "string") {
        sentDays[day] = at;
      }
    }
    // Opt-out fields may be absent or null; present but invalid means the file cannot be trusted.
    const present = (value: unknown) => value !== undefined && value !== null;
    if (present(raw.ineligibleThroughDay)
      && !(typeof raw.ineligibleThroughDay === "string" && parseCalendarUtcDayMs(raw.ineligibleThroughDay) !== null)) {
      return { state: emptyState(), unreadable: true };
    }
    if (present(raw.envOptOutActiveSince)
      && !(typeof raw.envOptOutActiveSince === "string" && !Number.isNaN(Date.parse(raw.envOptOutActiveSince)))) {
      return { state: emptyState(), unreadable: true };
    }
    if (present(raw.envOptOutOwners) && !ownersAreValid(raw.envOptOutOwners)) {
      return { state: emptyState(), unreadable: true };
    }
    const pendingDecision = parsePendingDecision(raw.pendingDecision, stat.mtime);
    if (pendingDecision === "invalid") return { state: emptyState(), unreadable: true };
    const ineligibleThroughDay = typeof raw.ineligibleThroughDay === "string" ? raw.ineligibleThroughDay : null;
    const retryAfterUntil =
      typeof raw.retryAfterUntil === "string" && !Number.isNaN(Date.parse(raw.retryAfterUntil))
        ? raw.retryAfterUntil
        : null;
    const envOptOutActiveSince = typeof raw.envOptOutActiveSince === "string" ? raw.envOptOutActiveSince : null;
    return { unreadable: false, state: {
      version: 1,
      sentDays,
      lastSentDay: typeof raw.lastSentDay === "string" ? raw.lastSentDay : null,
      lastSentAt: typeof raw.lastSentAt === "string" ? raw.lastSentAt : null,
      ineligibleThroughDay,
      retryAfterUntil,
      envOptOutActiveSince,
      envOptOutOwners: parseOwners(raw.envOptOutOwners),
      pendingDecision,
      everReported: raw.everReported === true,
    } };
  } catch {
    return { state: emptyState(), unreadable: true };
  }
}

export function readTelemetryState(configDir = getConfigDir()): TelemetryState {
  return readTelemetryStateFile(configDir).state;
}

/**
 * Read the state for a rewrite. A file that exists but cannot be read may have held opt-out days
 * or sent days and opted-out proxies that are still running, so the rewrite starts from "nothing
 * may be sent through the UTC day those proxies have recorded themselves again by".
 */
function readTelemetryStateForWrite(configDir: string, now: number): TelemetryState {
  const { state, unreadable } = readTelemetryStateFile(configDir);
  if (unreadable) extendIneligibleThroughToday(state, now + TELEMETRY_ENV_OPT_OUT_REFRESH_MS);
  return state;
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
    envOptOutOwners: state.envOptOutOwners ?? [],
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
  const state = readTelemetryStateForWrite(configDir, now);
  state.pendingDecision = structuredClone(decision);
  writeTelemetryState(state, configDir, now);
}

/**
 * Drop the pending decision once a decision is written into `config.json`. A person's decision also
 * rebuilds an unreadable state file, which otherwise pauses sending for good.
 */
export function clearPendingTelemetryDecision(configDir = getConfigDir(), now = Date.now()): void {
  const { state: current, unreadable } = readTelemetryStateFile(configDir);
  if (unreadable) {
    // Best effort: the decision is already saved. If the rebuild fails, the file stays unreadable,
    // which keeps sending blocked.
    try {
      const rebuilt = readTelemetryStateForWrite(configDir, now);
      rebuilt.pendingDecision = null;
      writeTelemetryState(rebuilt, configDir, now);
    } catch { /* keep the unreadable file */ }
    return;
  }
  if (!current.pendingDecision) return;
  current.pendingDecision = null;
  writeTelemetryState(current, configDir, now);
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function extendIneligibleThroughToday(state: TelemetryState, now: number): void {
  const todayDay = formatUtcDay(utcMidnightMs(now));
  if (!state.ineligibleThroughDay || state.ineligibleThroughDay < todayDay) {
    state.ineligibleThroughDay = todayDay;
  }
}

/**
 * Persist `ineligibleThroughDay = today's UTC day` and the active opt-out marker in
 * `telemetry-state.json` (atomic no-follow) and delete `telemetry-id.json` whenever an
 * `OCX_TELEMETRY` or `DO_NOT_TRACK` opt-out is observed. A proxy that runs under the opt-out
 * passes its pid as `owner`; a one-off observation (a CLI command, a tick) passes none.
 */
export function recordTelemetryEnvOptOut(configDir = getConfigDir(), now = Date.now(), owner?: number): void {
  const state = readTelemetryStateForWrite(configDir, now);
  extendIneligibleThroughToday(state, now);
  if (owner === undefined) {
    state.envOptOutActiveSince ??= new Date(now).toISOString();
  } else {
    // Drop owners that have exited (their days through today are covered above) and stay within the
    // 64 entries a reader accepts.
    const owners = (state.envOptOutOwners ?? [])
      .filter(entry => entry.pid !== owner && isProcessAlive(entry.pid))
      .slice(-63);
    state.envOptOutOwners = [...owners, { pid: owner, since: new Date(now).toISOString() }];
  }
  writeTelemetryState(state, configDir, now);
  deleteTelemetryInstallId(configDir);
}

/**
 * Close an env opt-out period so only days strictly after today can be sent. A clean stop of an
 * opted-out proxy passes its pid and always covers its stop day. A tick passes none: it ends the
 * period only when no recorded opted-out proxy is still running, and otherwise extends
 * `ineligibleThroughDay` to today. Returns true while an opted-out proxy is still running.
 */
export function endTelemetryEnvOptOut(configDir = getConfigDir(), now = Date.now(), owner?: number): boolean {
  const state = readTelemetryStateForWrite(configDir, now);
  const recorded = state.envOptOutOwners ?? [];
  const others = owner === undefined ? recorded : recorded.filter(entry => entry.pid !== owner);
  const running = others.filter(entry => isProcessAlive(entry.pid));
  if (owner === undefined && !state.envOptOutActiveSince && recorded.length === 0) return false;
  extendIneligibleThroughToday(state, now);
  state.envOptOutOwners = running;
  if (running.length === 0) state.envOptOutActiveSince = null;
  writeTelemetryState(state, configDir, now);
  deleteTelemetryInstallId(configDir);
  return running.length > 0;
}


export function utcMidnightMs(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function formatUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

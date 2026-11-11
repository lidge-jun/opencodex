/**
 * The checked Windows stop's deadline (#7771, 030 "Time budget"). Kept free of the stop
 * machinery because the CLI dispatcher, which loads on every command, records it.
 *
 * ocx stop reads --deadline-ms <n> or OCX_STOP_DEADLINE_MS (the flag wins; an empty or
 * invalid variable counts as absent); every other caller uses 60 s. The deadline is
 * measured from this process's start: performance.now() counts from performance.timeOrigin,
 * so N ms after process start is the clock value N on the Part A clock.
 */
import { DEFAULT_WINDOWS_STOP_DEADLINE_MS } from "./windows-stop-budget";

export const STOP_DEADLINE_ENV = "OCX_STOP_DEADLINE_MS";

/** A positive decimal integer of milliseconds, or null (absent, empty or invalid). */
export function parseStopDeadlineMs(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The flag wins; an empty or invalid variable is absent; neither means 60 s. */
export function resolveStopDeadlineMs(flagMs: number | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof flagMs === "number" && Number.isSafeInteger(flagMs) && flagMs > 0) return flagMs;
  return parseStopDeadlineMs(env[STOP_DEADLINE_ENV]) ?? DEFAULT_WINDOWS_STOP_DEADLINE_MS;
}

let stopDeadlineMs: number | null = null;

/** ocx stop records its resolved deadline here once its arguments are parsed. */
export function setStopDeadlineMs(ms: number | null): void {
  stopDeadlineMs = ms;
}

/** The absolute deadline on the Part A clock (ms since process start). */
export function windowsStopDeadlineAt(): number {
  return stopDeadlineMs ?? DEFAULT_WINDOWS_STOP_DEADLINE_MS;
}

/**
 * The checked Windows stop's deadline (#7771, 030 "Time budget"). Kept free of the stop
 * machinery because the CLI dispatcher, which loads on every command, records it.
 *
 * ocx stop reads --deadline-ms <n> or OCX_STOP_DEADLINE_MS (the flag wins; an empty or
 * invalid variable counts as absent) and records the resolved budget as a command-start
 * deadline: performance.now() counts from performance.timeOrigin, so N ms of budget at
 * command start is the Part A clock value N. Every other caller starts the default 60 s
 * when its stop phase begins, not when the process did -- installFreshWindowsSchedulerSafely
 * reaches the stop only after registration and the UAC prompt, so measuring from process
 * start would refuse `unverified-budget` a stop that had its whole budget left.
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

/** ocx stop's command-start deadline, or null while no command recorded one. */
let commandDeadlineMs: number | null = null;
/** The unconfigured caller's deadline, armed once when its stop phase first asks. */
let phaseDeadlineAt: number | null = null;

/**
 * ocx stop records its resolved deadline here once its arguments are parsed. A new value
 * is an absolute command-start deadline; null clears it and re-arms the stop phase, so the
 * next unconfigured caller measures its own 60 s from when it gets there.
 */
export function setStopDeadlineMs(ms: number | null): void {
  commandDeadlineMs = ms;
  phaseDeadlineAt = null;
}

/**
 * The absolute deadline on the Part A clock (ms since process start). An explicit command
 * deadline wins; otherwise the first call in a stop phase arms the default 60 s and every
 * later call inside that phase keeps it -- one deadline governs the whole stop.
 */
export function windowsStopDeadlineAt(now: number = performance.now()): number {
  if (commandDeadlineMs !== null) return commandDeadlineMs;
  if (phaseDeadlineAt === null) phaseDeadlineAt = now + DEFAULT_WINDOWS_STOP_DEADLINE_MS;
  return phaseDeadlineAt;
}

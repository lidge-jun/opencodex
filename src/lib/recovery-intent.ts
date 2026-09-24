import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileAsync } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export type RecoveryIntentMode = "running" | "stopped" | "maintenance";

export interface RecoveryIntent {
  version: 1;
  mode: RecoveryIntentMode;
  at: number;
  until?: number;
}

export interface WriteRecoveryIntentOptions {
  home?: string;
  at?: number;
  until?: number;
}

const STATE_MAX_BYTES = 16 * 1024;
// The guardian reader rejects a maintenance intent outside this window, so a writer
// must not create one it would decode as `stopped`
// (scripts/ocx-recovery-guardian/main.cjs, parseIntent).
const MAINTENANCE_WINDOW_MAX_MS = 180_000;

function unsafeMarker(): never {
  throw new Error("Recovery guardian marker is malformed; manual lifecycle action was not dispatched.");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertSafeExistingFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > STATE_MAX_BYTES) unsafeMarker();
}

function assertSafeExistingDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) unsafeMarker();
}

/** True when the durable intent already reads `running`. */
function runningIntentWritten(home: string): boolean {
  try {
    const stored = JSON.parse(readFileSync(join(home, "recovery-intent.json"), "utf8")) as { mode?: unknown };
    return stored.mode === "running";
  } catch {
    return false;
  }
}

/**
 * Returns true only for a locally enabled v1 recovery guardian.  A missing or
 * explicitly disabled marker preserves ordinary installs exactly as before;
 * every other marker state rejects the lifecycle action before it can mutate
 * proxy state.
 */
export function recoveryGuardianEnabled(home: string = getConfigDir()): boolean {
  const root = resolve(home);
  const marker = join(root, "recovery-guardian.json");
  try {
    assertSafeExistingDirectory(root);
    assertSafeExistingFile(marker);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    return unsafeMarker();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unsafeMarker();
  const markerValue = parsed as { version?: unknown; enabled?: unknown };
  if (markerValue.version === 1 && markerValue.enabled === false) return false;
  if (markerValue.version !== 1 || markerValue.enabled !== true) return unsafeMarker();
  return true;
}

/**
 * The durable intent exactly as one run found it, so a refusal can put it back. An
 * unreadable file is a refusal in itself: rolling back to `absent` would delete an
 * operator's instruction that this run never wrote.
 */
export interface RecoveryIntentBackup {
  path: string;
  bytes: Buffer | null;
}

/** Read the intent before a lifecycle write, or null when this home has no guardian. */
export function backupRecoveryIntent(home = getConfigDir()): RecoveryIntentBackup | null {
  const root = resolve(home);
  if (!recoveryGuardianEnabled(root)) return null;
  const intentPath = join(root, "recovery-intent.json");
  try {
    assertSafeExistingFile(intentPath);
    return { path: intentPath, bytes: readFileSync(intentPath) };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { path: intentPath, bytes: null };
  }
}

/** Restore the bytes a refused action found, removing the file when it found none. */
export async function restoreRecoveryIntent(backup: RecoveryIntentBackup | null): Promise<boolean> {
  if (!backup) return true;
  try {
    if (backup.bytes === null) rmSync(backup.path, { force: true });
    else await atomicWriteFileAsync(backup.path, backup.bytes.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

/** Write a non-secret, bounded manual-recovery intent when the guardian opted in. */
export async function writeRecoveryIntentIfGuardianEnabled(
  mode: RecoveryIntentMode,
  options: WriteRecoveryIntentOptions = {},
): Promise<boolean> {
  const home = resolve(options.home ?? getConfigDir());
  if (!recoveryGuardianEnabled(home)) return false;
  const at = options.at ?? Date.now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Recovery intent timestamp is invalid.");
  if (mode !== "running" && mode !== "stopped" && mode !== "maintenance") {
    throw new Error("Recovery intent mode is invalid.");
  }
  if (options.until !== undefined
    && (!Number.isSafeInteger(options.until) || options.until <= at || options.until > at + MAINTENANCE_WINDOW_MAX_MS)) {
    throw new Error("Recovery intent maintenance deadline is invalid.");
  }
  if (mode !== "maintenance" && options.until !== undefined) {
    throw new Error("Only a maintenance intent may carry a deadline.");
  }
  // A maintenance intent without a deadline decodes as `stopped` in every reader, which
  // fences the whole home, so the window is mandatory here exactly as in main.cjs.
  if (mode === "maintenance" && options.until === undefined) {
    throw new Error("Recovery intent maintenance deadline is invalid.");
  }
  // The tray, the visible launcher and the proxy itself all affirm `running` for one
  // start. Each fresh signature restarts the guardian's stabilisation window, so a
  // re-affirmation must not rewrite the file.
  if (mode === "running" && runningIntentWritten(home)) return true;

  const intentPath = join(home, "recovery-intent.json");
  try {
    assertSafeExistingFile(intentPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const intent: RecoveryIntent = mode === "maintenance"
    ? { version: 1, mode, at, until: options.until }
    : { version: 1, mode, at };
  await atomicWriteFileAsync(intentPath, JSON.stringify(intent) + "\n");
  return true;
}

import { lstatSync, readFileSync } from "node:fs";
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

const MARKER_MAX_BYTES = 16 * 1024;
const INTENT_MAX_BYTES = 16 * 1024;

function unsafeMarker(): never {
  throw new Error("Recovery guardian marker is malformed; manual lifecycle action was not dispatched.");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertSafeExistingFile(path: string, maxBytes: number): ReturnType<typeof lstatSync> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) unsafeMarker();
  return stat;
}

function assertSafeExistingDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafeMarker();
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
    assertSafeExistingFile(marker, MARKER_MAX_BYTES);
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
  if (options.until !== undefined && (!Number.isSafeInteger(options.until) || options.until <= at)) {
    throw new Error("Recovery intent maintenance deadline is invalid.");
  }
  if (mode !== "maintenance" && options.until !== undefined) {
    throw new Error("Only a maintenance intent may carry a deadline.");
  }

  const intentPath = join(home, "recovery-intent.json");
  try {
    assertSafeExistingFile(intentPath, INTENT_MAX_BYTES);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const intent: RecoveryIntent = mode === "maintenance"
    ? { version: 1, mode, at, until: options.until }
    : { version: 1, mode, at };
  await atomicWriteFileAsync(intentPath, JSON.stringify(intent) + "\n");
  return true;
}

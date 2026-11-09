import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const TELEMETRY_ID_FILE = "telemetry-id.json";
export const TELEMETRY_PREVIEW_HASH_PLACEHOLDER = "0".repeat(64);

export interface TelemetryInstallIdentity {
  installId: string;
  createdAt: string;
  firstReportSent?: boolean;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOFOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
const PUBLISHED_READ_ATTEMPTS = 50;
const PUBLISHED_READ_INTERVAL_MS = 10;

let memo: { path: string; identity: TelemetryInstallIdentity } | null = null;

export function telemetryIdPath(configDir = getConfigDir()): string {
  return join(configDir, TELEMETRY_ID_FILE);
}

function parseTelemetryId(text: string): TelemetryInstallIdentity | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw?.version !== 1 || typeof raw.installId !== "string" || typeof raw.createdAt !== "string") {
      return null;
    }
    if (!UUID_V4_RE.test(raw.installId) || Number.isNaN(Date.parse(raw.createdAt))) {
      return null;
    }
    return {
      installId: raw.installId.toLowerCase(),
      createdAt: raw.createdAt,
      firstReportSent: raw.firstReportSent === true,
    };
  } catch {
    return null;
  }
}

/** Read-only: returns the persisted telemetry install identity, or null when absent/invalid. */
export function readTelemetryInstallId(configDir = getConfigDir()): TelemetryInstallIdentity | null {
  const path = telemetryIdPath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
      if (memo?.path === path) memo = null;
      return null;
    }
  } catch {
    // Another process (`ocx telemetry disable`, an env opt-out) may have deleted it: forget the memo.
    if (memo?.path === path) memo = null;
    return null;
  }
  if (memo?.path === path) return memo.identity;
  let identity: TelemetryInstallIdentity | null;
  try {
    identity = parseTelemetryId(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (identity) memo = { path, identity };
  return identity;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function createExclusive(path: string, content: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    if (process.platform !== "win32") {
      try { fchmodSync(fd, 0o600); } catch { /* best-effort */ }
    }
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dirname(path), fsConstants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best-effort */ }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function adoptPublishedIdentity(configDir: string, path: string): TelemetryInstallIdentity {
  for (let attempt = 0; attempt < PUBLISHED_READ_ATTEMPTS; attempt++) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      stat = null;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) break;
    const identity = readTelemetryInstallId(configDir);
    if (identity) return identity;
    if (attempt + 1 < PUBLISHED_READ_ATTEMPTS) pause(PUBLISHED_READ_INTERVAL_MS);
  }
  throw new Error("telemetry identity file is not a valid regular file; remove it to rotate the identity");
}

/**
 * Create `<OPENCODEX_HOME>/telemetry-id.json` (`0o600`, exclusive no-follow) on the first send.
 * Returns `{ identity, freshlyCreated }` so the caller knows when a brand-new id was minted.
 */
export function ensureTelemetryInstallId(
  configDir = getConfigDir(),
): { identity: TelemetryInstallIdentity; freshlyCreated: boolean } {
  const existing = readTelemetryInstallId(configDir);
  if (existing) return { identity: existing, freshlyCreated: false };
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = telemetryIdPath(configDir);
  try { recordOwnedConfigPath(configDir, path); } catch { /* best-effort */ }
  let present = true;
  try {
    lstatSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    present = false;
  }
  if (present) {
    return { identity: adoptPublishedIdentity(configDir, path), freshlyCreated: false };
  }
  const identity: TelemetryInstallIdentity = {
    installId: randomUUID().toLowerCase(),
    createdAt: new Date().toISOString(),
    firstReportSent: false,
  };
  const content = `${JSON.stringify({ version: 1, ...identity })}\n`;
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let published = false;
  try {
    createExclusive(temp, content);
    try {
      linkSync(temp, path);
      published = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") {
        return { identity: adoptPublishedIdentity(configDir, path), freshlyCreated: false };
      }
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* best-effort */ }
  }
  if (!published) {
    try {
      createExclusive(path, content);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return { identity: adoptPublishedIdentity(configDir, path), freshlyCreated: false };
    }
  }
  syncParentDirectory(path);
  memo = { path, identity };
  return { identity, freshlyCreated: true };
}

/** Mark `firstReportSent: true` inside `<OPENCODEX_HOME>/telemetry-id.json` after the first report succeeds. */
export function markTelemetryFirstReportSent(configDir = getConfigDir()): void {
  const existing = readTelemetryInstallId(configDir);
  if (!existing || existing.firstReportSent === true) return;
  const path = telemetryIdPath(configDir);
  const updated: TelemetryInstallIdentity = {
    installId: existing.installId,
    createdAt: existing.createdAt,
    firstReportSent: true,
  };
  try { recordOwnedConfigPath(configDir, path); } catch { /* best-effort */ }
  atomicWriteFileNoFollow(path, `${JSON.stringify({ version: 1, ...updated })}\n`);
  memo = { path, identity: updated };
}

/** Delete `<OPENCODEX_HOME>/telemetry-id.json` when telemetry is declined. */
export function deleteTelemetryInstallId(configDir = getConfigDir()): boolean {
  const path = telemetryIdPath(configDir);
  if (memo?.path === path) memo = null;
  let deleted = false;
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      unlinkSync(path);
      deleted = true;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") deleted = false;
  }
  return deleted;
}

export function computeInstallDayHash(installId: string, day: string): string {
  return createHash("sha256").update(`${installId}:${day}`).digest("hex");
}

export function resetTelemetryInstallIdMemoForTests(): void {
  memo = null;
}

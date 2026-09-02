import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFile } from "../config/atomic-write";

const MAX_SERVICE_API_TOKEN_BYTES = 4096;

export interface PersistedServiceApiToken {
  path: string;
  fingerprint: string;
}

export type ServiceApiTokenState =
  | { kind: "absent" }
  | { kind: "present"; token: string; fingerprint: string }
  | { kind: "unsafe"; reason: string };

export function serviceApiTokenFilePath(): string {
  return join(getConfigDir(), "service-api-token");
}

export function serviceApiTokenBackupPath(): string {
  return `${serviceApiTokenFilePath()}.prev`;
}

export function serviceApiTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readServiceApiTokenState(): ServiceApiTokenState {
  const path = serviceApiTokenFilePath();
  if (!existsSync(path)) return { kind: "absent" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "unsafe", reason: "service token path could not be inspected" };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SERVICE_API_TOKEN_BYTES) {
    return { kind: "unsafe", reason: "service token path is not a bounded regular file" };
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!token) return { kind: "unsafe", reason: "service token file is empty" };
    return { kind: "present", token, fingerprint: serviceApiTokenFingerprint(token) };
  } catch {
    return { kind: "unsafe", reason: "service token file could not be read" };
  }
}

export function writeServiceApiTokenFile(token: string): PersistedServiceApiToken {
  const value = token.trim();
  if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_SERVICE_API_TOKEN_BYTES) {
    throw new Error("refusing to persist an invalid service API token");
  }
  const path = serviceApiTokenFilePath();
  const existing = readServiceApiTokenState();
  if (existing.kind !== "absent") {
    throw new Error(existing.kind === "unsafe"
      ? existing.reason
      : "refusing to replace a pre-existing service API token");
  }
  atomicWriteFile(path, `${value}\n`);
  return { path, fingerprint: serviceApiTokenFingerprint(value) };
}

function fsyncRegularFile(path: string): void {
  // "r+", not "r": Windows rejects fsync on a read-only handle with EPERM, so a read-only
  // open turned every token backup/replace/restore into a hard failure there.
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function validatedTokenValue(token: string): string {
  const value = token.trim();
  if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_SERVICE_API_TOKEN_BYTES) {
    throw new Error("refusing to persist an invalid service API token");
  }
  return value;
}

export function replaceServiceApiTokenFile(token: string): PersistedServiceApiToken {
  const value = validatedTokenValue(token);
  const current = readServiceApiTokenState();
  if (current.kind !== "present") {
    throw new Error(current.kind === "unsafe" ? current.reason : "service token file is missing");
  }
  const path = serviceApiTokenFilePath();
  atomicWriteFile(path, `${value}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: serviceApiTokenFingerprint(value) };
}

export function readTokenBackupState(): ServiceApiTokenState {
  const path = serviceApiTokenBackupPath();
  if (!existsSync(path)) return { kind: "absent" };
  let stat;
  try { stat = lstatSync(path); }
  catch { return { kind: "unsafe", reason: "service token backup could not be inspected" }; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SERVICE_API_TOKEN_BYTES
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    return { kind: "unsafe", reason: "service token backup is not an owner-only bounded regular file" };
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    if (!token || /[\r\n\0]/.test(token)) return { kind: "unsafe", reason: "service token backup is invalid" };
    return { kind: "present", token, fingerprint: serviceApiTokenFingerprint(token) };
  } catch {
    return { kind: "unsafe", reason: "service token backup could not be read" };
  }
}

export function writeTokenBackup(expectedFingerprint: string): PersistedServiceApiToken {
  const current = readServiceApiTokenState();
  if (current.kind !== "present" || current.fingerprint !== expectedFingerprint) {
    throw new Error(current.kind === "unsafe" ? current.reason : "service token ownership changed before backup");
  }
  const existing = readTokenBackupState();
  if (existing.kind !== "absent") {
    throw new Error(existing.kind === "unsafe" ? existing.reason : "service token backup already exists");
  }
  const path = serviceApiTokenBackupPath();
  atomicWriteFile(path, `${current.token}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: current.fingerprint };
}

export function restoreTokenBackup(expectedPath: string): PersistedServiceApiToken {
  if (expectedPath !== serviceApiTokenBackupPath()) throw new Error("service token backup path mismatch");
  const backup = readTokenBackupState();
  if (backup.kind !== "present") {
    throw new Error(backup.kind === "unsafe" ? backup.reason : "service token backup is missing");
  }
  const path = serviceApiTokenFilePath();
  atomicWriteFile(path, `${backup.token}\n`);
  fsyncRegularFile(path);
  return { path, fingerprint: backup.fingerprint };
}

export function removeOrphanTokenBackup(): "removed" | "absent" {
  const backup = readTokenBackupState();
  if (backup.kind === "absent") return "absent";
  if (backup.kind === "unsafe") throw new Error(backup.reason);
  try {
    unlinkSync(serviceApiTokenBackupPath());
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("service token backup could not be removed", { cause: error });
  }
}

export function removeServiceApiTokenFileIfOwned(
  expectedFingerprint: string,
): "removed" | "absent" | "changed" {
  const state = readServiceApiTokenState();
  if (state.kind === "absent") return "absent";
  if (state.kind !== "present" || state.fingerprint !== expectedFingerprint) return "changed";
  try {
    unlinkSync(serviceApiTokenFilePath());
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("owned service API token could not be removed", { cause: error });
  }
}

/**
 * App-side service token loading (WinSW native mode has no batch wrapper to read the
 * token file into the environment). Pure: returns the token or null — the CALLER
 * assigns it to process.env.OPENCODEX_API_AUTH_TOKEN. Loads only when the env token
 * is empty and OCX_API_TOKEN_FILE names a readable file.
 */
export function loadServiceTokenFromFile(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const file = env.OCX_API_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Contents of the installed service token file. The launch wrapper always re-exports
 * this file as OPENCODEX_API_AUTH_TOKEN, so doctor and start must inspect it even
 * when the calling shell has no data-plane env var.
 * Returns the token or null — never throws, never logs the value.
 */
export function readInstalledServiceToken(): string | null {
  try {
    const token = readFileSync(serviceApiTokenFilePath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

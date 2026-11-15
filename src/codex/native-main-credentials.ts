import { closeSync, constants as fsConstants, fstatSync, openSync } from "node:fs";
import { readNativeMainAuthBytesWithIdentity } from "./native-main-auth-file";
import { codexCredentialMutationEpoch } from "./credential-mutation-epoch";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity";

/**
 * Retention of the last complete native-main login while Codex rewrites its login file (#7345).
 *
 * Codex rewrites the file in place (truncate, then write), so a reader can briefly see it empty
 * or half written. The owner's contract: only those two states may be answered from the last
 * complete login, and only while it is still provably the same owner's same file. Everything
 * else is authoritative and ends retention at once, with no time window to wait out:
 *
 * - a missing file (logout or deletion; Codex may still confirm a login through its own RPC,
 *   which the caller asks separately),
 * - a well-formed file without a ChatGPT token pair (explicit no-login or an API-key login),
 * - an unreadable file,
 * - account replacement (another OpenCodex credential publication, a different file identity,
 *   or a complete file naming a different login),
 * - pause or revocation of the main account,
 * - a change of the selected or configured refresh owner,
 * - ownership loss (another home or path, the cross-process owner lock released, or native-main
 *   traffic blocked by recovery).
 *
 * File identity is only meaningful while its inode number cannot be reused: on POSIX the retained
 * entry keeps a descriptor open on the file it was read from, so a deleted and recreated file
 * always gets a new number, and a retained file that is no longer linked is never served.
 *
 * Retention never serves a write guard: callers that compare the file before publishing read the
 * physical observation. It also never vouches for an expired access token; that goes to the
 * selected refresh owner exactly as an unavailable file would.
 */

export type NativeMainAuthObservation =
  | {
    kind: "complete";
    raw: string;
    root: Record<string, unknown>;
    tokens: Record<string, unknown>;
    /** dev/ino of the file the bytes came from, or null when it changed during the read. */
    identity: FileIdentity | null;
  }
  /** Empty or not yet parseable: the in-place rewrite window. */
  | { kind: "incomplete"; identity: FileIdentity | null }
  /** Well-formed but carries no ChatGPT access or refresh token. */
  | { kind: "no-login" }
  | { kind: "missing" }
  | { kind: "unreadable" };

export type NativeMainRetentionInvalidation =
  | "logout"
  | "missing"
  | "unreadable"
  | "account-replacement"
  | "pause"
  | "revocation"
  | "refresh-mode-change"
  | "ownership-loss";

export interface NativeMainLoginOwner {
  readonly codexHome: string;
  readonly path: string;
}

/** Captured before an observation starts; a completion under an older generation is stale. */
export interface NativeMainObservationTicket {
  readonly generation: number;
}

export interface RetainNativeMainLoginOptions {
  /** Content fingerprint; an unchanged login keeps its entry, descriptor and configured mode. */
  fingerprint: string;
  /** The configured refresh owner, read only when a new login is retained. */
  configuredRefreshMode: () => string;
}

interface RetainedLogin {
  readonly owner: NativeMainLoginOwner;
  readonly identity: FileIdentity;
  readonly fingerprint: string;
  readonly configuredRefreshMode: string;
  readonly fd: number | undefined;
  mutationEpoch: number;
  credential: unknown;
}

let retained: RetainedLogin | undefined;
let generation = 0;
let lastRefreshMode: string | undefined;
let lastInvalidation: NativeMainRetentionInvalidation | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try { closeSync(fd); } catch { /* already closed */ }
}

function drop(): void {
  const entry = retained;
  retained = undefined;
  closeQuietly(entry?.fd);
}

/** Classify login file text. A truncated JSON object never parses, so a partial write is "incomplete". */
export function classifyNativeMainAuthText(raw: string, identity: FileIdentity | null = null): NativeMainAuthObservation {
  if (!raw.trim()) return { kind: "incomplete", identity };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "incomplete", identity };
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) return { kind: "no-login" };
  if (!nonEmptyString(parsed.tokens.access_token) && !nonEmptyString(parsed.tokens.refresh_token)) {
    return { kind: "no-login" };
  }
  return { kind: "complete", raw, root: parsed, tokens: parsed.tokens, identity };
}

function missingOrUnreadable(error: unknown): NativeMainAuthObservation {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
}

/**
 * One physical observation through the #7918 reader. The bytes come from its plain read and the
 * identity from a stat before and after it; a replacement during the read leaves the identity null,
 * so nothing is retained or served for those bytes.
 */
export function observeNativeMainAuthFile(path: string): NativeMainAuthObservation {
  let read: ReturnType<typeof readNativeMainAuthBytesWithIdentity>;
  try {
    read = readNativeMainAuthBytesWithIdentity(path);
  } catch (error) {
    return missingOrUnreadable(error);
  }
  return classifyNativeMainAuthText(read.bytes.toString("utf8"), read.identity);
}

export function beginNativeMainObservation(): NativeMainObservationTicket {
  return { generation };
}

/** End retention now. Pending observations captured before this call can no longer retain. */
export function invalidateRetainedNativeMainLogin(reason: NativeMainRetentionInvalidation): void {
  generation += 1;
  drop();
  lastInvalidation = reason;
}

/** Hold the file's inode on POSIX so its number cannot be reused while retained. */
function holdFile(path: string, identity: FileIdentity): number | undefined | null {
  if (process.platform === "win32") return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const held = fstatSync(fd, { bigint: true });
    if (held.isFile() && sameFileIdentity({ dev: held.dev, ino: held.ino }, identity)) return fd;
  } catch { /* the file moved; nothing to hold */ }
  closeQuietly(fd);
  return null;
}

/**
 * Record a complete login. Refused for a stale ticket (an invalidation happened while the
 * observation or refresh was in flight) or an unknown or moved file identity.
 */
export function retainNativeMainLogin(
  ticket: NativeMainObservationTicket,
  owner: NativeMainLoginOwner,
  identity: FileIdentity | null,
  credential: unknown,
  options: RetainNativeMainLoginOptions,
): boolean {
  if (ticket.generation !== generation) return false;
  if (!identity) {
    drop();
    return false;
  }
  const current = retained;
  if (current && current.owner.codexHome === owner.codexHome && current.owner.path === owner.path
    && sameFileIdentity(current.identity, identity) && current.fingerprint === options.fingerprint) {
    current.mutationEpoch = codexCredentialMutationEpoch();
    current.credential = credential;
    return true;
  }
  drop();
  const fd = holdFile(owner.path, identity);
  if (fd === null) return false;
  retained = {
    owner: { codexHome: owner.codexHome, path: owner.path },
    identity,
    fingerprint: options.fingerprint,
    configuredRefreshMode: options.configuredRefreshMode(),
    fd,
    mutationEpoch: codexCredentialMutationEpoch(),
    credential,
  };
  return true;
}

function heldFileStillLinked(fd: number | undefined): boolean {
  if (fd === undefined) return true;
  try {
    return fstatSync(fd, { bigint: true }).nlink > 0n;
  } catch {
    return false;
  }
}

/**
 * The retained login for an incomplete observation of the same owner's same file, or undefined.
 * Any mismatch is itself authoritative and ends retention. `configuredRefreshMode` is read only
 * when a retained login exists.
 */
export function retainedNativeMainLogin<T>(
  owner: NativeMainLoginOwner,
  identity: FileIdentity | null,
  configuredRefreshMode: () => string,
): T | undefined {
  const entry = retained;
  if (!entry) return undefined;
  if (entry.owner.codexHome !== owner.codexHome || entry.owner.path !== owner.path) {
    invalidateRetainedNativeMainLogin("ownership-loss");
    return undefined;
  }
  if (entry.mutationEpoch !== codexCredentialMutationEpoch() || !identity
    || !sameFileIdentity(identity, entry.identity) || !heldFileStillLinked(entry.fd)) {
    invalidateRetainedNativeMainLogin("account-replacement");
    return undefined;
  }
  if (configuredRefreshMode() !== entry.configuredRefreshMode) {
    invalidateRetainedNativeMainLogin("refresh-mode-change");
    return undefined;
  }
  return entry.credential as T;
}

/** The authoritative invalidation an observation implies, if any. */
export function invalidationForObservation(observation: NativeMainAuthObservation): NativeMainRetentionInvalidation | undefined {
  if (observation.kind === "missing") return "missing";
  if (observation.kind === "no-login") return "logout";
  if (observation.kind === "unreadable") return "unreadable";
  return undefined;
}

/** Every resolution of the refresh owner reports here; a different owner ends retention. */
export function observeNativeMainRefreshMode(mode: string): void {
  if (lastRefreshMode !== undefined && lastRefreshMode !== mode) invalidateRetainedNativeMainLogin("refresh-mode-change");
  lastRefreshMode = mode;
}

/** Diagnostic for tests: why retention last ended. */
export function lastNativeMainRetentionInvalidationForTests(): NativeMainRetentionInvalidation | undefined {
  return lastInvalidation;
}

export function resetNativeMainRetentionForTests(): void {
  drop();
  generation += 1;
  lastRefreshMode = undefined;
  lastInvalidation = undefined;
}

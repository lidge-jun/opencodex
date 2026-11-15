import { readNativeMainAuthBytes } from "./native-main-auth-file";
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
 * - a change of the selected refresh owner,
 * - ownership loss (another home or path, the cross-process owner lock released, or native-main
 *   traffic blocked by recovery).
 *
 * Retention never serves a write guard: callers that compare the file before publishing read the
 * physical observation. It also never vouches for an expired access token; that goes to the
 * selected refresh owner exactly as an unavailable file would.
 */

export type NativeMainAuthObservation =
  | { kind: "complete"; raw: string; root: Record<string, unknown>; tokens: Record<string, unknown> }
  /** Empty or not yet parseable: the in-place rewrite window. */
  | { kind: "incomplete" }
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

interface RetainedLogin {
  readonly owner: NativeMainLoginOwner;
  readonly identity: FileIdentity;
  readonly mutationEpoch: number;
  readonly credential: unknown;
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

/** Classify login file text. A truncated JSON object never parses, so a partial write is "incomplete". */
export function classifyNativeMainAuthText(raw: string): NativeMainAuthObservation {
  if (!raw.trim()) return { kind: "incomplete" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "incomplete" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) return { kind: "no-login" };
  if (!nonEmptyString(parsed.tokens.access_token) && !nonEmptyString(parsed.tokens.refresh_token)) {
    return { kind: "no-login" };
  }
  return { kind: "complete", raw, root: parsed, tokens: parsed.tokens };
}

/** One physical observation through the #7918 reader. */
export function observeNativeMainAuthFile(path: string): NativeMainAuthObservation {
  let raw: string;
  try {
    raw = readNativeMainAuthBytes(path, "plain").toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }
  return classifyNativeMainAuthText(raw);
}

export function beginNativeMainObservation(): NativeMainObservationTicket {
  return { generation };
}

/** End retention now. Pending observations captured before this call can no longer retain. */
export function invalidateRetainedNativeMainLogin(reason: NativeMainRetentionInvalidation): void {
  generation += 1;
  retained = undefined;
  lastInvalidation = reason;
}

/**
 * Record a complete login. Refused for a stale ticket (an invalidation happened while the
 * observation or refresh was in flight) or an unknown file identity, which cannot be vouched for.
 */
export function retainNativeMainLogin(
  ticket: NativeMainObservationTicket,
  owner: NativeMainLoginOwner,
  identity: FileIdentity | null,
  credential: unknown,
): boolean {
  if (ticket.generation !== generation) return false;
  if (!identity) {
    retained = undefined;
    return false;
  }
  retained = {
    owner: { codexHome: owner.codexHome, path: owner.path },
    identity,
    mutationEpoch: codexCredentialMutationEpoch(),
    credential,
  };
  return true;
}

/**
 * The retained login for an incomplete observation of the same owner's same file, or undefined.
 * Any mismatch is itself authoritative and ends retention.
 */
export function retainedNativeMainLogin<T>(owner: NativeMainLoginOwner, identity: FileIdentity | null): T | undefined {
  const entry = retained;
  if (!entry) return undefined;
  if (entry.owner.codexHome !== owner.codexHome || entry.owner.path !== owner.path) {
    invalidateRetainedNativeMainLogin("ownership-loss");
    return undefined;
  }
  if (entry.mutationEpoch !== codexCredentialMutationEpoch() || !identity || !sameFileIdentity(identity, entry.identity)) {
    invalidateRetainedNativeMainLogin("account-replacement");
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
  retained = undefined;
  generation += 1;
  lastRefreshMode = undefined;
  lastInvalidation = undefined;
}

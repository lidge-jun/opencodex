import type { StoredAccountQuota } from "./quota";
import { truncateRetainedUtf8 } from "../lib/admission";

const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;

export interface MainAccountInfo {
  email: string | null;
  plan: string | null;
  quota: Omit<StoredAccountQuota, "updatedAt"> | null;
}

export interface CachedMainAccountInfo extends MainAccountInfo {
  ts: number;
}

export type MainAccountAuthStatus = "authenticated" | "logged-out" | "unavailable";
export type MainAccountCredentialSource = "auth-file" | "codex-managed";

export type MainAccountCredentialState =
  | { status: "authenticated"; source: MainAccountCredentialSource }
  | { status: "logged-out" | "unavailable" };

let cachedMainAccountInfo: CachedMainAccountInfo | null = null;
let cachedMainCredentialState: MainAccountCredentialState | null = null;
// Identity only; never a bearer or refresh token. This lets a successful native Codex request
// replace stale display/quota metadata when the keyring login changes accounts.
let cachedCodexManagedAccountId: string | null = null;
let mainAccountIdentityGeneration = 0;

export function captureMainAccountIdentityGeneration(): number {
  return mainAccountIdentityGeneration;
}

export function isMainAccountIdentityGenerationLive(generation: number): boolean {
  return generation === mainAccountIdentityGeneration;
}

export function getMainAccountInfoCache(): CachedMainAccountInfo | null {
  return cachedMainAccountInfo;
}

export function setMainAccountInfoCache(value: CachedMainAccountInfo): void {
  cachedMainAccountInfo = {
    ...value,
    email: value.email === null ? null : truncateRetainedUtf8(value.email, MAX_DIAGNOSTIC_VALUE_BYTES),
    plan: value.plan === null ? null : truncateRetainedUtf8(value.plan, MAX_DIAGNOSTIC_VALUE_BYTES),
  };
}

export function clearMainAccountInfoCache(): void {
  cachedMainAccountInfo = null;
  mainAccountIdentityGeneration += 1;
}

/**
 * Commit metadata proven by a successful request carrying Codex's keyring-owned credential.
 * Returns true when the observed account identity changed.
 */
export function setCodexManagedMainAccountObservation(value: {
  accountId: string | null;
  email: string | null;
  plan: string | null;
  ts?: number;
}): boolean {
  const accountId = value.accountId
    ? truncateRetainedUtf8(value.accountId, MAX_DIAGNOSTIC_VALUE_BYTES)
    : null;
  // The first request-scoped identity in this process is an identity boundary too: any main
  // metadata/quota already in memory may belong to an earlier file-backed login. Once a managed
  // identity is known, subsequent requests for the same id preserve its cache normally.
  const identityChanged = accountId !== null
    && (cachedCodexManagedAccountId === null
      || cachedCodexManagedAccountId !== accountId);
  if (identityChanged) {
    cachedMainAccountInfo = null;
    mainAccountIdentityGeneration += 1;
  }
  cachedCodexManagedAccountId = accountId;
  const prior = cachedMainAccountInfo;
  setMainAccountInfoCache({
    email: value.email ?? prior?.email ?? null,
    plan: value.plan ?? prior?.plan ?? null,
    quota: identityChanged ? null : (prior?.quota ?? null),
    ts: value.ts ?? Date.now(),
  });
  cachedMainCredentialState = { status: "authenticated", source: "codex-managed" };
  return identityChanged;
}

/** Last credential state observed while native-main ownership was held. */
export function getMainAccountCredentialPresence(): boolean | null {
  if (cachedMainCredentialState?.status === "authenticated") return true;
  if (cachedMainCredentialState?.status === "logged-out") return false;
  return null;
}

export function setMainAccountCredentialPresence(present: boolean): void {
  cachedMainCredentialState = present
    ? { status: "authenticated", source: "auth-file" }
    : { status: "logged-out" };
}

export function getMainAccountCredentialState(): MainAccountCredentialState | null {
  return cachedMainCredentialState;
}

export function setMainAccountCredentialState(state: MainAccountCredentialState): void {
  cachedMainCredentialState = state;
}

export function clearMainAccountCredentialPresence(): void {
  cachedMainCredentialState = null;
  cachedCodexManagedAccountId = null;
}

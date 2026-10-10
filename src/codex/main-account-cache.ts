import { publishDecisionQuotaRoster, withdrawDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { codexCredentialMutationEpoch } from "./credential-mutation-epoch";
import type { StoredAccountQuota } from "./quota-types";
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

let cachedMainAccountInfo: CachedMainAccountInfo | null = null;
let cachedMainCredentialPresence: boolean | null = null;
let mainAccountIdentityGeneration = 0;
let observedMainQuotaIdentityKey: string | undefined;
const mainQuotaCredentialKey = randomBytes(32);
let mainQuotaCredential: { bearerHmac: Buffer; writer: MainQuotaWriter } | undefined;
let mainQuotaCredentialGeneration = 0;
let mainDecisionCredentialUsable = true;
/** Existing physical credential owner supplies terminal grant/usability observations. */
export function observeMainDecisionCredentialUsable(usable: boolean): void {
  mainDecisionCredentialUsable = usable;
  publishMainDecisionRoster();
}

/** Process-local transition fence; no credential material or persisted identity. */
export function getMainQuotaCredentialGeneration(): number { return mainQuotaCredentialGeneration; }

export type MainQuotaWriter = Readonly<{ identityKey: string; identityGeneration: number }>;
const decisionWriterGenerations = new WeakMap<MainQuotaWriter, number>();
/** Return the credential generation a main quota writer was captured under, or undefined once that writer is stale or its credential generation has moved. */
export function mainDecisionQuotaWriterGeneration(writer: MainQuotaWriter): number | undefined {
  const generation = decisionWriterGenerations.get(writer);
  return generation === mainQuotaCredentialGeneration && isMainQuotaWriterLive(writer) ? generation : undefined;
}

function mainQuotaIdentityKey(accountId: string): string {
  return createHash("sha256").update("opencodex-main-quota-v1\0").update(accountId).digest("hex");
}

/** Only an existing owned physical-identity read may publish this observation. */
export function observeMainQuotaIdentity(accountId: string): void {
  if (!accountId) return;
  const identityKey = mainQuotaIdentityKey(accountId);
  if (identityKey === observedMainQuotaIdentityKey) return;
  observedMainQuotaIdentityKey = identityKey;
  mainDecisionCredentialUsable = true;
  mainAccountIdentityGeneration += 1;
  mainQuotaCredential = undefined;
  mainQuotaCredentialGeneration += 1;
  publishMainDecisionRoster();
}

/** Capture a main quota writer for an account id only when it matches the observed physical identity, remembering the credential generation it was captured under. */
export function captureMainQuotaWriter(accountId: string): MainQuotaWriter | undefined {
  if (!accountId) return undefined;
  const identityKey = mainQuotaIdentityKey(accountId);
  if (identityKey !== observedMainQuotaIdentityKey) return undefined;
  const writer = { identityKey, identityGeneration: mainAccountIdentityGeneration };
  if (mainQuotaCredential) decisionWriterGenerations.set(writer, mainQuotaCredentialGeneration);
  return writer;
}

/** Credential material must come from an already-owned read, never an incoming request. */
export function observeMainQuotaCredential(accessToken: string, accountId: string): MainQuotaWriter | undefined {
  const writer = captureMainQuotaWriter(accountId);
  if (!accessToken || !writer) return undefined;
  const bearerHmac = createHmac("sha256", mainQuotaCredentialKey).update(accessToken).digest();
  if (!mainQuotaCredential || !isMainQuotaWriterLive(mainQuotaCredential.writer)
    || !timingSafeEqual(bearerHmac, mainQuotaCredential.bearerHmac)) mainQuotaCredentialGeneration += 1;
  mainQuotaCredential = { bearerHmac, writer };
  publishMainDecisionRoster();
  const result = { ...writer };
  decisionWriterGenerations.set(result, mainQuotaCredentialGeneration);
  return result;
}

export function matchesMainQuotaCredential(accessToken: string, effectiveAccountId: string | undefined): boolean {
  const observed = mainQuotaCredential;
  if (!accessToken || !effectiveAccountId || !observed || !isMainQuotaWriterLive(observed.writer)) return false;
  if (mainQuotaIdentityKey(effectiveAccountId) !== observed.writer.identityKey) return false;
  const candidate = createHmac("sha256", mainQuotaCredentialKey).update(accessToken).digest();
  return timingSafeEqual(candidate, observed.bearerHmac);
}

export function isMainQuotaWriterLive(writer: MainQuotaWriter): boolean {
  return writer.identityKey === observedMainQuotaIdentityKey
    && writer.identityGeneration === mainAccountIdentityGeneration;
}

/** Proof that a dispatch used the observed main credential; process-local, never persisted. */
export type MainQuotaDispatch = Readonly<{
  writer: MainQuotaWriter;
  credentialGeneration: number;
  credentialMutationEpoch: number;
  configGeneration: number;
}>;

// WS quota frames publish through their observer; prelude quota can only come from those frames.
// A real HTTP fallback after a failed upgrade never invokes the observer and stays unclaimed.
const wsObservedMainDispatches = new WeakSet<MainQuotaDispatch>();

export function claimMainQuotaDispatchForWs(dispatch: MainQuotaDispatch): void {
  wsObservedMainDispatches.add(dispatch);
}

export function isMainQuotaDispatchWsClaimed(dispatch: MainQuotaDispatch): boolean {
  return wsObservedMainDispatches.has(dispatch);
}

/** Give a replacement physical attempt its own quota ownership without recapturing credential fences. */
export function renewMainQuotaDispatchForAttempt(dispatch: MainQuotaDispatch): MainQuotaDispatch {
  return { ...dispatch };
}

export function captureMainQuotaDispatch(
  accessToken: string, accountId: string | undefined, configGeneration: number,
): MainQuotaDispatch | undefined {
  if (!accountId || !matchesMainQuotaCredential(accessToken, accountId)) return undefined;
  const writer = captureMainQuotaWriter(accountId);
  return writer ? { writer, credentialGeneration: mainQuotaCredentialGeneration,
    credentialMutationEpoch: codexCredentialMutationEpoch(), configGeneration } : undefined;
}

export function isMainQuotaDispatchLive(dispatch: MainQuotaDispatch): boolean {
  // Other OpenCodex-owned credential publications also advance this epoch;
  // dropping a main quota update after any such publication is the intended safe direction.
  return isMainQuotaWriterLive(dispatch.writer)
    && dispatch.credentialGeneration === mainQuotaCredentialGeneration
    && dispatch.credentialMutationEpoch === codexCredentialMutationEpoch();
}

export function getObservedMainQuotaIdentityKey(): string | undefined {
  return observedMainQuotaIdentityKey;
}

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

/** Drop the cached main-account info and invalidate the observed identity and credential generation, then republish the main decision roster as unusable. */
export function clearMainAccountInfoCache(): void {
  cachedMainAccountInfo = null;
  mainAccountIdentityGeneration += 1;
  mainQuotaCredential = undefined;
  mainQuotaCredentialGeneration += 1;
  publishMainDecisionRoster();
}

/** Last physical credential presence observed while native-main ownership was held. */
export function getMainAccountCredentialPresence(): boolean | null {
  return cachedMainCredentialPresence;
}

/** Record whether the main credential is physically present; a transition to absent invalidates the observed credential generation. Republishes the main decision roster. */
export function setMainAccountCredentialPresence(present: boolean): void {
  if (!present && cachedMainCredentialPresence !== false) {
    mainQuotaCredential = undefined; mainQuotaCredentialGeneration += 1;
  }
  cachedMainCredentialPresence = present;
  publishMainDecisionRoster();
}

/** Forget the last observed main credential presence and invalidate the observed credential generation, then republish the main decision roster. */
export function clearMainAccountCredentialPresence(): void {
  cachedMainCredentialPresence = null;
  mainQuotaCredential = undefined; mainQuotaCredentialGeneration += 1;
  publishMainDecisionRoster();
}

/** Publish the single `__main__` roster row for advisory decision quota; it is usable only while a credential is observed and present. */
function publishMainDecisionRoster(): void {
  try {
    publishDecisionQuotaRoster("codex-main", [{ id: "__main__", generation: mainQuotaCredentialGeneration,
      usable: mainDecisionCredentialUsable && cachedMainCredentialPresence !== false && mainQuotaCredential !== undefined }]);
  } catch {
    // Advisory evidence must never alter main-credential cache state transitions; on failure the main roster becomes unknown.
    try { withdrawDecisionQuotaRoster("codex-main"); } catch { /* best-effort */ }
  }
}

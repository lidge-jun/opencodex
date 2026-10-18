import { getConfigDir } from "../config/paths";
import { notifyMainRosterChanged, type MainDecisionRow } from "../lib/decision-quota-sink";
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
// Advisory-only generation for the decision row and its writers. It follows every core credential
// generation change and additionally advances when physical presence is lost, so absence retires
// advisory evidence without touching the core credential binding that policy checks rely on.
let mainDecisionGeneration = 0;
// Advisory-only: the retained credential was re-observed since presence was last lost. Absence and
// presence-forgetting clear it, so the decision row stays unusable until a fresh owned observation.
let mainDecisionCredentialFresh = false;
// Config root that owns the observed main identity/credential for advisory decision evidence only.
// Stamped at identity/credential observations while a sink is active; other transitions never claim a root.
let mainDecisionRoot: string | undefined;
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
  return generation === mainDecisionGeneration && isMainQuotaWriterLive(writer) && mainDecisionRoot === getConfigDir() ? generation : undefined;
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
  mainDecisionGeneration += 1;
  publishMainDecisionRoster(true);
}

/** Capture a main quota writer for an account id only when it matches the observed physical identity, remembering the credential generation it was captured under. */
export function captureMainQuotaWriter(accountId: string): MainQuotaWriter | undefined {
  if (!accountId) return undefined;
  const identityKey = mainQuotaIdentityKey(accountId);
  if (identityKey !== observedMainQuotaIdentityKey) return undefined;
  const writer = { identityKey, identityGeneration: mainAccountIdentityGeneration };
  if (mainQuotaCredential) decisionWriterGenerations.set(writer, mainDecisionGeneration);
  return writer;
}

/** Credential material must come from an already-owned read, never an incoming request. */
export function observeMainQuotaCredential(accessToken: string, accountId: string): MainQuotaWriter | undefined {
  const writer = captureMainQuotaWriter(accountId);
  if (!accessToken || !writer) return undefined;
  const bearerHmac = createHmac("sha256", mainQuotaCredentialKey).update(accessToken).digest();
  if (!mainQuotaCredential || !isMainQuotaWriterLive(mainQuotaCredential.writer)
    || !timingSafeEqual(bearerHmac, mainQuotaCredential.bearerHmac)) { mainQuotaCredentialGeneration += 1; mainDecisionGeneration += 1; }
  mainQuotaCredential = { bearerHmac, writer };
  mainDecisionCredentialFresh = true;
  publishMainDecisionRoster(true);
  const result = { ...writer };
  decisionWriterGenerations.set(result, mainDecisionGeneration);
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
  mainDecisionGeneration += 1;
  publishMainDecisionRoster();
}

/** Last physical credential presence observed while native-main ownership was held. */
export function getMainAccountCredentialPresence(): boolean | null {
  return cachedMainCredentialPresence;
}

/** Record whether the main credential is physically present. The core credential binding is left intact (a failed read must not change policy matching); losing presence only retires advisory decision evidence. */
export function setMainAccountCredentialPresence(present: boolean): void {
  if (!present && cachedMainCredentialPresence !== false) { mainDecisionGeneration += 1; mainDecisionCredentialFresh = false; }
  cachedMainCredentialPresence = present;
  publishMainDecisionRoster();
}

/** Forget the last observed main credential presence; retires advisory decision evidence only, leaving the core credential binding intact. */
export function clearMainAccountCredentialPresence(): void {
  cachedMainCredentialPresence = null;
  mainDecisionGeneration += 1;
  mainDecisionCredentialFresh = false;
  publishMainDecisionRoster();
}

/**
 * Build the single `__main__` decision row from in-memory fields. With no retained credential the
 * row is a known-unusable main (nothing to misattribute), as before. A retained credential counts only
 * for the config root that observed it: for any other root the row is undefined (unknown) and the
 * claimed root is forgotten, so returning to the old root never resurrects it without a new owned
 * observation.
 */
function mainDecisionRow(): MainDecisionRow | undefined {
  if (mainQuotaCredential === undefined) return { generation: mainDecisionGeneration, usable: false };
  if (mainDecisionRoot === undefined || mainDecisionRoot !== getConfigDir()) {
    mainDecisionRoot = undefined;
    return undefined;
  }
  return { generation: mainDecisionGeneration,
    usable: mainDecisionCredentialFresh && mainDecisionCredentialUsable && cachedMainCredentialPresence !== false };
}

/** Hand the main decision row to the opt-in decision-quota slot (a no-op unless JEV quota signals are active); identity/credential observations claim the current root. */
function publishMainDecisionRoster(claimsRoot = false): void {
  notifyMainRosterChanged(() => {
    if (claimsRoot) mainDecisionRoot = getConfigDir();
    return mainDecisionRow();
  });
}

/** Activation replay for the JEV quota owner: the current row, or undefined when the observed credential belongs to another config root. */
export function peekMainDecisionRow(): MainDecisionRow | undefined {
  return mainDecisionRow();
}

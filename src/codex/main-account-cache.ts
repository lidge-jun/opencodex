import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/** Process-local transition fence; no credential material or persisted identity. */
export function getMainQuotaCredentialGeneration(): number { return mainQuotaCredentialGeneration; }

export type MainQuotaWriter = Readonly<{ identityKey: string; identityGeneration: number }>;

function mainQuotaIdentityKey(accountId: string): string {
  return createHash("sha256").update("opencodex-main-quota-v1\0").update(accountId).digest("hex");
}

/** Only an existing owned physical-identity read may publish this observation. */
export function observeMainQuotaIdentity(accountId: string): void {
  if (!accountId) return;
  const identityKey = mainQuotaIdentityKey(accountId);
  if (identityKey === observedMainQuotaIdentityKey) return;
  observedMainQuotaIdentityKey = identityKey;
  mainAccountIdentityGeneration += 1;
  mainQuotaCredential = undefined;
  mainQuotaCredentialGeneration += 1;
}

export function captureMainQuotaWriter(accountId: string): MainQuotaWriter | undefined {
  if (!accountId) return undefined;
  const identityKey = mainQuotaIdentityKey(accountId);
  if (identityKey !== observedMainQuotaIdentityKey) return undefined;
  return { identityKey, identityGeneration: mainAccountIdentityGeneration };
}

/** Credential material must come from an already-owned read, never an incoming request. */
export function observeMainQuotaCredential(accessToken: string, accountId: string): MainQuotaWriter | undefined {
  const writer = captureMainQuotaWriter(accountId);
  if (!accessToken || !writer) return undefined;
  const bearerHmac = createHmac("sha256", mainQuotaCredentialKey).update(accessToken).digest();
  if (!mainQuotaCredential || !isMainQuotaWriterLive(mainQuotaCredential.writer)
    || !timingSafeEqual(bearerHmac, mainQuotaCredential.bearerHmac)) mainQuotaCredentialGeneration += 1;
  mainQuotaCredential = { bearerHmac, writer };
  return { ...writer };
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

export function clearMainAccountInfoCache(): void {
  cachedMainAccountInfo = null;
  mainAccountIdentityGeneration += 1;
  mainQuotaCredential = undefined;
  mainQuotaCredentialGeneration += 1;
}

/** Last physical credential presence observed while native-main ownership was held. */
export function getMainAccountCredentialPresence(): boolean | null {
  return cachedMainCredentialPresence;
}

export function setMainAccountCredentialPresence(present: boolean): void {
  cachedMainCredentialPresence = present;
}

export function clearMainAccountCredentialPresence(): void {
  cachedMainCredentialPresence = null;
}

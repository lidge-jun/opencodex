/**
 * Wire shape of `GET /api/quota-pool`: the GOAT contract `ocx.quota-pool/1`.
 *
 * GOAT owns the decoder (`packages/contracts/src/quotaPool.ts` in goat-si/goat); OpenCodex is
 * the producer. Every optional field is OMITTED when OpenCodex does not know it. A missing
 * window means unknown, never 0%, and no field is ever `null`.
 */

export const QUOTA_POOL_SCHEMA = "ocx.quota-pool/1" as const;

export type QuotaPoolWindowKind = "burst_5h" | "daily" | "weekly" | "monthly" | "credits" | "custom";
/** measured: a usage probe body; header: response rate-limit headers; estimated: derived by OpenCodex. */
export type QuotaPoolSource = "measured" | "header" | "estimated";
export type QuotaPoolUnit = "requests" | "tokens" | "credits" | "usd";
export type QuotaPoolAccountState = "available" | "exhausted" | "paused" | "reauth" | "unknown";
export type QuotaPoolRole = "standalone" | "hub" | "client";

export interface QuotaPoolWindow {
  id: string;
  kind: QuotaPoolWindowKind;
  label: string;
  usedPercent?: number;
  used?: number;
  limit?: number;
  unit?: QuotaPoolUnit;
  resetsAt?: string;
  windowSeconds?: number;
  scopeModel?: string;
  source: QuotaPoolSource;
  observedAt: string;
  exhausted?: boolean;
}

export interface QuotaPoolAccount {
  provider: string;
  driver?: string;
  /** Opaque, stable for this install, never an email or a raw account id (see identity.ts). */
  accountRef: string;
  label?: string;
  plan?: string;
  state: QuotaPoolAccountState;
  windows: QuotaPoolWindow[];
  /** A closed `QuotaFailureCode`; never upstream text. */
  failure?: string;
}

export interface QuotaPoolProvider {
  provider: string;
  accounts: QuotaPoolAccount[];
  pooled: { windows: QuotaPoolWindow[]; headroom?: number; nextResetAt?: string };
}

export interface QuotaPool {
  schema: typeof QUOTA_POOL_SCHEMA;
  producer: { version: string; role: QuotaPoolRole; homeId: string };
  generatedAt: string;
  providers: QuotaPoolProvider[];
}

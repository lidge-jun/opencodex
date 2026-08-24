import { createHash } from "node:crypto";
import { getAccountSet } from "./store";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";

const PROVIDER = "google-antigravity";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const MAX_SHORT_RETRY_MS = 5_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_LENGTH = 128;

type CooldownSource = "retry-after" | "default" | "synthetic";
export type AntigravitySyntheticFailure = "rate-limit" | "quota" | "geoblock";

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: CooldownSource;
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const accountHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function affinityKey(value: string | null | undefined): string {
  const candidate = trimmed(value);
  if (!candidate) return "";
  return candidate.length <= MAX_AFFINITY_COMPONENT_LENGTH
    ? candidate
    : createHash("sha256").update(candidate).digest("hex");
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function antigravitySessionKeyFromParts(input: {
  clientThreadId?: string | null;
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
}): string | null {
  const preferred = [input.clientThreadId, input.sessionIdHeader, input.threadIdHeader, input.promptCacheKey]
    .map(trimmed)
    .find(Boolean);
  if (!preferred) return null;
  return affinityKey(preferred);
}

function pruneExpiredAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const entries = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (let i = 0; i < sessionAffinity.size - MAX_AFFINITY_ENTRIES; i += 1) {
    sessionAffinity.delete(entries[i]![0]);
  }
}

export function clearAntigravityRoutingState(): void {
  accountHealth.clear();
  sessionAffinity.clear();
}

export function antigravitySessionAffinitySizeForTests(): number {
  return sessionAffinity.size;
}

export function bindAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = affinityKey(sessionKey);
  const account = trimmed(accountId);
  if (!key || !account) return;
  sessionAffinity.set(key, { accountId: account, lastUsedAt: now });
  pruneExpiredAffinity(now);
}

export function clearAntigravitySessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

export function getAntigravityAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil: number; cooldownSource: CooldownSource } | null {
  const health = accountHealth.get(accountId);
  if (!health) return null;
  if (health.cooldownUntil <= now) {
    accountHealth.delete(accountId);
    return null;
  }
  return { ...health };
}

export function recordAntigravityCooldown(
  accountId: string,
  retryAfterHeader?: string | null,
  now = Date.now(),
): number {
  const delay = parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
  accountHealth.set(accountId, {
    cooldownUntil: now + delay,
    cooldownSource: retryAfterHeader?.trim() ? "retry-after" : "default",
  });
  sweepExpiredOnWrite(now);
  return now + delay;
}

export function clearAntigravityAccountCooldown(accountId: string): boolean {
  return accountHealth.delete(accountId);
}

export function retryableAntigravity429DelayMs(
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number | null {
  const delay = parseRetryAfterMs(retryAfterHeader, now);
  return delay !== undefined && delay <= MAX_SHORT_RETRY_MS ? delay : null;
}

export type AntigravityAccountSelectionReason =
  | "affinity"
  | "active"
  | "active-cooled"
  | "active-needs-reauth"
  | "missing-affinity"
  | "none";

export interface AntigravityAccountSelection {
  accountId: string | null;
  reason: AntigravityAccountSelectionReason;
  cooldownUntil?: number;
}

export function resolveAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  now = Date.now(),
): AntigravityAccountSelection {
  pruneExpiredAffinity(now);
  const key = affinityKey(sessionKey);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (key) {
    const bound = sessionAffinity.get(key);
    if (bound) {
      const account = set.accounts.find(candidate => candidate.id === bound.accountId);
      if (!account) {
        sessionAffinity.delete(key);
        return { accountId: null, reason: "missing-affinity" };
      }
      bound.lastUsedAt = now;
      if (account.needsReauth === true) return { accountId: account.id, reason: "active-needs-reauth" };
      return { accountId: account.id, reason: "affinity", ...(getAntigravityAccountHealthSnapshot(account.id, now) ?? {}) };
    }
  }

  const account = set.accounts.find(candidate => candidate.id === set.activeAccountId);
  if (!account) return { accountId: null, reason: "none" };
  if (account.needsReauth === true) return { accountId: account.id, reason: "active-needs-reauth" };
  const health = getAntigravityAccountHealthSnapshot(account.id, now);
  if (key) bindAntigravitySessionAffinity(key, account.id, now);
  return {
    accountId: account.id,
    reason: health ? "active-cooled" : "active",
    ...(health ?? {}),
  };
}

function failureText(payload: unknown): string {
  try { return JSON.stringify(payload).toLowerCase(); } catch { return ""; }
}

export function recordAntigravitySyntheticFailure(
  accountId: string,
  payload: unknown,
  now = Date.now(),
): AntigravitySyntheticFailure | null {
  const text = failureText(payload);
  const geo = text.includes("geoblock")
    || text.includes("location")
    || text.includes("country")
    || text.includes("region is not supported")
    || text.includes("not available in your region");
  if (geo) {
    accountHealth.set(accountId, { cooldownUntil: now + MAX_COOLDOWN_MS, cooldownSource: "synthetic" });
    return "geoblock";
  }
  const rateLimit = text.includes("rate limit") || text.includes("ratelimit") || text.includes("too many requests");
  const quota = text.includes("quota") || text.includes("resource_exhausted") || text.includes("resource exhausted");
  if (!rateLimit && !quota) return null;
  accountHealth.set(accountId, {
    cooldownUntil: now + DEFAULT_COOLDOWN_MS,
    cooldownSource: "synthetic",
  });
  return rateLimit ? "rate-limit" : "quota";
}

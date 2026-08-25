/**
 * Opt-in OAuth account routing for Google Antigravity (Cloud Code Assist).
 *
 * This module deliberately owns Google-specific usage families, cooldowns, and
 * affinity. AI Studio and Vertex never import or call it.
 */
import { createHash } from "node:crypto";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  clearPoolRotationState,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_GOOGLE_ANTIGRAVITY,
  removePoolRotationAccount,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import { retainedUtf8Bytes } from "../lib/admission";
import { sweepExpiredOnWrite, type GenerationContext } from "../lib/state-store-sweeper";
import { getCachedProviderAccountQuota, type ProviderQuota } from "../providers/quota";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { getAccountCredential, getAccountSet, setActiveAccount } from "./store";
import type { OAuthAccessSnapshot } from "./index";

const PROVIDER = "google-antigravity";
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;

export const GOOGLE_ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

export type GoogleAntigravityAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface GoogleAntigravityAccountSelection {
  accountId: string | null;
  reason: GoogleAntigravityAccountSelectionReason;
}

export type GoogleAntigravityQuotaRotationOutcome =
  | { kind: "next-account"; accountId: string }
  | { kind: "all-cooled" }
  | { kind: "pool-disabled" }
  | { kind: "no-eligible-account" };

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

function poolConfig(config: OcxConfig) {
  const raw = config.googleAntigravityAccountPool;
  return raw && typeof raw === "object" ? raw : {};
}

export function isGoogleAntigravityAccountPoolEnabled(config: OcxConfig): boolean {
  return poolConfig(config).enabled === true;
}

export function googleAntigravityAutoSwitchThreshold(config: OcxConfig): number {
  const value = poolConfig(config).autoSwitchThreshold;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function poolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(poolConfig(config).strategy);
}

function stickyLimit(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(poolConfig(config).stickyLimit);
}

function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

function pruneAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const ordered = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (let index = 0; index < ordered.length - MAX_AFFINITY_ENTRIES; index++) {
    sessionAffinity.delete(ordered[index]![0]);
  }
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  const delay = timestamp - now;
  return Number.isFinite(timestamp) && delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function getGoogleAntigravityAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const health = upstreamHealth.get(accountId);
  if (!health) return null;
  if (health.cooldownUntil <= now) {
    upstreamHealth.delete(accountId);
    return null;
  }
  return { cooldownUntil: health.cooldownUntil, cooldownSource: health.cooldownSource };
}

export function clearGoogleAntigravityAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

export function sweepExpiredGoogleAntigravityRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of upstreamHealth) {
    if (health.cooldownUntil > now) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

function isCooled(accountId: string, now: number): boolean {
  return getGoogleAntigravityAccountHealthSnapshot(accountId, now) !== null;
}

function isCredentialUsable(accountId: string): boolean {
  const credential = getAccountCredential(PROVIDER, accountId);
  return Boolean(credential?.projectId);
}

function getUsableGoogleAntigravityAccounts(): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account => account.needsReauth !== true && isCredentialUsable(account.id))
    .map(account => account.id);
}

export function getEligibleGoogleAntigravityAccounts(now = Date.now()): string[] {
  return getUsableGoogleAntigravityAccounts().filter(accountId => !isCooled(accountId, now));
}

function modelFamily(modelId: string): "gem" | "cla" | null {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("gemini")) return "gem";
  if (/claude|sonnet|opus|gpt[-_]oss/.test(normalized)) return "cla";
  return null;
}

function familyWindowMatches(family: "gem" | "cla", label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return family === "gem"
    ? /(^|\b)gem(?:ini)?(\b|$)/.test(normalized)
    : /(^|\b)cla(?:ude)?(\b|$)|sonnet|opus|gpt[-_ ]?oss/.test(normalized);
}

/** Maximum finite used percent relevant to this CCA model family; null means unknown. */
export function googleAntigravityUsageScore(modelId: string, quota: ProviderQuota | null | undefined): number | null {
  if (!quota) return null;
  const canonical = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const family = modelFamily(modelId);
  const custom = family
    ? (quota.customWindows ?? [])
      .filter(window => familyWindowMatches(family, window.label))
      .map(window => window.percent)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
  const relevant = [...canonical, ...custom];
  if (relevant.length === 0) return null;
  return Math.max(0, Math.min(100, Math.max(...relevant)));
}

function usageScore(accountId: string, modelId: string): number | null {
  return googleAntigravityUsageScore(modelId, getCachedProviderAccountQuota(PROVIDER, accountId));
}

function activeUsable(accountId: string, now: number): boolean {
  const set = getAccountSet(PROVIDER);
  return Boolean(set?.accounts.some(account => account.id === accountId && account.needsReauth !== true))
    && !isCooled(accountId, now)
    && isCredentialUsable(accountId);
}

function pickLowestUsage(modelId: string, excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleGoogleAntigravityAccounts(now).filter(id => id !== excludeId);
  if (eligible.length === 0) return null;
  const known = eligible
    .map(id => ({ id, score: usageScore(id, modelId) }))
    .filter((row): row is { id: string; score: number } => row.score !== null);
  if (known.length === 0) return eligible[0] ?? null;
  known.sort((a, b) => a.score - b.score);
  return known[0]!.id;
}

function underThreshold(config: OcxConfig, accountId: string, modelId: string): boolean {
  const threshold = googleAntigravityAutoSwitchThreshold(config);
  if (threshold <= 0) return true;
  const score = usageScore(accountId, modelId);
  return score === null || score < threshold;
}

function nextFillFirst(config: OcxConfig, modelId: string, afterId: string, eligible: string[]): string | null {
  const set = getAccountSet(PROVIDER);
  const all = [...(set?.accounts.map(account => account.id) ?? eligible)].sort((a, b) => a.localeCompare(b));
  const start = all.indexOf(afterId);
  let fallback: string | null = null;
  for (let step = 1; step <= all.length; step++) {
    const candidate = all[(Math.max(start, -1) + step) % all.length]!;
    if (!eligible.includes(candidate)) continue;
    fallback ??= candidate;
    if (underThreshold(config, candidate, modelId)) return candidate;
  }
  return fallback;
}

function pickStrategyAccount(
  config: OcxConfig,
  modelId: string,
  now: number,
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = poolStrategy(config);
  const eligible = getEligibleGoogleAntigravityAccounts(now);
  if (strategy === "round-robin") {
    const limit = stickyLimit(config);
    const accountId = pickRoundRobinAccount(POOL_KEY_GOOGLE_ANTIGRAVITY, eligible, limit);
    if (!accountId) return null;
    notePoolRotationSuccess(POOL_KEY_GOOGLE_ANTIGRAVITY, accountId, limit);
    return { accountId, reason: "round-robin" };
  }
  if (strategy === "fill-first") {
    const active = getAccountSet(PROVIDER)?.activeAccountId;
    const accountId = active && eligible.includes(active) && underThreshold(config, active, modelId)
      ? active
      : nextFillFirst(config, modelId, active ?? "", eligible);
    return accountId ? { accountId, reason: "fill-first" } : null;
  }
  return null;
}

export function resolveGoogleAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  modelId: string,
  config: OcxConfig,
  now = Date.now(),
): GoogleAntigravityAccountSelection {
  pruneAffinity(now);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };
  if (!isGoogleAntigravityAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const key = normalizeAffinityComponent(sessionKey);
  const affined = key ? sessionAffinity.get(key) : undefined;
  if (affined) {
    if (now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS && activeUsable(affined.accountId, now)) {
      return { accountId: affined.accountId, reason: "affinity" };
    }
    sessionAffinity.delete(key);
  }

  const active = set.activeAccountId;
  const activeOk = activeUsable(active, now);
  const strategy = poolStrategy(config);
  if (!key && (strategy === "round-robin" || strategy === "fill-first") && activeOk) {
    return { accountId: active, reason: "active" };
  }

  const strategyPick = pickStrategyAccount(config, modelId, now);
  if (strategyPick) {
    return strategyPick;
  }

  const threshold = googleAntigravityAutoSwitchThreshold(config);
  let accountId: string | null = null;
  let reason: GoogleAntigravityAccountSelectionReason = "none";
  const activeScore = usageScore(active, modelId);
  if (threshold > 0 && activeOk && (activeScore === null || activeScore < threshold)) {
    accountId = active;
    reason = "active";
  } else if (threshold > 0) {
    accountId = pickLowestUsage(modelId, undefined, now);
    if (accountId) reason = accountId === active ? "active" : "lowest-usage";
  } else if (activeOk) {
    accountId = active;
    reason = "active";
  } else {
    accountId = pickLowestUsage(modelId, active, now);
    if (accountId) reason = "only-eligible";
  }

  if (!accountId) {
    return {
      accountId: null,
      reason: set.accounts.some(account => isCooled(account.id, now)) ? "all-cooled" : "none",
    };
  }
  return { accountId, reason };
}

export function bindGoogleAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  sessionAffinity.set(key, { accountId, lastUsedAt: now });
  pruneAffinity(now);
}

function clearAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

/** Drop every provider-owned runtime reference to a deleted Google OAuth account. */
export function clearGoogleAntigravityRoutingStateForAccount(accountId: string): void {
  upstreamHealth.delete(accountId);
  clearAffinityForAccount(accountId);
  removePoolRotationAccount(POOL_KEY_GOOGLE_ANTIGRAVITY, accountId);
}

export function reconcileGoogleAntigravityRoutingState(context: GenerationContext): number {
  const validAccountIds = new Set<string>();
  for (const key of context.oauthAccountKeys) {
    const separator = key.indexOf("\0");
    if (separator > 0 && key.slice(0, separator) === PROVIDER) {
      validAccountIds.add(key.slice(separator + 1));
    }
  }
  let removed = 0;
  for (const accountId of upstreamHealth.keys()) {
    if (validAccountIds.has(accountId)) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  for (const [key, entry] of sessionAffinity) {
    if (validAccountIds.has(entry.accountId)) continue;
    sessionAffinity.delete(key);
    removed += 1;
  }
  return removed;
}

function pickAlternate(
  config: OcxConfig,
  modelId: string,
  failedAccountId: string,
  now: number,
): string | null {
  const eligible = getEligibleGoogleAntigravityAccounts(now).filter(id => id !== failedAccountId);
  const strategy = poolStrategy(config);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_GOOGLE_ANTIGRAVITY, eligible, stickyLimit(config));
  }
  if (strategy === "fill-first") return nextFillFirst(config, modelId, failedAccountId, eligible);
  return pickLowestUsage(modelId, failedAccountId, now);
}

/** Cool the failed account and propose an explicit outcome; the caller commits affinity only when it dispatches. */
export function rotateGoogleAntigravityAccountOnQuotaError(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  modelId: string,
  _sessionKey?: string | null,
  now = Date.now(),
): GoogleAntigravityQuotaRotationOutcome {
  if (!coolGoogleAntigravityAccountOnQuotaError(config, failedAccountId, retryAfterHeader, now)) {
    return { kind: "pool-disabled" };
  }
  const next = pickAlternate(config, modelId, failedAccountId, now);
  if (!next) {
    const usable = getUsableGoogleAntigravityAccounts();
    if (usable.length > 0 && usable.every(accountId => isCooled(accountId, now))) {
      console.warn("[google-antigravity-pool] all eligible OAuth accounts are in cooldown; returning quota response");
      return { kind: "all-cooled" };
    }
    return { kind: "no-eligible-account" };
  }
  return { kind: "next-account", accountId: next };
}

/** Classify one surfaced quota response even when the request cannot dispatch another account. */
export function coolGoogleAntigravityAccountOnQuotaError(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!isGoogleAntigravityAccountPoolEnabled(config)) return false;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + (retryAfterMs ?? DEFAULT_COOLDOWN_MS),
    cooldownSource: retryAfterMs === undefined ? "default" : "retry-after",
  });
  clearAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_GOOGLE_ANTIGRAVITY, failedAccountId);
  sweepExpiredOnWrite(now);
  return true;
}

export function getGoogleAntigravityPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  let earliest: number | null = null;
  for (const account of set?.accounts ?? []) {
    const until = getGoogleAntigravityAccountHealthSnapshot(account.id, now)?.cooldownUntil;
    if (until !== undefined && (earliest === null || until < earliest)) earliest = until;
  }
  return earliest !== null && earliest > now ? Math.max(1, Math.ceil((earliest - now) / 1000)) : null;
}

export function googleAntigravityAllCooledError(now = Date.now()): {
  status: 429;
  type: "rate_limit_error";
  message: string;
  retryAfter?: string;
} {
  const retryAfterSeconds = getGoogleAntigravityPoolRetryAfterSeconds(now);
  return {
    status: 429,
    type: "rate_limit_error",
    message: "All Google Antigravity OAuth accounts are temporarily rate-limited",
    ...(retryAfterSeconds !== null ? { retryAfter: String(retryAfterSeconds) } : {}),
  };
}

export function promoteGoogleAntigravityActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best effort */ });
}

/** Resolve the selected account's bearer and CCA project as one generation-bound snapshot. */
export async function getGoogleAntigravityPoolAccessSnapshot(
  accountId: string,
): Promise<OAuthAccessSnapshot & { projectId: string }> {
  const { getValidAccessSnapshotForAccount } = await import("./index");
  const snapshot = await getValidAccessSnapshotForAccount(PROVIDER, accountId);
  if (!snapshot.projectId) {
    throw new Error("selected Google Antigravity account is missing its Cloud Code Assist project id");
  }
  return { ...snapshot, projectId: snapshot.projectId };
}

export function resetGoogleAntigravityRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_GOOGLE_ANTIGRAVITY, accountId);
}

export function formatGoogleAntigravityAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatGoogleAntigravityProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
): string {
  return accountId ? `${providerName}-${formatGoogleAntigravityAccountOrdinal(accountId)}` : providerName;
}

export function googleAntigravitySessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = (input.clientThreadId ?? input.sessionIdHeader ?? input.threadIdHeader ?? "").trim();
  if (preferred) return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  return !cacheKey ? null : cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}

export function clearGoogleAntigravityAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
  clearPoolRotationState(POOL_KEY_GOOGLE_ANTIGRAVITY);
}

export function googleAntigravitySessionAffinitySizeForTests(): number {
  return sessionAffinity.size;
}

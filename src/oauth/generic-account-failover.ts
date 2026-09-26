/**
 * Generic OAuth multi-account 429 failover (#2568).
 *
 * The API-key twin (`providers/key-failover.ts`) rotates by default for any key provider with a
 * 2+ pool, but it returns false for `authMode === "oauth"`, and the only OAuth rotator that
 * exists is Anthropic's — behind its own opt-in. So xAI, Cursor, Kimi, GitHub Copilot,
 * Antigravity and Nous have no recovery path on a 429 even with several accounts logged in.
 *
 * Deliberately narrower than the Anthropic pool: no session affinity, no quota-ranked selection,
 * no probe leases. Those carry provider-specific meaning; this module only answers "the account
 * that just 429'd is cooled, is there another one we may use".
 *
 * NOT a home for Codex (`codex/routing.ts` owns quota scopes and probe leases) or Anthropic
 * (`oauth/anthropic-routing.ts` owns affinity and a fail-closed local-cli credential rule).
 * Both are excluded by `isGenericFailoverProvider`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { getAccountSet } from "./store";
import { getValidAccessSnapshotForAccount, type OAuthAccessSnapshot } from "./index";
import {
  accountHeadroomPercent,
  exhaustedCooldownMs,
  hasHeadroomEvidence,
  isAccountQuotaExhausted,
  rankAccountsByHeadroom,
  classifyModelFamilyForQuota,
  type QuotaModelFamily,
} from "./account-quota-rank";
import {
  genericPoolKey,
  normalizeAccountPoolStickyLimit,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  seedPoolRotationAccount,
} from "./pool-kernel";
import { parseRetryAfterMs } from "../combos/failover";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { OcxConfig, OcxProviderConfig } from "../types";

/** Legacy/default same-request rotation floor. Dynamic paths scale from this floor per pool. */
export const GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST = 3;

/** Dynamic per-request failover cap based on account pool size. */
export function genericOAuthMaxFailovers(providerName?: string): number {
  if (!providerName) return GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST;
  const set = getAccountSet(providerName);
  const total = set?.accounts.length ?? 0;
  if (total <= 1) return 1;
  return Math.max(3, Math.min(total - 1, 15));
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * How long a presence answer may be reused before the store is consulted again.
 *
 * `loadAuthStore` has no cache: every call chmods the config dir and the secret, reads the whole
 * file, parses it and normalizes the store (store.ts:136-151). Since presence now decides
 * activation, this predicate runs on paths that have not seen a 429 at all — the streaming and
 * non-streaming runTurn entry points evaluate it once per request — so an uncached check would put
 * a synchronous file read in front of every request for every OAuth provider.
 *
 * Two seconds is short enough that a login in another window is picked up before the operator can
 * switch back and send a prompt, and long enough that a burst of requests shares one read. The
 * cache holds a COUNT, never a credential.
 */
const PRESENCE_CACHE_TTL_MS = 2_000;

/**
 * Providers whose rotation is owned elsewhere and must not be handled here.
 *
 * `openai` is the Codex pool: quota scopes, probe leases and affinity semantics that this
 * module deliberately does not reimplement. `anthropic` has its own pool with a fail-closed
 * rule about background local-cli credential slots.
 */
const EXCLUDED_PROVIDERS = new Set(["openai", "anthropic"]);

export type AccountHealthStatus = "healthy" | "validation_required" | "auth_failure" | "quota_exhausted" | "unknown";

export interface AccountHealthRecord {
  status: AccountHealthStatus;
  cooldownUntil: number;
  cooldownSource?: "retry-after" | "default" | "error" | "probe";
  lastCheckedAt: number;
  lastVerifiedAt?: number;
  lastError?: string;
  family?: QuotaModelFamily;
}

interface PresenceEntry {
  eligible: number;
  readAt: number;
}

/** File-backed dynamic health store (~/.opencodex/oauth-account-health.json). Survives restarts without touching auth.json. */
const health = new Map<string, AccountHealthRecord>();
let healthCacheLoaded = false;
let healthCacheDirty = false;
let sweepStartTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function getHealthFilePath(): string {
  return join(getConfigDir(), "oauth-account-health.json");
}

export function loadHealthCache(): void {
  const filePath = getHealthFilePath();
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      health.clear();
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object") {
          health.set(key, value as AccountHealthRecord);
        }
      }
    }
  } catch (err) {
    console.warn("[opencodex] Failed to load oauth-account-health.json:", err);
  }
  healthCacheLoaded = true;
}

export function saveHealthCache(): void {
  const filePath = getHealthFilePath();
  try {
    const obj: Record<string, AccountHealthRecord> = {};
    for (const [key, value] of health.entries()) {
      obj[key] = value;
    }
    atomicWriteFile(filePath, JSON.stringify(obj, null, 2) + "\n");
    healthCacheDirty = false;
  } catch (err) {
    console.warn("[opencodex] Failed to save oauth-account-health.json:", err);
  }
}

export function ensureHealthCache(): void {
  if (!healthCacheLoaded) {
    loadHealthCache();
  }
}

function flushHealthCacheIfDirty(): void {
  if (healthCacheDirty) saveHealthCache();
}

export function getAccountHealthRecord(provider: string, accountId: string, family?: QuotaModelFamily): AccountHealthRecord | undefined {
  ensureHealthCache();
  return health.get(healthKey(provider, accountId, family)) ?? health.get(healthKey(provider, accountId));
}

export function isAccountHealthy(provider: string, accountId: string, now = Date.now()): boolean {
  ensureHealthCache();
  const entry = health.get(healthKey(provider, accountId));
  if (!entry) return true;
  if (entry.cooldownUntil > now && (entry.status === "validation_required" || entry.status === "auth_failure")) {
    return false;
  }
  if (entry.status === "validation_required" || entry.status === "auth_failure") {
    return false;
  }
  return true;
}

export function recordAccountHealthy(providerName: string, accountId: string, now = Date.now()): void {
  ensureHealthCache();
  const key = healthKey(providerName, accountId);
  health.set(key, {
    status: "healthy",
    cooldownUntil: 0,
    cooldownSource: "probe",
    lastCheckedAt: now,
    lastVerifiedAt: now,
    lastError: undefined,
  });
  saveHealthCache();
}

export function recordAccountValidationRequired(
  providerName: string,
  accountId: string,
  now = Date.now(),
): void {
  ensureHealthCache();
  const key = healthKey(providerName, accountId);
  const existing = health.get(key);
  health.set(key, {
    status: "validation_required",
    cooldownUntil: now + 30 * 60_000,
    cooldownSource: "error",
    lastCheckedAt: now,
    lastVerifiedAt: existing?.lastVerifiedAt,
    lastError: "HTTP 403: VALIDATION_REQUIRED",
  });
  saveHealthCache();
}

export function recordAccountAuthFailure(
  providerName: string,
  accountId: string,
  now = Date.now(),
): void {
  ensureHealthCache();
  const key = healthKey(providerName, accountId);
  const existing = health.get(key);
  health.set(key, {
    status: "auth_failure",
    cooldownUntil: now + 15 * 60_000,
    cooldownSource: "error",
    lastCheckedAt: now,
    lastVerifiedAt: existing?.lastVerifiedAt,
    lastError: "HTTP 401: Unauthorized",
  });
  saveHealthCache();
}

/** Provider -> recent eligible-account count. TTL-bounded; never holds credential material. */
const presence = new Map<string, PresenceEntry>();

const healthKey = (provider: string, accountId: string, family?: QuotaModelFamily) =>
  family ? `${provider}\u0000${accountId}\u0000${family}` : `${provider}\u0000${accountId}`;

function isCooled(provider: string, accountId: string, now: number, family?: QuotaModelFamily): boolean {
  ensureHealthCache();
  const accountEntry = health.get(healthKey(provider, accountId));
  if (accountEntry) {
    if (accountEntry.cooldownUntil > now) return true;
    if (accountEntry.status === "quota_exhausted") {
      accountEntry.status = "healthy";
      accountEntry.cooldownUntil = 0;
      healthCacheDirty = true;
    }
  }

  if (family) {
    const famEntry = health.get(healthKey(provider, accountId, family));
    if (famEntry) {
      if (famEntry.cooldownUntil > now) return true;
      if (famEntry.status === "quota_exhausted") {
        famEntry.status = "healthy";
        famEntry.cooldownUntil = 0;
        healthCacheDirty = true;
      }
    }
  }
  return false;
}

/** True when this provider participates in generic rotation at all. */
export function isGenericFailoverProvider(providerName: string, provider: OcxProviderConfig): boolean {
  return provider.authMode === "oauth" && !EXCLUDED_PROVIDERS.has(providerName);
}

/**
 * Stored accounts that could serve traffic if asked, ignoring cooldowns.
 *
 * Cooldowns are excluded on purpose: they are transient and per-request, while this answers the
 * durable question "did the operator log in more than one account". Treating a cooled account as
 * absent would switch the feature off for the rest of the cooldown, which is exactly when it is
 * needed.
 */
function eligibleAccountCount(providerName: string, now: number): number {
  const cached = presence.get(providerName);
  if (cached && now >= cached.readAt && now - cached.readAt < PRESENCE_CACHE_TTL_MS) return cached.eligible;
  const set = getAccountSet(providerName);
  const eligible = set ? set.accounts.filter(account => account.needsReauth !== true).length : 0;
  presence.set(providerName, { eligible, readAt: now });
  return eligible;
}

/**
 * Presence IS consent (#2568d).
 *
 * `hasKeyPoolFailover` already reads a 2+ key pool as the operator asking for rotation, and a
 * second OAuth login is the same statement. One account stays a strict no-op either way, so this
 * only changes behaviour for someone who deliberately logged in twice.
 */
export function hasFailoverAccountQuorum(providerName: string, now = Date.now()): boolean {
  return eligibleAccountCount(providerName, now) >= 2;
}

/**
 * Whether REACTIVE 429 rotation is active for this provider.
 *
 * Presence is the only rule: two or more eligible stored accounts. The
 * `oauthAccountFailover.enabled` booleans no longer suppress it.
 *
 * That is a deliberate narrowing of #2568d. Rotation here runs only after upstream has already
 * refused the request, so the choice the old knob offered was between "retry on the second
 * account you deliberately logged in" and "return a 429 while that account sits idle". The
 * second is a defect, not a preference — and an operator who does not want rotation expresses
 * that by not storing a second account, exactly as they do for `apiKeyPool`.
 *
 * The knob is not gone. It still governs {@link isProactivePreferenceEnabled}, which decides
 * whether a HEALTHY request may be steered to a different account before dispatch — a real
 * behavioural choice that remains refusable — and it still carries `strategy` and
 * `autoSwitchThreshold`.
 */
export function isGenericOAuthFailoverEnabled(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  return hasFailoverAccountQuorum(providerName, now);
}

/**
 * Whether the pre-dispatch account PREFERENCE may run for this provider.
 *
 * Unlike reactive rotation, this moves a request that upstream has not refused, so it stays
 * refusable: an explicit provider value wins over the global default, and a global `false`
 * turns it off only when the provider has no override. A malformed value falls through rather
 * than taking a provider out of service.
 */
function isProactivePreferenceEnabled(config: OcxConfig, providerName: string, now: number): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  const perProvider = provider.oauthAccountFailover?.enabled;
  // Preserve the published narrow-over-broad precedence. A provider-specific true may
  // opt this provider into proactive preference even when the global default is false;
  // a provider-specific false refuses it even when the global setting is true.
  if (typeof perProvider === "boolean") {
    return perProvider && hasFailoverAccountQuorum(providerName, now);
  }
  return config.oauthAccountFailover?.enabled === true && hasFailoverAccountQuorum(providerName, now);
}

/** Accounts that may serve traffic right now: not cooled, not flagged for reauth, and healthy. */
export function eligibleFailoverAccounts(providerName: string, now = Date.now(), family?: QuotaModelFamily): string[] {
  ensureHealthCache();
  return eligibleIdsIn(getAccountSet(providerName), providerName, now, family);
}

function eligibleIdsIn(
  set: ReturnType<typeof getAccountSet>,
  providerName: string,
  now: number,
  family?: QuotaModelFamily,
): string[] {
  if (!set) return [];
  const valid = set.accounts
    .filter(account => account.needsReauth !== true
      && !isCooled(providerName, account.id, now, family)
      && isAccountHealthy(providerName, account.id, now))
    .map(account => account.id);
  if (valid.length > 0) {
    flushHealthCacheIfDirty();
    return valid;
  }
  const fallback = set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(providerName, account.id, now, family))
    .map(account => account.id);
  flushHealthCacheIfDirty();
  return fallback;
}

/**
 * Whether reactive rotation has an alternate account it could select right now.
 *
 * Answers from the same live roster read and the same guards `rotateGenericOAuthAccountOn429`
 * applies: a roster of fewer than two accounts has nowhere to go, even when a cached quorum
 * count or a stale failed id would suggest otherwise. It applies no cooldown and advances no
 * rotation state; like every eligibility read, it may prune an already-expired cooldown entry.
 */
export function hasEligibleGenericOAuthFailoverTarget(
  providerName: string,
  failedAccountId: string,
  now = Date.now(),
  requestedModelId?: string | null,
): boolean {
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length < 2) return false;
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  return eligibleIdsIn(set, providerName, now, family).some(id => id !== failedAccountId);
}

/** Generic pool strategies the kernel can actually run. `quota` IS the pre-kernel path. */
type ActiveGenericStrategy = "round-robin" | "fill-first";

/** Matches the Codex and Anthropic pools; the DTO still reports `null` for "not stored". */
const DEFAULT_GENERIC_AUTO_SWITCH_THRESHOLD = 80;

/**
 * The strategy this provider's pool actually runs, or null for today's behaviour.
 *
 * Three different inputs answer null and they all mean the same thing to a caller: the flag is
 * off, no strategy is stored, or the stored strategy is `quota` — which is precisely what the
 * unflagged code already does. Collapsing them here is what keeps every call site a two-way
 * branch instead of a four-way one.
 */
function activeGenericStrategy(config: OcxConfig, providerName: string): ActiveGenericStrategy | null {
  if (config.pool?.kernel !== true) return null;
  const raw = config.providers?.[providerName]?.oauthAccountFailover?.strategy;
  return raw === "round-robin" || raw === "fill-first" ? raw : null;
}

function genericStickyLimit(config: OcxConfig, providerName: string): number {
  return normalizeAccountPoolStickyLimit(config.providers?.[providerName]?.oauthAccountFailover?.stickyLimit);
}

/**
 * The FULL roster in a stable order, not the eligible subset.
 *
 * Two load-bearing reasons. The store holds accounts in LOGIN order, so two operators who added
 * the same accounts in a different sequence would otherwise rotate differently; sorting makes
 * the ring a property of the accounts rather than of the history. And walking the eligible
 * subset instead of the full roster changes the wrap order whenever an ineligible id sits
 * between two eligible ones — the bug the Codex and Anthropic copies carry a `stableAll`
 * argument to avoid.
 */
function stableGenericRoster(providerName: string): string[] {
  const set = getAccountSet(providerName);
  if (!set) return [];
  return set.accounts.map(account => account.id).sort((left, right) => left.localeCompare(right));
}

/**
 * Has this account spent enough of its allowance for fill-first to move on?
 *
 * An unmeasured account reads as UNDER the threshold, matching the Codex pool: a threshold is a
 * statement about observed usage, and treating "no observation" as "spent" would evacuate every
 * quota-less provider off its active account on the very first request.
 */
function isOverAutoSwitchThreshold(providerName: string, accountId: string, threshold: number, requestedModelId?: string | null): boolean {
  if (threshold <= 0) return false;
  const headroom = accountHeadroomPercent(providerName, accountId, requestedModelId);
  if (headroom === null) return false;
  return 100 - headroom >= threshold;
}

/**
 * Fill-first: stay on the active account until it crosses its threshold, then take the next
 * eligible account in the stable ring. Null means "keep the active account".
 */
function pickFillFirstGenericAccount(
  config: OcxConfig,
  providerName: string,
  activeId: string | undefined,
  now: number,
  requestedModelId?: string | null,
): string | null {
  const stableAll = stableGenericRoster(providerName);
  if (stableAll.length < 2) return null;
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  const eligible = new Set(eligibleFailoverAccounts(providerName, now, family));
  const stored = config.providers?.[providerName]?.oauthAccountFailover?.autoSwitchThreshold;
  const threshold = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 && stored <= 100
    ? stored
    : DEFAULT_GENERIC_AUTO_SWITCH_THRESHOLD;
  if (activeId && eligible.has(activeId) && !isOverAutoSwitchThreshold(providerName, activeId, threshold, requestedModelId)) {
    return null;
  }
  const start = activeId ? stableAll.indexOf(activeId) : -1;
  const ring = start >= 0 ? [...stableAll.slice(start + 1), ...stableAll.slice(0, start)] : stableAll;
  for (const id of ring) {
    if (id !== activeId && eligible.has(id)) return id;
  }
  return null;
}

/**
 * Advance the round-robin cursor once a dispatch has actually been admitted on this account.
 *
 * The early return is the whole safety story for the core path: this is reached on EVERY
 * generic first dispatch, including quota pools and the fallback after a preferred account was
 * dropped, so anything but round-robin must leave the cursor untouched.
 *
 * The live pick belongs here rather than in the proposal, and that is not stylistic.
 * `peekRoundRobinAccount` never creates the pool state and `notePoolRotationSuccess` returns
 * immediately when there is none, so a peek-only path would leave the ring with nothing to
 * advance and round-robin would propose the same account forever. This is the same shape
 * `commitAnthropicSelectionRouting` already commits with.
 */
export function noteGenericPoolSelection(
  config: OcxConfig,
  providerName: string,
  accountId: string,
  requestedModelId?: string | null,
): void {
  if (activeGenericStrategy(config, providerName) !== "round-robin") return;
  const poolKey = genericPoolKey(providerName);
  const limit = genericStickyLimit(config, providerName);
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  const picked = pickRoundRobinAccount(poolKey, eligibleFailoverAccounts(providerName, Date.now(), family), limit);
  // The resolver may have admitted a different account than the ring proposed: a removal, a
  // reauth verdict or a manual selection can land during credential resolution. Realign the
  // cursor onto what actually served rather than leaving it on a road not taken.
  if (picked !== accountId) seedPoolRotationAccount(poolKey, accountId);
  notePoolRotationSuccess(poolKey, accountId, limit);
}


/**
 * Pick the next eligible account after the failed one without changing health state.
 *
 * Health recording stays with the failure-specific caller: quota failures write a family
 * cooldown, while auth failures write only the account-level auth verdict.
 */
function nextGenericOAuthFailoverAccount(
  config: OcxConfig,
  providerName: string,
  failedAccountId: string,
  now: number,
  requestedModelId?: string | null,
): string | null {
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length < 2) return null;
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  const eligible = eligibleFailoverAccounts(providerName, now, family).filter(id => id !== failedAccountId);
  if (eligible.length === 0) return null;

  presence.delete(providerName);
  const order = set.accounts.map(account => account.id);
  const start = order.indexOf(failedAccountId);
  const ring = start >= 0 ? [...order.slice(start + 1), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id));
  if (candidates.length === 0) return null;

  const strategy = activeGenericStrategy(config, providerName);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(
      genericPoolKey(providerName),
      candidates,
      genericStickyLimit(config, providerName),
    );
  }
  if (strategy === "fill-first") {
    const stableAll = stableGenericRoster(providerName);
    const from = stableAll.indexOf(failedAccountId);
    const walk = from >= 0 ? [...stableAll.slice(from + 1), ...stableAll.slice(0, from)] : stableAll;
    for (const id of walk) {
      if (id !== failedAccountId && candidates.includes(id)) return id;
    }
    return null;
  }
  return rankAccountsByHeadroom(providerName, candidates, requestedModelId)[0] ?? null;
}

/**
 * Cool the account that actually 429'd and name the next eligible one, or null.
 */
export function rotateGenericOAuthAccountOn429(
  config: OcxConfig,
  providerName: string,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  requestedModelId?: string | null,
): string | null {
  if (!isGenericOAuthFailoverEnabled(config, providerName)) return null;
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length < 2) return null;

  const parsed = parseRetryAfterMs(retryAfterHeader, now, { preserveImmediate: true, preserveServerDelay: true });
  const exhausted = parsed === undefined ? exhaustedCooldownMs(providerName, failedAccountId, now) : null;
  const cooldownMs = exhausted ?? parsed ?? DEFAULT_COOLDOWN_MS;
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  const key = healthKey(providerName, failedAccountId, family);
  const existing = health.get(key) ?? health.get(healthKey(providerName, failedAccountId));
  health.set(key, {
    status: "quota_exhausted",
    cooldownUntil: now + cooldownMs,
    cooldownSource: parsed ? "retry-after" : "default",
    lastCheckedAt: now,
    lastVerifiedAt: existing?.lastVerifiedAt,
    family,
  });
  saveHealthCache();
  sweepExpiredOnWrite(now);
  return nextGenericOAuthFailoverAccount(config, providerName, failedAccountId, now, requestedModelId);
}

const ANTIGRAVITY_FAILOVER_PROVIDER = "google-antigravity";
const FAILOVER_CLASSIFICATION_MAX_BYTES = 4 * 1024;
const FAILOVER_CLASSIFICATION_TIMEOUT_MS = 2_000;

function isAntigravityValidationRequired(text: string | undefined): boolean {
  return typeof text === "string" && text.includes("VALIDATION_REQUIRED");
}

/**
 * 429 remains generic. Auth/permission rotation is intentionally Antigravity-only, and a 403
 * is eligible only when its bounded error body explicitly identifies VALIDATION_REQUIRED.
 */
export function isGenericOAuthFailoverStatus(
  status: number,
  providerName?: string,
  errorText?: string,
): boolean {
  if (status === 429) return true;
  if (providerName !== ANTIGRAVITY_FAILOVER_PROVIDER) return false;
  if (status === 401) return true;
  if (status !== 403) return false;
  // Without text this answers only whether the response is worth a bounded classification read.
  // Once text is supplied, only the concrete validation failure is eligible to rotate.
  return errorText === undefined || isAntigravityValidationRequired(errorText);
}

/**
 * Read only enough of an Antigravity 403 to classify VALIDATION_REQUIRED.
 * The text is never persisted or logged; incomplete, oversized, timed-out, or aborted reads
 * fail closed and leave the original response untouched for the client.
 */
export async function isGenericOAuthFailoverResponse(
  response: Response,
  providerName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 403) return isGenericOAuthFailoverStatus(response.status, providerName);
  if (providerName !== ANTIGRAVITY_FAILOVER_PROVIDER) return false;
  try {
    const observed = await readBoundedResponseBody(response.clone(), {
      signal,
      maxBytes: FAILOVER_CLASSIFICATION_MAX_BYTES,
      totalTimeoutMs: FAILOVER_CLASSIFICATION_TIMEOUT_MS,
      firstByteTimeoutMs: FAILOVER_CLASSIFICATION_TIMEOUT_MS,
      inactivityTimeoutMs: FAILOVER_CLASSIFICATION_TIMEOUT_MS,
    });
    return observed.displaySafe && isAntigravityValidationRequired(observed.text);
  } catch {
    return false;
  }
}

/**
 * Rotate after a classified generic OAuth failure.
 *
 * 401/403 auth health is account-scoped. It deliberately does not reuse the 429 writer, because
 * that would also create a family-scoped quota_exhausted record for an authentication failure.
 */
export function rotateGenericOAuthAccountOnError(
  config: OcxConfig,
  providerName: string,
  failedAccountId: string,
  status: number,
  retryAfterHeader?: string | null,
  now = Date.now(),
  requestedModelId?: string | null,
  errorText?: string,
): string | null {
  if (!isGenericOAuthFailoverStatus(status, providerName, errorText)) return null;
  if (status === 403 && !isAntigravityValidationRequired(errorText)) return null;
  if (status === 429) {
    return rotateGenericOAuthAccountOn429(
      config,
      providerName,
      failedAccountId,
      retryAfterHeader,
      now,
      requestedModelId,
    );
  }
  if (!isGenericOAuthFailoverEnabled(config, providerName)) return null;
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length < 2) return null;

  if (status === 403) recordAccountValidationRequired(providerName, failedAccountId, now);
  else recordAccountAuthFailure(providerName, failedAccountId, now);
  sweepExpiredOnWrite(now);
  return nextGenericOAuthFailoverAccount(config, providerName, failedAccountId, now, requestedModelId);
}

/**
 * Full credential snapshot for a rotated account.
 *
 * Returns the snapshot rather than a bare bearer: Antigravity pairs an account-matched
 * `projectId` with its token and Kiro carries routing metadata, so a token-only swap would mix
 * one account's bearer with another's routing data.
 */
export async function failoverAccountSnapshot(
  providerName: string,
  accountId: string,
): Promise<OAuthAccessSnapshot> {
  return getValidAccessSnapshotForAccount(providerName, accountId);
}

/**
 * Which account should serve the FIRST attempt of a request.
 *
 * Rotation only ever ran after a 429, so a turn still opened on whichever account happened
 * to be active — including one a previous probe already measured as spent. That costs a
 * full upstream round trip and one of three rotations to rediscover what the cache knew.
 *
 * Returns null whenever the ordinary active-account path should be used unchanged: no
 * quorum, rotation disabled, a single account, or no quota evidence to act on. This is a
 * preference, never a gate — a cooled or unmeasured account is still perfectly usable, so
 * an empty answer means "carry on", not "refuse".
 */
export function preferredInitialAccount(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  requestedModelId?: string | null,
): string | null {
  // The PROACTIVE predicate, not the reactive one: this steers a request upstream has not
  // refused, so `oauthAccountFailover.enabled: false` must still be able to refuse it.
  if (!isProactivePreferenceEnabled(config, providerName, now)) return null;
  // Read the same authoritative selection the management writer commits. Caching the
  // active id separately would delay manual selection and account removal.
  const selected = getAccountSet(providerName);
  if (!selected) return null;
  const active = selected.activeAccountId;
  const order = selected.accounts.filter(account => account.needsReauth !== true).map(account => account.id);
  if (order.length < 2) return null;

  // A configured strategy answers this question itself. Both guards below exist to protect the
  // QUOTA answer, and both are fatal to the other two: hasHeadroomEvidence refuses every
  // provider with no quota data, which is exactly where round-robin is the point, and the
  // healthy-active return fires before autoSwitchThreshold can ever be read, so fill-first
  // would never reach its own test. Cooldowns and reauth are still honoured inside each pick.
  const strategy = activeGenericStrategy(config, providerName);
  if (strategy === "round-robin") {
    const family = classifyModelFamilyForQuota(providerName, requestedModelId);
    const eligibleNow = eligibleFailoverAccounts(providerName, now, family);
    if (eligibleNow.length === 0) return null;
    // PEEK, not pick: this proposal is discardable, and advancing the ring for an account the
    // resolver then rejects would skip a turn for nothing. noteGenericPoolSelection commits.
    const picked = peekRoundRobinAccount(
      genericPoolKey(providerName),
      eligibleNow,
      genericStickyLimit(config, providerName),
    );
    return picked && picked !== active ? picked : null;
  }
  if (strategy === "fill-first") {
    const picked = pickFillFirstGenericAccount(config, providerName, active, now, requestedModelId);
    return picked && picked !== active ? picked : null;
  }

  const activeRow = selected.accounts.find(account => account.id === active);
  const family = classifyModelFamilyForQuota(providerName, requestedModelId);
  const activeCooled = activeRow && activeRow.needsReauth !== true
    ? isCooled(providerName, activeRow.id, now, family)
    : false;
  flushHealthCacheIfDirty();
  const activeHealthy = activeRow && activeRow.needsReauth !== true
    && !activeCooled
    && isAccountHealthy(providerName, activeRow.id, now)
    && !isAccountQuotaExhausted(providerName, activeRow.id, requestedModelId);
  if (activeHealthy) return null;

  // Cooldowns and health status are respected here: this picks the account to
  // send to right now, and one inside its cooldown window or flagged for verification is excluded.
  const eligible = eligibleFailoverAccounts(providerName, now, family);
  if (eligible.length === 0) return null;

  // Start the ring at the active account so an unranked outcome reproduces today's choice.
  const start = active ? order.indexOf(active) : -1;
  const ring = start >= 0 ? [...order.slice(start), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => eligible.includes(id));
  if (candidates.length === 0) return null;

  if (hasHeadroomEvidence(providerName, order, requestedModelId)) {
    const best = rankAccountsByHeadroom(providerName, candidates, requestedModelId)[0] ?? null;
    return best && best !== active ? best : null;
  }

  // Active account is unhealthy (cooled or needs reauth) and provider has no quota telemetry:
  // proactively steer to the next uncooled eligible candidate in the ring so we avoid hammering
  // an account known to be in cooldown or failing auth.
  const nextCandidate = candidates.find(id => id !== active) ?? candidates[0] ?? null;
  return nextCandidate && nextCandidate !== active ? nextCandidate : null;
}

/** Earliest remaining cooldown, for a client-facing Retry-After when every account is cooled. */
export function genericFailoverRetryAfterSeconds(providerName: string, now = Date.now()): number | null {
  ensureHealthCache();
  const set = getAccountSet(providerName);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const accountKey = healthKey(providerName, account.id);
    for (const [key, entry] of health) {
      if (key !== accountKey && !key.startsWith(`${accountKey}\u0000`)) continue;
      if (entry.cooldownUntil <= now) continue;
      if (earliest === null || entry.cooldownUntil < earliest) earliest = entry.cooldownUntil;
    }
  }
  return earliest === null ? null : Math.max(1, Math.ceil((earliest - now) / 1000));
}

/** Test seam and manual-recovery hook. */
export function forgetGenericFailoverRoster(providerName: string): void {
  presence.delete(providerName);
}

/** Test seam and manual-recovery hook. */
export function clearGenericFailoverHealth(providerName?: string): void {
  ensureHealthCache();
  if (!providerName) {
    health.clear();
    presence.clear();
    saveHealthCache();
    stopGenericAccountHealthSweep();
    return;
  }
  presence.delete(providerName);
  for (const key of [...health.keys()]) {
    if (key.startsWith(`${providerName}\u0000`)) health.delete(key);
  }
  saveHealthCache();
}

/** Probe a flagged Antigravity account through the existing bounded quota/model probe. */
export async function probeGenericOAuthAccount(
  providerName: string,
  accountId: string,
): Promise<{ ok: boolean; status: number }> {
  if (providerName !== ANTIGRAVITY_FAILOVER_PROVIDER) return { ok: false, status: 501 };
  try {
    const snap = await getValidAccessSnapshotForAccount(ANTIGRAVITY_FAILOVER_PROVIDER, accountId);
    if (!snap.accessToken || !snap.projectId) return { ok: false, status: 401 };
    // Dynamic import keeps the quota transport out of the hot request-path module graph.
    const { probeAntigravityUsageQuota } = await import("../providers/quota/antigravity");
    const result = await probeAntigravityUsageQuota(snap.accessToken, snap.projectId);
    if (result.kind === "available") return { ok: true, status: 200 };
    if (result.failure === "access_denied") return { ok: false, status: 403 };
    if (result.failure === "rate_limited") return { ok: false, status: 429 };
    return { ok: false, status: 500 };
  } catch {
    return { ok: false, status: 500 };
  }
}

const HEALTH_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Probe only accounts already flagged by a real Antigravity auth failure. */
export async function sweepAndHealAccounts(providerName = ANTIGRAVITY_FAILOVER_PROVIDER): Promise<void> {
  ensureHealthCache();
  if (providerName !== ANTIGRAVITY_FAILOVER_PROVIDER) return;
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length === 0) return;
  const now = Date.now();

  for (const account of set.accounts) {
    const entry = health.get(healthKey(providerName, account.id));
    const flagged = entry?.status === "validation_required" || entry?.status === "auth_failure";
    if (!entry || !flagged || entry.cooldownUntil > now) continue;
    if (now - entry.lastCheckedAt < HEALTH_SWEEP_INTERVAL_MS) continue;

    const result = await probeGenericOAuthAccount(providerName, account.id);
    if (result.ok) {
      recordAccountHealthy(providerName, account.id, now);
      console.log(`[opencodex] Self-healing: account ${providerName}/${account.id.slice(0, 8)} re-verified & restored to rotation pool!`);
      continue;
    }

    // A failed probe is evidence only that the account is still unavailable. Preserve the
    // request-path classification and advance the check timestamp so non-200 results do not
    // turn into an eager retry loop.
    health.set(healthKey(providerName, account.id), { ...entry, lastCheckedAt: now });
    saveHealthCache();
  }
}

export function startGenericAccountHealthSweep(): void {
  if (sweepTimer) return;
  sweepStartTimer = setTimeout(() => {
    sweepStartTimer = null;
    void sweepAndHealAccounts(ANTIGRAVITY_FAILOVER_PROVIDER);
  }, 5_000);
  sweepStartTimer.unref?.();

  sweepTimer = setInterval(() => {
    void sweepAndHealAccounts(ANTIGRAVITY_FAILOVER_PROVIDER);
  }, HEALTH_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopGenericAccountHealthSweep(): void {
  if (sweepStartTimer) {
    clearTimeout(sweepStartTimer);
    sweepStartTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

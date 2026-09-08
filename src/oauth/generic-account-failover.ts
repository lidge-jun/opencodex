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
import { getAccountSet } from "./store";
import { getValidAccessSnapshotForAccount, type OAuthAccessSnapshot } from "./index";
import { exhaustedCooldownMs, hasHeadroomEvidence, isAccountQuotaExhausted, rankAccountsByHeadroom } from "./account-quota-rank";
import { parseRetryAfterMs } from "../combos/failover";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import type { OcxConfig, OcxProviderConfig } from "../types";

/** Cap same-request rotations so a short Retry-After cannot spin. Mirrors the Anthropic bound. */
export const GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST = 3;

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

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

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
}

interface PresenceEntry {
  eligible: number;
  readAt: number;
}

/** Process-local, like the Anthropic pool's: a restart is allowed to forget a cooldown. */
const health = new Map<string, AccountHealth>();

/** Provider -> recent eligible-account count. TTL-bounded; never holds credential material. */
const presence = new Map<string, PresenceEntry>();

const healthKey = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;

function isCooled(provider: string, accountId: string, now: number): boolean {
  const entry = health.get(healthKey(provider, accountId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    health.delete(healthKey(provider, accountId));
    return false;
  }
  return true;
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

/** Accounts that may serve traffic right now: not cooled, not flagged for reauth. */
export function eligibleFailoverAccounts(providerName: string, now = Date.now()): string[] {
  const set = getAccountSet(providerName);
  if (!set) return [];
  return set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(providerName, account.id, now))
    .map(account => account.id);
}

/**
 * Cool the account that actually 429'd and name the next eligible one, or null.
 *
 * Returns the id only; the caller mints the credential so a failed refresh does not leave the
 * cooldown applied to an account we then could not use.
 */
export function rotateGenericOAuthAccountOn429(
  config: OcxConfig,
  providerName: string,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!isGenericOAuthFailoverEnabled(config, providerName)) return null;
  const set = getAccountSet(providerName);
  // A single stored account has nowhere to go; rotating to itself would just replay the 429.
  if (!set || set.accounts.length < 2) return null;

  const parsed = parseRetryAfterMs(retryAfterHeader, now, { preserveImmediate: true });
  // An account whose allowance is provably spent gets a reset-aligned cooldown instead of
  // the default minute: retrying it every 60s until the window rolls over is pure waste.
  // A Retry-After from upstream still wins — it is the server's own instruction.
  const exhausted = parsed === undefined ? exhaustedCooldownMs(providerName, failedAccountId, now) : null;
  const cooldownMs = exhausted ?? Math.min(parsed ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  health.set(healthKey(providerName, failedAccountId), {
    cooldownUntil: now + cooldownMs,
    cooldownSource: parsed ? "retry-after" : "default",
  });
  sweepExpiredOnWrite(now);

  const eligible = eligibleFailoverAccounts(providerName, now).filter(id => id !== failedAccountId);
  if (eligible.length === 0) return null;
  // A rotation means the roster in use just changed; do not answer the next activation question
  // from a count read before the failure.
  presence.delete(providerName);
  // Deterministic: start after the failed account so repeated 429s walk the roster instead of
  // hammering whichever id happens to sort first. The ring is built BEFORE ranking — ranking
  // the store's own order would change which account a quota-less provider rotates to.
  const order = set.accounts.map(account => account.id);
  const start = order.indexOf(failedAccountId);
  const ring = start >= 0 ? [...order.slice(start + 1), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id));
  if (candidates.length === 0) return null;
  // With no quota evidence this returns the ring untouched, so providers without
  // per-account quota keep exactly the traversal they have today.
  return rankAccountsByHeadroom(providerName, candidates)[0] ?? null;
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

  const activeRow = selected.accounts.find(account => account.id === active);
  if (activeRow && activeRow.needsReauth !== true
    && !isCooled(providerName, activeRow.id, now)
    && !isAccountQuotaExhausted(providerName, activeRow.id)) return null;

  // Evidence is required BEFORE eligibility narrows the field. Without this, a provider
  // with no quota data at all could still be redirected: cool the active account with a
  // 429 and the eligible list collapses to one candidate, which any ranking returns
  // unchanged — an answer that looks ranked but was never measured. The no-op guarantee
  // for quota-less providers has to be checked on the full roster.
  if (!hasHeadroomEvidence(providerName, order)) return null;

  // Cooldowns are respected here, unlike in the presence count: this picks the account to
  // send to right now, and one inside its 429 window is the single candidate we hold
  // positive evidence against.
  const eligible = order.filter(id => !isCooled(providerName, id, now));
  if (eligible.length === 0) return null;

  // Start the ring at the active account so an unranked outcome reproduces today's choice.
  const start = active ? order.indexOf(active) : -1;
  const ring = start >= 0 ? [...order.slice(start), ...order.slice(0, start)] : order;
  const candidates = ring.filter(id => eligible.includes(id));
  if (candidates.length === 0) return null;

  const best = rankAccountsByHeadroom(providerName, candidates)[0] ?? null;
  // Nothing to do when the ranking agrees with the account we would have used anyway.
  //
  // A proposal still needs guarded selection commit after credential resolution: a
  // removal, reauth verdict, or manual choice can arrive during that await.
  return best && best !== active ? best : null;
}

/** Earliest remaining cooldown, for a client-facing Retry-After when every account is cooled. */
export function genericFailoverRetryAfterSeconds(providerName: string, now = Date.now()): number | null {
  const set = getAccountSet(providerName);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const entry = health.get(healthKey(providerName, account.id));
    if (!entry || entry.cooldownUntil <= now) continue;
    if (earliest === null || entry.cooldownUntil < earliest) earliest = entry.cooldownUntil;
  }
  return earliest === null ? null : Math.max(1, Math.ceil((earliest - now) / 1000));
}

/** Test seam and manual-recovery hook. */
export function forgetGenericFailoverRoster(providerName: string): void {
  presence.delete(providerName);
}

/** Test seam and manual-recovery hook. */
export function clearGenericFailoverHealth(providerName?: string): void {
  if (!providerName) {
    health.clear();
    presence.clear();
    return;
  }
  presence.delete(providerName);
  for (const key of [...health.keys()]) {
    if (key.startsWith(`${providerName}\u0000`)) health.delete(key);
  }
}

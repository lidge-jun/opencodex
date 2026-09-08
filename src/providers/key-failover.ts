/**
 * Multi-key 429 failover for non-OpenAI providers.
 *
 * When a provider's upstream returns 429, this module picks the next available key
 * from `apiKeyPool`, puts the exhausted key into cooldown (respecting Retry-After),
 * and returns a fresh provider config with the swapped key. If all keys are in
 * cooldown, returns null so the caller surfaces the 429 to the client.
 *
 * Modelled after src/codex/routing.ts cooldown logic but scoped to plain API-key pools.
 */
import { commitProviderApiKeySelection } from "./api-key-selection";
import type { ProviderApiKeySelection } from "../types/provider";
import { routedProviderConfig } from "../router";
import type { OcxConfig, OcxProviderConfig, RateLimitRetryPolicy, TransientRetryPolicy } from "../types";
import { OPENCODE_GO_SESSION_HEADER } from "./opencode-go-transport";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // cap at 10 min for api-key rotation

/**
 * Default same-target 429 retry policy used when a provider opts in via a bare
 * `retryOn429: {}` (presence = opt-in with these defaults).
 */
const DEFAULT_RATE_LIMIT_RETRY = {
  enabled: true,
  attempts: 3,
  intervalMs: 5_000,
  maxIntervalMs: 60_000,
  respectRetryAfter: true,
} as const satisfies Required<RateLimitRetryPolicy>;

/**
 * Default transient-5xx retry used when a provider opts in with a bare
 * `transientRetryOn5xx: {}`. `attempts` is a TOTAL send budget, not extra retries.
 */
const DEFAULT_TRANSIENT_RETRY = {
  enabled: true,
  attempts: 3,
} as const satisfies Required<TransientRetryPolicy>;

/** Map<`${providerName}\0${keyId}`, KeyCooldown> */
const keyCooldowns = new Map<string, KeyCooldown>();

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

/**
 * Parse an upstream `Retry-After` header: numeric seconds (including `0`) or an HTTP-date.
 * Returns a bounded delay in ms (1..MAX_COOLDOWN_MS), or undefined when the value is
 * malformed. An HTTP-date already in the past yields an immediate (1 ms) retry.
 */
function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  // A valid HTTP-date whose retry time has already passed is an immediate retry, exactly like
  // numeric `Retry-After: 0` — never a malformed-header fallback to the fixed interval.
  return Math.min(Math.max(delay, 1), MAX_COOLDOWN_MS);
}

/**
 * True while the given key is inside its 429 cooldown window (lazily evicting the entry once the
 * window expires). Used to skip keys that the upstream just rate-limited during failover.
 */
function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

// ---- public API ----

/**
 * Check whether a provider has multiple keys available for failover.
 * Returns true only for key-auth providers with 2+ pool entries.
 */
export function hasKeyPoolFailover(provider: OcxProviderConfig): boolean {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  return (provider.apiKeyPool?.length ?? 0) >= 2;
}

/**
 * Normalize a provider's `retryOn429` policy, or return null when the knob is absent,
 * explicitly disabled, or the provider is not key-auth (OAuth/forward credentials must not be
 * replayed on the same token, forward passthrough never reaches the recovery loop anyway, and
 * local runtimes have no remote key to preserve). The returned policy is fully defaulted so
 * callers never re-check fields.
 */
export function rateLimitRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "retryOn429" | "authMode">,
): Required<RateLimitRetryPolicy> | null {
  const policy = provider.retryOn429;
  if (!policy || policy.enabled === false) return null;
  // Fail closed: only explicit key auth or the documented omitted-default (undefined == key for
  // custom API-key providers) may use same-key replays. OAuth/forward are never replayed on the
  // same token, local runtimes have no remote key to preserve, and unknown/custom values are
  // rejected rather than guessed at.
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_RATE_LIMIT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_RATE_LIMIT_RETRY.attempts,
    intervalMs: policy.intervalMs ?? DEFAULT_RATE_LIMIT_RETRY.intervalMs,
    maxIntervalMs: policy.maxIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY.maxIntervalMs,
    respectRetryAfter: policy.respectRetryAfter ?? DEFAULT_RATE_LIMIT_RETRY.respectRetryAfter,
  };
}

/**
 * Normalize a provider's `transientRetryOn5xx` policy, or return null when it is absent,
 * explicitly disabled, not key-auth, or not the `openai-chat` adapter.
 *
 * The adapter gate is part of the accepted scope, not incidental: this first version covers
 * key-auth `openai-chat` only, and without an explicit check any generic key-auth adapter
 * could opt in. Auth mode follows the same fail-closed rule as `rateLimitRetryPolicyFor` —
 * explicit `key` or the documented omitted default, never OAuth, forward, local, or an
 * unknown value.
 */
export function transientRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "transientRetryOn5xx" | "authMode" | "adapter">,
): Required<TransientRetryPolicy> | null {
  const policy = provider.transientRetryOn5xx;
  if (!policy || policy.enabled === false) return null;
  if (provider.adapter !== "openai-chat") return null;
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_TRANSIENT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_TRANSIENT_RETRY.attempts,
  };
}

/**
 * Wait before the next same-target replay: upstream Retry-After (seconds or HTTP-date) when
 * `respectRetryAfter` is on and the header parses, capped at `maxIntervalMs`; otherwise the
 * fixed `intervalMs`, also capped at `maxIntervalMs` (a single wait never exceeds the cap).
 * Malformed headers fall back to the fixed interval.
 */
export function rateLimitRetryDelayMs(
  policy: Required<RateLimitRetryPolicy>,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number {
  const raw = retryAfterHeader?.trim();
  if (policy.respectRetryAfter && raw) {
    const parsed = parseRetryAfterMs(raw, now);
    if (parsed !== undefined) return Math.min(parsed, policy.maxIntervalMs);
  }
  return Math.min(policy.intervalMs, policy.maxIntervalMs);
}

/**
 * Record a 429 for the current key and attempt to switch to the next available one.
 *
 * @returns A new OcxProviderConfig with the swapped key (and mutated config on disk),
 *          or `null` when no alternative key is available (all in cooldown or pool < 2).
 *
 * The returned object is a snapshot of the PERSISTED config — it carries none of the
 * registry backfills `routedProviderConfig` merges in at request time. Request paths must
 * not assign it to an active route wholesale; use `rotateProviderTransportOn429`, which
 * rebuilds from this committed row, reapplies registry metadata, and retains only explicit
 * runtime transport state (`fetch` and generated OpenCode session affinity).
 */
function rotateKeyAfterFailure(
  config: OcxConfig,
  providerName: string,
  failureStatus: 401 | 429,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return null;

  const failedKey = attemptedSelection?.reference ?? attemptedKey ?? provider.apiKey;
  type Rotation =
    | { failedId?: string; candidateId?: string }
    | { exhaustedCount: number; failedId?: string };
  const outcome = commitProviderApiKeySelection<Rotation | null>(config, providerName, freshProvider => {
    const pool = freshProvider.apiKeyPool;
    if (!pool || pool.length < 2) return { changed: false, value: null };

    // The callback can be rerun after rebasing, so identify the failed key here but
    // defer the in-memory cooldown side effect until persistence has succeeded.
    const failedEntry = attemptedSelection?.entryId
      ? pool.find(entry => entry.id === attemptedSelection.entryId && entry.key === failedKey)
      : pool.find(entry => entry.key === failedKey);

    if (freshProvider.apiKey !== failedKey) {
      const activeEntry = pool.find(entry => entry.key === freshProvider.apiKey);
      if (activeEntry && !isKeyInCooldown(providerName, activeEntry.id, now)) {
        return {
          changed: false,
          value: { failedId: failedEntry?.id },
        };
      }
    }

    const currentIndex = failedEntry ? pool.indexOf(failedEntry) : -1;
    const candidateCount = failedEntry ? pool.length - 1 : pool.length;
    for (let offset = 1; offset <= candidateCount; offset += 1) {
      const candidate = pool[(currentIndex + offset) % pool.length]!;
      if (isKeyInCooldown(providerName, candidate.id, now)) continue;
      freshProvider.apiKey = candidate.key;
      return {
        changed: true,
        value: {
          failedId: failedEntry?.id,
          candidateId: candidate.id,
        },
      };
    }
    return { changed: false, value: { exhaustedCount: pool.length, failedId: failedEntry?.id } };
  }, attemptedSelection);
  if (outcome.status === "unavailable") return null;
  if (outcome.status === "superseded") {
    // A newer manual selection (including A→B→A) owns subsequent dispatch. Reusing the
    // same failed key here would loop forever; preserve its original failure instead.
    return outcome.provider.apiKey !== failedKey ? structuredClone(outcome.provider) : null;
  }
  if (outcome.value === null) return null;
  if (outcome.value.failedId) {
    // A 401 is a verdict about the credential itself, not a timing signal: the key is rejected
    // until an operator replaces it, and upstreams send no Retry-After for it. Hold it for the
    // full cap instead of the 429 default so a dead key is not re-tried once a minute.
    const cooldownMs = failureStatus === 401
      ? MAX_COOLDOWN_MS
      : parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
    keyCooldowns.set(cooldownKey(providerName, outcome.value.failedId), { cooldownUntil: now + cooldownMs });
    sweepExpiredOnWrite(now);
  }
  if ("exhaustedCount" in outcome.value) {
    console.warn(`[key-failover] ${providerName}: all ${outcome.value.exhaustedCount} keys in cooldown after ${failureStatus}; returning the upstream status to the client`);
    return null;
  }

  const committed = structuredClone(outcome.provider);
  config.providers[providerName] = committed;
  if (outcome.value.candidateId) {
    console.warn(
      // Log ids only — labels are user-supplied free text and could carry secret material.
      `[key-failover] ${providerName}: ${failureStatus} on key ${outcome.value.failedId ?? "?"}; rotating to key ${outcome.value.candidateId}`,
    );
  }
  return structuredClone(committed);
}

export function rotateKeyOn429(
  config: OcxConfig,
  providerName: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, 429, retryAfterHeader, now, attemptedKey, attemptedSelection);
}

/**
 * Record a 401 for the current key and attempt to switch to the next available one.
 *
 * A static key pool can recover a credential-scoped 401 without abandoning the provider: one
 * revoked or mistyped key in a pool of several says nothing about its siblings. OAuth and
 * forward providers never reach here — they refresh or re-authenticate instead, and
 * `rotateKeyAfterFailure` rejects both auth modes outright.
 */
export function rotateKeyOn401(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, 401, null, now, attemptedKey, attemptedSelection);
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

interface RotateProviderTransportOptions {
  retryAfter?: string | null;
  now?: number;
  attemptedKey?: string;
  attemptedSelection?: ProviderApiKeySelection;
  promptCacheKey?: string;
}

/**
 * Rotate a failed key and re-apply provider-specific transport metadata to the replacement.
 *
 * Route the authoritative committed row again so concurrent provider edits take effect, then
 * restore only transport-only state that can never come from persisted configuration.
 */
export function rotateProviderTransportOn429(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn429(
    config,
    providerName,
    options.retryAfter,
    options.now,
    options.attemptedKey,
    options.attemptedSelection ?? routedProvider._apiKeyAttempt,
  );
  if (!rotated) return null;
  return applyRotatedTransport(providerName, routedProvider, rotated, options.promptCacheKey);
}

/** 401 counterpart of `rotateProviderTransportOn429`; shares its transport-rebuild rules. */
export function rotateProviderTransportOn401(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: Omit<RotateProviderTransportOptions, "retryAfter"> = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn401(config, providerName, options.now, options.attemptedKey,
    options.attemptedSelection ?? routedProvider._apiKeyAttempt);
  if (!rotated) return null;
  return applyRotatedTransport(providerName, routedProvider, rotated, options.promptCacheKey);
}

function applyRotatedTransport(
  providerName: string,
  routedProvider: OcxProviderTransport,
  rotated: OcxProviderConfig,
  promptCacheKey?: string,
): OcxProviderTransport {
  const committedRoute = routedProviderConfig(providerName, rotated);
  const routedSession = routedProvider.headers?.[OPENCODE_GO_SESSION_HEADER];
  const retryProvider: OcxProviderTransport = {
    ...committedRoute,
    ...(routedProvider.fetch !== undefined ? { fetch: routedProvider.fetch } : {}),
    ...(routedSession !== undefined
      ? {
          headers: {
            ...(committedRoute.headers ?? {}),
            [OPENCODE_GO_SESSION_HEADER]: routedSession,
          },
        }
      : {}),
  };
  return resolveProviderTransport(providerName, retryProvider, promptCacheKey);
}

/** Clear cooldown state for a provider (e.g. after manual key management). */
export function clearKeyCooldowns(providerName?: string): void {
  if (!providerName) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}

/** Visible-for-testing: get the cooldown-until timestamp for a key. */
export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}

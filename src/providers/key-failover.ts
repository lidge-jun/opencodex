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
import { getProviderRegistryEntry } from "./registry";
import { normalizedBaseUrl } from "./quota/vendor-probes-key";
import type { OcxConfig, OcxProviderConfig, RateLimitRetryPolicy, TransientRetryPolicy } from "../types";
import { OPENCODE_GO_SESSION_HEADER } from "./opencode-go-transport";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
// quota-key-accounts imports only node:crypto, the key store and the quota types -- NOT
// providers/quota.ts -- so the cached reader reaches the dispatch path without dragging the
// probe machinery onto it.
import { cachedApiKeyQuota } from "./quota-key-accounts";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // cap at 10 min for api-key rotation

/**
 * Cap for a cooldown the upstream itself dated, as opposed to one we inferred.
 *
 * `MAX_COOLDOWN_MS` is deliberately short because an undated 429 is a guess: ten
 * minutes bounds how long a transient limit can park a working key. A free-tier
 * quota is not a guess — OpenRouter replies `Weekly/Monthly Limit Exhausted ...
 * will reset at <date>`, and until that date the key cannot serve anything. Held
 * for ten minutes instead, it comes back, takes a 429, and rotates again, every
 * ten minutes for the rest of the week (#4024).
 *
 * 32 days rather than unbounded. The wording this parses is
 * `Weekly/Monthly Limit Exhausted`, so the cap has to clear a monthly window —
 * 31 days plus a day of slack for timezone and month length. An earlier 8-day
 * cap looked generous against the weekly case in the issue and silently clamped
 * every monthly reset to ~23 days early, which puts the key back into exactly
 * the 429 loop this exists to stop. Caught by the cap's own test.
 *
 * Bounded at all because the date is upstream-controlled input: a malformed or
 * hostile `reset at 2999-01-01` must not park a working key past any horizon an
 * operator would think to look at.
 */
const MAX_QUOTA_COOLDOWN_MS = 32 * 24 * 60 * 60_000;
const QUOTA_RESET_PEEK_TIMEOUT_MS = 250;

interface QuotaResetReadOptions {
  now?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function rebuiltResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function replayOnlyResponse(response: Response, chunks: readonly Uint8Array[]): Response {
  return rebuiltResponse(response, new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
}

/**
 * Read a bounded prefix of a 429 body and pull the upstream's declared reset instant.
 *
 * The returned response replays the bounded prefix and any boundary-chunk overflow
 * before streaming the unread remainder. A rotation storm must not be gated on
 * reading N full error payloads. Any failure — no body, already consumed, slow,
 * malformed — returns undefined and leaves the `Retry-After` path in charge.
 */
export async function readQuotaResetAt(
  response: Response,
  nowOrOptions: number | QuotaResetReadOptions = {},
): Promise<{ at: number | undefined; response: Response }> {
  if (!response.body) return { at: undefined, response };
  const options = typeof nowOrOptions === "number" ? { now: nowOrOptions } : nowOrOptions;
  const now = options.now ?? Date.now();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { at: undefined, response };
  }
  const chunks: Uint8Array[] = [];
  let transferred = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new AbortController();
  const timeoutReason = new DOMException("Quota reset body peek timed out", "TimeoutError");
  try {
    const decoder = new TextDecoder();
    let seen = 0;
    let text = "";
    timer = setTimeout(() => deadline.abort(timeoutReason), options.timeoutMs ?? QUOTA_RESET_PEEK_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    while (seen < QUOTA_RESET_SCAN_BYTES) {
      const read = reader.read();
      let rejectAbort: ((reason: unknown) => void) | undefined;
      const onAbort = () => rejectAbort?.(signal.reason);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      // Derived from the reader rather than named directly: Bun's lib types
      // `ReadableStreamDefaultReader.read()` as returning
      // `ReadableStreamDefaultReadResult`, which is not assignable to the
      // `ReadableStreamReadResult` alias.
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([read, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const { done, value } = result;
      if (done) break;
      const remaining = QUOTA_RESET_SCAN_BYTES - seen;
      const prefix = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      const overflow = value.byteLength > remaining ? value.subarray(remaining) : undefined;
      chunks.push(prefix);
      if (overflow?.byteLength) chunks.push(overflow);
      seen += prefix.byteLength;
      text += decoder.decode(prefix, { stream: true });
    }
    // Hand back a Response carrying the bytes already pulled followed by whatever
    // is left, so the caller can still read or cancel it. `response.clone()` is
    // NOT usable here: it tees, and with the original branch undrained the tee
    // stalls once its buffer fills — a 5MB error body hangs the rotation path,
    // which is worse than the unbounded read this replaced.
    const rest = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });
    transferred = true;
    return { at: parseQuotaResetAt(text, now), response: rebuiltResponse(response, rest) };
  } catch (error) {
    const clientAborted = options.signal?.aborted === true;
    void reader.cancel(error).catch(() => {}).finally(() => {
      try { reader.releaseLock(); } catch { /* already released */ }
    });
    if (clientAborted) throw options.signal!.reason ?? error;
    return { at: undefined, response: replayOnlyResponse(response, chunks) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!transferred) {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

/**
 * How much of a 429 body is read and scanned for the reset instant.
 *
 * Bounds the READ, not just the parse: this runs on the rotation path, once per
 * rotated key under a rate-limit storm, and the body is upstream-controlled.
 * OpenRouter's rate_limit_error JSON is a few hundred bytes.
 */
const QUOTA_RESET_SCAN_BYTES = 4_096;

/**
 * Reset instant an upstream declared in a 429 *body*, in epoch ms.
 *
 * Only the body carries this: OpenRouter sends no `Retry-After` for a quota
 * exhaustion, so the header path (`parseRetryAfterMs`) sees nothing and falls
 * back to `DEFAULT_COOLDOWN_MS`. Returns undefined for anything it cannot read
 * as a date, so an unparsable body keeps today's behaviour exactly.
 */
/**
 * Whether `YYYY-MM-DD…` names a day that exists.
 *
 * `Date.parse` does NOT reject an out-of-range day: measured on Bun,
 * `2026-02-30T00:00:00Z` yields March 2 and `2026-04-31T00:00:00Z` yields
 * May 1, so a malformed upstream body would park a key past the instant it
 * actually named. Only the month is rejected outright (`2026-13-01` is NaN).
 *
 * Checked on the date text alone rather than by round-tripping the parsed
 * instant, because a value carrying an explicit offset (`…T23:00+05:30`)
 * legitimately lands on a different UTC day than the one written.
 */
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1]!;
}

export function parseQuotaResetAt(body: string | null | undefined, now = Date.now()): number | undefined {
  const text = body?.slice(0, QUOTA_RESET_SCAN_BYTES);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if ((code !== "rate_limit_error" && code !== 429) || typeof message !== "string") return undefined;
  if (!/^(?:Weekly|Monthly) Limit Exhausted\b/i.test(message.trim())) return undefined;
  // `will reset at 2026-09-09 03:30:06` / `... at 2026-09-09T03:30:06Z` / `resets at <date>`
  const match = /reset[s]?\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?)/i.exec(message);
  if (!match) return undefined;
  // Pin a bare `YYYY-MM-DD hh:mm:ss` to UTC explicitly.
  //
  // ECMA-262 says a date-TIME form with no offset is LOCAL time, and Node follows
  // that: `Date.parse("2026-09-09 03:30:06")` differs from the UTC reading by the
  // host offset (7h on a PDT box, measured). Bun currently returns the UTC value
  // for the same string, so on this runtime the normalisation is a no-op today —
  // which is exactly why it is written out rather than relied upon. If Bun ever
  // conforms, an un-normalised parse would silently shift every park-until by the
  // operator's offset, and the early direction resumes the 429 loop.
  //
  // A consequence worth knowing: no Bun test can observe this branch being
  // removed. The explicit-zone case below is the part the suite can pin.
  const raw = match[1].includes("T") || /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/.test(match[1])
    ? match[1]
    : `${match[1].replace(" ", "T")}Z`;
  if (!isRealCalendarDate(match[1])) return undefined;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  // Already past, or beyond the cap: not usable as a park-until instant.
  if (at <= now) return undefined;
  return Math.min(at, now + MAX_QUOTA_COOLDOWN_MS);
}

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
 * Patient same-target 429 fallback for the OpenCode Go destination
 * (https://opencode.ai/zen/go/v1), which serves subscription traffic such as Muse Spark.
 * Single-key pools cannot fail over, so without this a burst 429 surfaces immediately and
 * the client retry budget aborts the goal. Six 10s-paced attempts absorb a short burst
 * window (effective replays are additionally bounded by the shared per-request send
 * budget); Retry-After is still honored and capped. An explicit `retryOn429` (including
 * `enabled: false`) always overrides this fallback.
 */
const OPENCODE_GO_RATE_LIMIT_RETRY = {
  enabled: true,
  attempts: 6,
  intervalMs: 10_000,
  maxIntervalMs: 60_000,
  respectRetryAfter: true,
} as const satisfies Required<RateLimitRetryPolicy>;

/** True when the provider row points at the OpenCode Go destination. */
export function isOpenCodeGoDestination(
  provider: Partial<Pick<OcxProviderConfig, "baseUrl" | "authMode">>,
): boolean {
  const raw = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  if (!raw.trim()) return false;
  // Endpoint identity, not adapter identity: the runtime adapter is already overridden
  // per model by the time the recovery loop runs (muse-spark rides `openai-responses`
  // while the preset declares `openai-chat`), so an adapter-strict lookup misses it.
  // Canonicalize with the shared quota-probe normalizer so host case and explicit
  // default ports compare equal; userinfo, query, and fragment never match
  // (follow-up to the review on #5067).
  const endpoint = normalizedBaseUrl(raw.trim());
  if (!endpoint) return false;
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) return false;
  const candidates = [entry.baseUrl, ...(entry.destinationAliases ?? []).map(alias => alias.baseUrl)];
  return candidates.some(url => normalizedBaseUrl(url.trim()) === endpoint);
}

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
 * Process-local round-robin cursor per provider, deliberately parallel to `keyCooldowns`
 * rather than borrowing the Codex pool-rotation state: an API key is not an OAuth account
 * and must not share a quota scope key. Multi-process desync is the same accepted limit
 * the cooldown map already carries.
 */
const keyRotationCursor = new Map<string, string>();

/**
 * Forget a provider's cursor so an operator's manual key selection is not second-guessed.
 *
 * Optional name, mirroring `clearKeyCooldowns`, because the batch provider PUT rewrites the
 * entire roster: a cursor that survives a reorder still names a real id, so round-robin
 * resumes after the pre-edit position and can skip the first eligible key in the new pool.
 */
export function forgetApiKeyRotationCursor(providerName?: string): void {
  if (!providerName) {
    keyRotationCursor.clear();
    return;
  }
  keyRotationCursor.delete(providerName);
}

/** The pool entry shape is inline on OcxProviderConfig; name it once rather than re-spelling it. */
type ApiKeyPoolEntry = NonNullable<OcxProviderConfig["apiKeyPool"]>[number];

/**
 * Remaining headroom for one key, or null when nothing current measures it.
 *
 * Same definition as `headroomOf` on the OAuth side, so the two pools cannot disagree about
 * what "more room" means. `creditsUsd` is deliberately excluded: it is a currency amount, not
 * a percentage, and ranking one against the other produces an order that means nothing.
 */
function keyHeadroom(providerName: string, provider: OcxProviderConfig, entry: ApiKeyPoolEntry): number | null {
  const quota = cachedApiKeyQuota(providerName, provider, entry.id, entry.key);
  if (!quota) return null;
  const percents = [
    quota.fiveHourPercent,
    quota.weeklyPercent,
    quota.monthlyPercent,
    ...(quota.customWindows ?? []).map((window: { percent?: number }) => window.percent),
  ].filter((value): value is number => typeof value === "number");
  if (percents.length === 0) return null;
  return 100 - Math.max(...percents);
}

/**
 * Order eligible keys best-first, in the same three buckets `rankAccountsByHeadroom` uses:
 * measured-with-headroom, then unmeasured, then measured-and-spent. Ties keep the roster order.
 *
 * An unmeasured key is NOT assumed spent, and not assumed fresh either -- it sits between the
 * two, which is the only honest position for a key nothing has looked at. A provider that
 * publishes no per-key differentiation (DeepSeek reports every key at the same percent) ties
 * across the board and falls through to the roster order, which is exactly today's behaviour.
 */
function rankKeysByHeadroom(
  providerName: string,
  provider: OcxProviderConfig,
  eligible: readonly ApiKeyPoolEntry[],
): ApiKeyPoolEntry[] {
  return eligible
    .map((entry, index) => {
      const headroom = keyHeadroom(providerName, provider, entry);
      const bucket = headroom === null ? 1 : headroom <= 0 ? 2 : 0;
      return { entry, bucket, headroom: headroom ?? 0, index };
    })
    .sort((left, right) => (left.bucket - right.bucket)
      || (right.headroom - left.headroom)
      || (left.index - right.index))
    .map(row => row.entry);
}


/**
 * Pick a better key BEFORE the first attempt when the committed one is already cooling.
 *
 * This is intentionally narrow. It never overrides a healthy key: if the committed
 * `apiKey` is not in cooldown it returns null, so an operator's manual selection stands
 * and no config write happens. It only acts when the committed key is known-cooled (or
 * missing from the pool), which is exactly the case where the first request would
 * otherwise be spent earning a 429 the runtime could already predict.
 *
 * Returning null is the common path, so the persisted-selection transaction is not on
 * the per-request hot path.
 *
 * Like `rotateKeyAfterFailure`, the returned object is a snapshot of the PERSISTED config
 * and carries none of the registry backfills `routedProviderConfig` merges in at request
 * time. A request path must not assign it to an active route wholesale -- for a built-in
 * provider stored in its valid minimal form that would drop the adapter id, the base URL and
 * the static headers, so `resolveAdapter()` throws `Unknown adapter: undefined` and a
 * hand-built URL dereferences a missing `baseUrl`. Use
 * `selectProactiveApiKeyTransport`, the pre-dispatch twin of `rotateProviderTransportOn429`.
 */
export function selectProactiveApiKey(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): OcxProviderConfig | null {
  const provider = config.providers?.[providerName];
  if (!provider) return null;
  const strategy = provider.apiKeyPoolStrategy;
  if (!strategy) return null;
  if (!hasKeyPoolFailover(provider)) return null;
  const pool = provider.apiKeyPool ?? [];

  const activeEntry = pool.find(entry => entry.key === provider.apiKey);
  // A healthy committed key wins, whether the operator chose it or a previous rotation did.
  if (activeEntry && !isKeyInCooldown(providerName, activeEntry.id, now)) return null;

  const eligible = pool.filter(entry => !isKeyInCooldown(providerName, entry.id, now));
  if (eligible.length === 0) return null;

  let chosen = eligible[0]!;
  if (strategy === "round-robin") {
    const lastId = keyRotationCursor.get(providerName);
    const lastIndex = lastId ? pool.findIndex(entry => entry.id === lastId) : -1;
    for (let offset = 1; offset <= pool.length; offset += 1) {
      const candidate = pool[(lastIndex + offset) % pool.length]!;
      if (isKeyInCooldown(providerName, candidate.id, now)) continue;
      chosen = candidate;
      break;
    }
  } else if (strategy === "quota") {
    // else-if, deliberately. `fill-first` is not a named branch here -- it is the eligible[0]
    // default above, so replacing that default would silently retarget it.
    chosen = rankKeysByHeadroom(providerName, provider, eligible)[0] ?? chosen;
  }
  if (chosen.key === provider.apiKey) return null;

  const outcome = commitProviderApiKeySelection<string | null>(config, providerName, freshProvider => {
    const freshPool = freshProvider.apiKeyPool ?? [];
    const target = freshPool.find(entry => entry.id === chosen.id);
    if (!target) return { changed: false, value: null };
    if (freshProvider.apiKey === target.key) return { changed: false, value: null };
    const freshActive = freshPool.find(entry => entry.key === freshProvider.apiKey);
    // Re-check under the lock: a concurrent manual selection may have landed a healthy key.
    if (freshActive && !isKeyInCooldown(providerName, freshActive.id, now)) {
      return { changed: false, value: null };
    }
    freshProvider.apiKey = target.key;
    return { changed: true, value: target.id };
  });
  if (outcome.status !== "committed" || outcome.value === null) return null;

  keyRotationCursor.set(providerName, outcome.value);
  const committed = structuredClone(outcome.provider);
  config.providers[providerName] = committed;
  return structuredClone(committed);
}

/**
 * Pre-dispatch twin of `rotateProviderTransportOn429`: pick a warm key, then rebuild the
 * active route from the committed row through the same seam the 429 path uses, so the
 * registry backfills survive and only explicit runtime transport state (`fetch` and a
 * generated OpenCode session header) is carried over from the route being replaced.
 *
 * Every request path that assigns the result to a live route must call THIS, not
 * `selectProactiveApiKey`, which answers with a persisted snapshot.
 */
export function selectProactiveApiKeyTransport(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  promptCacheKey?: string,
  now = Date.now(),
): OcxProviderTransport | null {
  const committed = selectProactiveApiKey(config, providerName, now);
  if (!committed) return null;
  return applyRotatedTransport(providerName, routedProvider, committed, promptCacheKey);
}

/**
 * Normalize a provider's `retryOn429` policy. An explicit object always wins (including
 * `enabled: false` to opt out). When the knob is absent, the OpenCode Go destination
 * (subscription traffic such as Muse Spark) falls back to a patient same-key policy so a
 * burst 429 waits and replays instead of surfacing to the client and aborting a long
 * session; every other provider without the knob keeps today's fail-fast behavior.
 * OAuth/forward/local credentials are never replayed on the same token. The returned
 * policy is fully defaulted so callers never re-check fields.
 */
export function rateLimitRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "retryOn429" | "authMode"> &
    Partial<Pick<OcxProviderConfig, "baseUrl" | "adapter">>,
): Required<RateLimitRetryPolicy> | null {
  const policy = provider.retryOn429;
  if (policy) {
    if (policy.enabled === false) return null;
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
  // No explicit knob: patient fallback for the OpenCode Go destination only.
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  if (!isOpenCodeGoDestination(provider)) return null;
  return { ...OPENCODE_GO_RATE_LIMIT_RETRY };
}

/**
 * Normalize a provider's `transientRetryOn5xx` policy, or return null when it is absent,
 * explicitly disabled, not key-auth, or not an adapter this policy governs.
 *
 * The adapter gate is part of the accepted scope, not incidental: it names the adapters whose
 * lanes actually read this policy, so no generic key-auth adapter can opt in by accident.
 * Auth mode follows the same fail-closed rule as `rateLimitRetryPolicyFor` —
 * explicit `key` or the documented omitted default, never OAuth, forward, local, or an
 * unknown value.
 */
export function transientRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "transientRetryOn5xx" | "authMode" | "adapter">,
): Required<TransientRetryPolicy> | null {
  const policy = provider.transientRetryOn5xx;
  if (!policy || policy.enabled === false) return null;
  // Both adapters this policy governs. The first version covered chat only, which left a
  // key-auth Responses provider unable to tune its ladder in either direction, because the
  // Responses passthrough lane hard-coded TRANSIENT_RETRY_MAX_ATTEMPTS (#4893). Widening this
  // gate is necessary and not sufficient: the lane also has to call this function, which it
  // now does. Still an explicit list, so no generic key-auth adapter opts in by accident, and
  // the auth check below keeps the ChatGPT forward pool out -- those providers are
  // `authMode: "forward"` and keep the default ladder they have always had.
  if (provider.adapter !== "openai-chat" && provider.adapter !== "openai-responses") return null;
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
  quotaResetAt?: number,
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
      // A reset instant the upstream dated outranks both the header and the
      // default: it is the only one of the three that knows when the quota
      // actually returns (#4024).
      : quotaResetAt !== undefined
        ? Math.max(quotaResetAt - now, 1)
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
  quotaResetAt?: number,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, 429, retryAfterHeader, now, attemptedKey, attemptedSelection, quotaResetAt);
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
  /** Epoch ms from `parseQuotaResetAt`, when the upstream dated the reset in its body. */
  quotaResetAt?: number;
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
    options.quotaResetAt,
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

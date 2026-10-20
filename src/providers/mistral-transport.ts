import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { waitOutsideProviderHeaderDeadline } from "../lib/provider-admission-wait";
import { markSameTargetRetryHold, sleepWithAbort } from "../lib/upstream-retry";
import { RequestPacingQueueOverloadError } from "./request-pacing";
import type { OcxProviderTransport } from "./xai-transport";

const MAX_IDENTITIES = 128;
const DEFAULT_MAX_WAIT_MS = 60_000; // Existing retry wait budget, not an inferred rate window.
const MINUTE_MS = 60 * 1000; // Unit named by the observed headers, never an account quota.
type RecoveryState = { generation: number; probe?: { done: Promise<void>; finish(): void } };

/** Match the supported key-auth Chat destination, including one optional trailing slash. */
export function isCanonicalMistralChat(
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "baseUrl">,
): boolean {
  if (provider.adapter !== "openai-chat" || (provider.authMode !== undefined && provider.authMode !== "key")) return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === "https://api.mistral.ai" && /^\/v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Read a nonnegative integer counter; reject missing or malformed values. */
function count(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Read the server delay as seconds or an HTTP date; ignore invalid hints. */
function retryDelay(headers: Headers, now: number): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** Classify measured refusal evidence only; never predict a future cache hit or token charge. */
export function mistralMinuteRefusal(headers: Headers): "temporary" | "charge-above-allowance" | "unknown" {
  const month = count(headers, "x-ratelimit-limit-tokens-month");
  if (month !== undefined && count(headers, "x-ratelimit-remaining-tokens-month") === 0) return "unknown";
  const limit = count(headers, "x-ratelimit-limit-tokens-minute");
  const remaining = count(headers, "x-ratelimit-remaining-tokens-minute");
  const cost = count(headers, "x-ratelimit-tokens-query-cost");
  if (limit !== undefined && limit > 0 && cost !== undefined && cost > limit) return "charge-above-allowance";
  if (limit !== undefined && limit > 0 && remaining !== undefined && remaining <= limit
    && (remaining === 0 || (cost !== undefined && cost > remaining))) return "temporary";
  const requests = count(headers, "x-ratelimit-limit-req-minute");
  if (requests !== undefined && requests > 0 && count(headers, "x-ratelimit-remaining-req-minute") === 0) return "temporary";
  return "unknown";
}

/** Process-local observations, never a fixed account/plan quota or a persisted credential. */
export class MistralBudgetPacer {
  private readonly deadlines = new Map<string, number>();
  private readonly recoveries = new Map<string, RecoveryState>();
  /** Latest live deadline evicted at capacity; unknown identities wait it out instead of sending early. */
  private evictedUntil = 0;
  private waiting = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort,
  ) {}

  /** Record server delays and confirmed minute pressure for this credential and model. */
  observe(identity: string, headers: Headers, status = 200): void {
    const tokens = count(headers, "x-ratelimit-remaining-tokens-minute");
    const requests = count(headers, "x-ratelimit-remaining-req-minute");
    // Healthy remaining counters never predict the next request's cache/charge.
    if (status !== 429 && tokens !== 0 && requests !== 0) return;
    // With no explicit time, activate a conservative minute hold only AFTER a
    // refusal establishes pressure. Healthy responses never predict the next cost.
    const delay = retryDelay(headers, this.now())
      ?? (status === 429 && mistralMinuteRefusal(headers) === "temporary" ? MINUTE_MS : undefined);
    if (delay === undefined || delay === 0) return;
    for (const [key, deadline] of this.deadlines) {
      if (deadline <= this.now()) this.deadlines.delete(key);
    }
    if (!this.deadlines.has(identity) && this.deadlines.size >= MAX_IDENTITIES) {
      const [evicted, until] = this.deadlines.entries().next().value!;
      this.evictedUntil = Math.max(this.evictedUntil, until);
      this.deadlines.delete(evicted);
    }
    this.deadlines.set(identity, Math.max(this.deadlines.get(identity) ?? 0, this.now() + delay));
    if (status === 429) {
      if (!this.recoveries.has(identity) && this.recoveries.size >= MAX_IDENTITIES) {
        const idle = [...this.recoveries].find(([, state]) => !state.probe);
        if (!idle) return;
        this.recoveries.delete(idle[0]);
      }
      const state = this.recoveries.get(identity) ?? { generation: 0 };
      state.generation++;
      this.recoveries.set(identity, state);
    }
  }

  /** Wait within the admission budget and return a release callback for one recovery probe. */
  async acquire(identity: string, signal?: AbortSignal, maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<(success?: boolean) => void> {
    signal?.throwIfAborted();
    if (this.waiting >= MAX_IDENTITIES) throw new RequestPacingQueueOverloadError("mistral", "queue_full", 60);
    this.waiting++;
    const deadline = this.now() + maxWaitMs;
    try {
      for (;;) {
        signal?.throwIfAborted();
        // An evicted identity may have re-entered with a shorter delay; the evicted one still binds.
        const live = this.evictedUntil > this.now() ? this.evictedUntil : undefined;
        const own = this.deadlines.get(identity);
        const readyAt = own === undefined ? live : live === undefined ? own : Math.max(own, live);
        if (readyAt !== undefined && readyAt > deadline) {
          const delay = readyAt - this.now();
          throw new RequestPacingQueueOverloadError("mistral", "queue_expired", Math.ceil(delay / 1000));
        }
        if (readyAt !== undefined && readyAt > this.now()) {
          await this.sleep(readyAt - this.now(), signal);
          continue;
        }
        const state = this.recoveries.get(identity);
        if (!state) { this.deadlines.delete(identity); return () => {}; }
        if (state.probe) {
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new RequestPacingQueueOverloadError("mistral", "queue_expired", 1);
          const local = new AbortController();
          try {
            await Promise.race([state.probe.done, this.sleep(remaining, AbortSignal.any([local.signal, ...(signal ? [signal] : [])]))]);
          } finally { local.abort(); }
          continue;
        }
        let finish!: () => void;
        const probe = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
        state.probe = probe;
        const generation = state.generation;
        let released = false;
        return success => {
          if (released) return;
          released = true;
          if (state.probe === probe) delete state.probe;
          // Only this probe can settle recovery; an older concurrent success must
          // not erase a more recent refusal or the server's minimum wait.
          if (success && state.generation === generation) {
            if (this.recoveries.get(identity) === state) this.recoveries.delete(identity);
            if ((this.deadlines.get(identity) ?? 0) <= this.now()) this.deadlines.delete(identity);
          }
          probe.finish();
        };
      }
    } finally { this.waiting--; }
  }
}

const pacer = new MistralBudgetPacer();
const wrapped = new WeakSet<typeof globalThis.fetch>();

/** Wrap canonical Mistral Chat sends with bounded admission and server-delay protection. */
export function resolveMistralTransport(
  provider: OcxProviderTransport,
  budgetPacer = pacer,
): OcxProviderTransport {
  if (!isCanonicalMistralChat(provider) || (provider.fetch && wrapped.has(provider.fetch))) return provider;
  const baseFetch = provider.fetch
    ?? markEgressTransparentExecutor(((input, init) => configuredOutboundFetch(input, init)) as typeof globalThis.fetch);
  const attemptFetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.mistral.ai" || url.pathname !== "/v1/chat/completions"
      || url.search || url.hash || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      return baseFetch(input, init);
    }
    // The Chat adapter serializes model first. Read only that bounded prefix rather
    // than parsing/copying a potentially million-token conversation a second time.
    const encodedModel = /^\s*\{\s*"model"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/.exec(init.body.slice(0, 4096))?.[1];
    let model: unknown;
    try { model = encodedModel === undefined ? undefined : JSON.parse(encodedModel); } catch { return baseFetch(input, init); }
    const authorization = new Headers(init.headers).get("authorization");
    if (!authorization || typeof model !== "string" || !model || model.length > 256) return baseFetch(input, init);
    // Bind to the actual send credential, including after pool rotation; keep no raw key.
    const identity = createHash("sha256").update(JSON.stringify([authorization, model])).digest("hex");
    const pacing = provider.requestPacing?.enabled !== false && provider.retryOn429?.respectRetryAfter !== false;
    const release = pacing ? await waitOutsideProviderHeaderDeadline(init,
      signal => budgetPacer.acquire(identity, signal, provider.retryOn429?.maxIntervalMs)) : undefined;
    let response: Response;
    try {
      init.signal?.throwIfAborted();
      response = await baseFetch(input, init);
      if (pacing) budgetPacer.observe(identity, response.headers, response.status);
    } catch (error) { release?.(); throw error; }
    release?.(response.ok);
    const retry = provider.retryOn429;
    if (response.status === 429 && retry?.respectRetryAfter !== false) {
      const delay = retryDelay(response.headers, Date.now());
      if (delay !== undefined && delay > (retry?.maxIntervalMs ?? DEFAULT_MAX_WAIT_MS)) {
        // The shared retry helper caps waits. Stop same-key replays sooner than Mistral permits;
        // another credential may still serve, and the original status/body/Retry-After reach the caller.
        markSameTargetRetryHold(response);
      }
    }
    return response;
  }) as typeof globalThis.fetch;
  if (isEgressTransparentExecutor(baseFetch)) markEgressTransparentExecutor(attemptFetch);
  wrapped.add(attemptFetch);
  return { ...provider, fetch: attemptFetch };
}

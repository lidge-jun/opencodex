import { readBoundedResponseBody } from "../lib/bounded-body";
import { markEgressTransparentExecutor, providerEgressSendInit } from "../lib/provider-egress";
import { configuredOutboundFetch } from "../lib/proxy-env";
import { withUpstreamHttpVersion } from "../lib/upstream-http-version";
import type { OcxProviderConfig } from "../types";

/**
 * Per-key project discovery for Vertex express-mode API keys (`provider.project: "auto"`).
 *
 * An express-mode key belongs to one Google Cloud project, and Google's projectless endpoint
 * echoes `projects/<number>/locations/<region>/...` in its 404 body for a nonexistent model
 * (observed 2026-10-18 across five express-mode keys on `aiplatform.googleapis.com`). That is an
 * undocumented upstream error shape rather than a stable discovery API, so `"auto"` is strictly
 * opt-in and any non-404, truncated, oversized, invalid-UTF-8 or non-matching body falls back to
 * the projectless express endpoint without caching.
 */
export const VERTEX_PROJECT_AUTO = "auto";

const PROBE_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/ocx-project-probe:countTokens";
const PROBE_TIMEOUT_MS = 10_000;
/** Google's 404 JSON for a missing publisher model is ~320 bytes; 4 KiB bounds untrusted bodies. */
export const VERTEX_PROBE_MAX_BYTES = 4096;
const PROJECT_NUMBER = /\bprojects\/(\d{1,20})\/locations\//;
/** Pool sizes are small; the cap only bounds a pathological rotation of distinct keys. */
const CACHE_LIMIT = 64;

/** Keyed by a SHA-256 digest so the cache never retains raw key material. Insertion-order LRU. */
const resolved = new Map<string, string>();

interface ProbeWaiter {
  signal?: AbortSignal;
  resolve: (project: string | undefined) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface InflightProbe {
  controller: AbortController;
  waiters: Set<ProbeWaiter>;
}

const inflight = new Map<string, InflightProbe>();

/** Computes the non-reversible SHA-256 cache key for an API key. */
function cacheKey(apiKey: string): string {
  return new Bun.CryptoHasher("sha256").update(apiKey).digest("base64url");
}

/** Records a resolved project number in the bounded insertion-order LRU cache. */
function remember(key: string, project: string): void {
  resolved.delete(key);
  resolved.set(key, project);
  while (resolved.size > CACHE_LIMIT) resolved.delete(resolved.keys().next().value!);
}

/** Extracts the project number from Google's projectless NOT_FOUND body; exported for tests. */
export function parseVertexProbeProjectNumber(body: string): string | undefined {
  return PROJECT_NUMBER.exec(body)?.[1];
}

export interface VertexKeyProjectOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  provider?: OcxProviderConfig;
  providerName?: string;
  /** Test seam for the bounded-body and request deadline. */
  timeoutMs?: number;
}

const defaultOutboundFetch = markEgressTransparentExecutor(
  ((input: Parameters<typeof fetch>[0], init?: RequestInit) => configuredOutboundFetch(input, init)) as typeof fetch,
);

/** Builds the side-effect-free outbound transport honoring provider egress and HTTP version. */
function selectProbeFetch(options: VertexKeyProjectOptions): typeof fetch {
  if (options.fetch) return options.fetch;
  const provider = options.provider;
  const customFetch = (provider as (OcxProviderConfig & { fetch?: typeof fetch }) | undefined)?.fetch;
  if (!provider) return customFetch ?? globalThis.fetch;
  const base = customFetch ?? defaultOutboundFetch;
  const providerName = options.providerName ?? "google-vertex";
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const egressInit = providerEgressSendInit({ providerName, provider }, base, input);
    const versioned = withUpstreamHttpVersion(input, init, provider);
    return base(input, { ...versioned, ...egressInit });
  }) as typeof fetch;
}

/** Sends one bounded countTokens probe to Google and extracts the project number from a 404 body. */
async function probe(
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const res = await fetchImpl(PROBE_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }),
      signal: probeSignal,
    });
    // Only Google's model NOT_FOUND names the key's project; 401/403/429 and redirects do not.
    if (res.status !== 404) {
      void res.body?.cancel().catch(() => {});
      return undefined;
    }
    const body = await readBoundedResponseBody(res, {
      maxBytes: VERTEX_PROBE_MAX_BYTES,
      totalTimeoutMs: timeoutMs,
      inactivityTimeoutMs: timeoutMs,
      firstByteTimeoutMs: timeoutMs,
      signal: probeSignal,
      reportUtf8Validity: true,
    });
    if (body.truncated || body.oversized || body.timedOut || !body.displaySafe || body.utf8Valid === false) {
      return undefined;
    }
    return parseVertexProbeProjectNumber(body.text);
  } catch {
    return undefined;
  }
}

/** Detaches the abort listener registered for a coalesced probe waiter. */
function cleanupWaiter(waiter: ProbeWaiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

/** Starts a shared in-flight probe and fans the result out to all active waiters. */
function startInflight(
  key: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): InflightProbe {
  const controller = new AbortController();
  const waiters = new Set<ProbeWaiter>();
  const entry: InflightProbe = { controller, waiters };
  inflight.set(key, entry);

  void (async () => {
    let project: string | undefined;
    try {
      project = await probe(apiKey, fetchImpl, controller.signal, timeoutMs);
    } finally {
      if (inflight.get(key) === entry) inflight.delete(key);
    }
    if (project && !controller.signal.aborted) remember(key, project);
    for (const waiter of Array.from(waiters)) {
      cleanupWaiter(waiter);
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else waiter.resolve(project);
    }
  })();

  return entry;
}

/**
 * Resolves the project number that owns `apiKey`, or undefined when Google does not reveal it.
 * Successful lookups are cached per key; failures are not, so a transient error retries next time.
 * Concurrent callers for the same uncached key share one probe; an aborted caller detaches
 * immediately without cancelling the shared probe unless every waiter has aborted.
 */
export async function resolveVertexApiKeyProject(
  apiKey: string,
  options: VertexKeyProjectOptions | typeof fetch = {},
): Promise<string | undefined> {
  const opts: VertexKeyProjectOptions = typeof options === "function" ? { fetch: options } : options;
  const signal = opts.signal;
  signal?.throwIfAborted();

  const key = cacheKey(apiKey);
  const cached = resolved.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }

  // Synchronous egress validation (for example an opaque custom fetch combined with an explicit
  // provider.proxy) must reject the caller rather than being swallowed into an express fallback.
  const fetchImpl = selectProbeFetch(opts);
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const entry = inflight.get(key) ?? startInflight(key, apiKey, fetchImpl, timeoutMs);

  return new Promise<string | undefined>((resolve, reject) => {
    if (signal?.aborted) {
      if (entry.waiters.size === 0) {
        if (inflight.get(key) === entry) inflight.delete(key);
        entry.controller.abort(signal.reason);
      }
      reject(signal.reason);
      return;
    }
    const waiter: ProbeWaiter = { signal, resolve, reject };
    if (signal) {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        entry.waiters.delete(waiter);
        reject(signal.reason);
        if (entry.waiters.size === 0) {
          if (inflight.get(key) === entry) inflight.delete(key);
          entry.controller.abort(signal.reason);
        }
      };
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.waiters.add(waiter);
  });
}

/** Clears the resolved project cache and aborts any in-flight probes for tests. */
export function __resetVertexApiKeyProjectCache(): void {
  resolved.clear();
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
}

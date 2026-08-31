/**
 * Bounded Ollama Cloud `/api/show` metadata enrichment.
 *
 * `/v1/models` is the authoritative live ID roster, but it carries no per-model context or
 * capability metadata, so a newly announced Ollama model (e.g. glm-5.3 during its rollout)
 * would otherwise be advertised to Codex with generic defaults — a 1M-context model published
 * at 128K, and native vision unknown. `/api/show` fills that gap for canonical Ollama Cloud
 * destinations only.
 *
 * The show request reuses the discovery request's already-materialized captured headers
 * (credential + configured-header precedence resolved by `buildModelsRequest`, not re-derived
 * here) and executes through the same outbound-policy transport as discovery
 * (`providerOutboundPost`: destination policy, DNS pinning, manual redirects, caller-owned
 * executor).
 *
 * Failure is per model and fail-soft: any transport, status, redirect, size, parse, or timeout
 * failure drops the enrichment for that one model and never touches other rows or the ID roster
 * itself. Only evidence-backed fields are extracted; templates, licenses, and tokenizer
 * payloads exist only inside the bounded body and are never projected into CatalogModel
 * metadata.
 */
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { isCanonicalOllamaCloudUrl } from "../adapters/ollama-native-url";
import { providerOutboundPost, providerRedirectError } from "../lib/provider-outbound";

/** Hard per-response bound: cloud /api/show metadata is small; anything larger is discarded. */
const SHOW_MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * Aggregate deadline for the ENTIRE show-enrichment phase, independent of roster size and of
 * the generic discovery row limit. A stalled endpoint must never turn a successful /v1/models
 * discovery into a multi-minute catalog stall.
 */
const SHOW_AGGREGATE_DEADLINE_MS = 12_000;
/** Per-request timeout: a single show request never outlives this, deadline or not. */
const SHOW_REQUEST_TIMEOUT_MS = 8_000;
/**
 * Show-specific request cap, independent of the generic 2000-row discovery hard limit.
 * Conservative for the current Ollama Cloud roster (~19 ids) while leaving room for growth;
 * ids beyond the cap simply stay on the existing safe fallback metadata.
 */
const SHOW_REQUEST_CAP = 48;
/** Concurrent /api/show requests never exceed this, regardless of roster size. */
const SHOW_MAX_CONCURRENCY = 4;
/** A discovered context window must be a plausible positive integer, not arbitrary data. */
const SHOW_MAX_CONTEXT_LENGTH = 16 * 1024 * 1024;

export interface OllamaShowMetadata {
  /** Trained context length reported by the model's own architecture metadata. */
  contextWindow?: number;
  /** Native vision capability reported by Ollama (`capabilities` includes "vision"). */
  nativeVision?: boolean;
}

export interface OllamaShowEnrichmentResult {
  metadata: Map<string, OllamaShowMetadata>;
  /** /api/show requests issued (bounded by the request cap and the roster). */
  showRequests: number;
  /** True when the aggregate deadline stopped the enrichment early. */
  deadlineHit: boolean;
}

export interface OllamaShowEnrichmentOptions {
  /** The already-materialized captured discovery headers (credential + configured precedence). */
  headers: Record<string, string>;
  /** The discovery request URL actually captured for this provider (same origin is used). */
  discoveryUrl: string;
  modelIds: readonly string[];
  /** Show-specific request cap, independent of the generic discovery row limit. */
  showRequestCap?: number;
  /** Aggregate wall-clock deadline for the whole enrichment phase (injectable for tests). */
  deadlineMs?: number;
  /** Per-request timeout (injectable for deterministic tests). */
  requestTimeoutMs?: number;
  /** Outbound config for the policy-checked transport (must carry the test executor). */
  provider: {
    baseUrl: string;
    adapter?: string;
    fetch?: typeof fetch;
  };
}

/**
 * Scope gate: enrichment runs ONLY for the canonical Ollama Cloud destination. Custom
 * ollama-native providers (self-hosted or renamed rows) and every unrelated provider are
 * untouched, so `/api/show` behavior can never widen into a generic provider surface.
 */
export function ollamaShowEnrichable(
  providerName: string,
  provider: { adapter?: string; baseUrl?: string },
): boolean {
  if (providerName !== "ollama-cloud") return false;
  if (provider.adapter !== "ollama-native") return false;
  const baseUrl = provider.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  return isCanonicalOllamaCloudUrl(baseUrl);
}

/**
 * Extract only evidence-backed catalog metadata from an `/api/show` payload. The input is not
 * mutated; templates, licenses, and tokenizer payloads exist only inside the bounded parse and
 * are never projected into CatalogModel metadata.
 */
export function ollamaShowMetadataFromPayload(payload: unknown): OllamaShowMetadata | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const raw = payload as Record<string, unknown>;
  const modelInfo = raw.model_info;
  let contextWindow: number | undefined;
  const info = modelInfo !== null && typeof modelInfo === "object" && !Array.isArray(modelInfo)
    ? modelInfo as Record<string, unknown>
    : undefined;
  if (info !== undefined) {
    // Prefer the context length named by the model's own architecture, then fall back to a
    // unique `*.context_length` key only when the architecture spelling is absent or ambiguous.
    // The architecture key is FILTERED while collecting fallback candidates — the parsed input is
    // never mutated.
    const architecture = typeof info["general.architecture"] === "string"
      ? (info["general.architecture"] as string)
      : undefined;
    const architectureKey = architecture !== undefined ? `${architecture}.context_length` : undefined;
    if (architectureKey !== undefined) {
      const value = info[architectureKey];
      if (isPlausibleContextLength(value)) contextWindow = value;
    }
    if (contextWindow === undefined) {
      const candidates = Object.entries(info)
        .filter(([key, value]) =>
          key.endsWith(".context_length")
          && key !== architectureKey
          && isPlausibleContextLength(value))
        .map(([, value]) => value as number);
      if (candidates.length === 1) contextWindow = candidates[0];
    }
  }

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === "string")
    : undefined;
  const nativeVision = capabilities?.includes("vision") === true;

  if (contextWindow === undefined && capabilities === undefined) return undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(capabilities !== undefined ? { nativeVision } : {}),
  };
}

function isPlausibleContextLength(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= SHOW_MAX_CONTEXT_LENGTH;
}

/**
 * Reapply the configured provider headers LAST over an already-materialized header map,
 * case-insensitively: a configured Authorization/authorization replaces the generated Bearer
 * (exactly one effective credential spelling survives), matching the native /api/chat adapter's
 * precedence (generated Bearer first, provider.headers last). Non-credential configured headers
 * are likewise reapplied so an explicit operator spelling wins.
 */
export function applyConfiguredHeadersLast(
  headers: Record<string, string>,
  providerHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const [key, value] of Object.entries(providerHeaders ?? {})) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === lower && existing !== key) delete out[existing];
    }
    out[key] = value;
  }
  return out;
}

/**
 * Show headers for the JSON POST: force Content-Type case-insensitively (the endpoint has a
 * JSON body), leave every other captured header — including configured Authorization/auth
 * spellings — exactly as the materialized discovery request produced them.
 */
export function showHeadersFromCaptured(
  capturedHeaders: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(capturedHeaders)) {
    if (key.toLowerCase() === "content-type") continue;
    out[key] = value;
  }
  out["Content-Type"] = "application/json";
  return out;
}

/**
 * Enrich discovered Ollama Cloud ids through `POST /api/show`, executed through the same
 * outbound-policy transport as discovery (`providerOutboundPost`) with the already-materialized
 * captured headers — the show request never manufactures its own auth contract.
 *
 * Fail-soft per model: transport errors, non-2xx responses, redirects (never followed, so the
 * credential can never reach another origin), oversized payloads, malformed data, and deadline
 * aborts each skip that model's enrichment without affecting other rows or the success of
 * discovery itself. The aggregate deadline stops new launches and aborts active work; partial
 * results are returned and unenriched ids stay on the existing safe fallback metadata.
 */
export async function fetchOllamaShowEnrichment(
  options: OllamaShowEnrichmentOptions,
): Promise<OllamaShowEnrichmentResult> {
  const {
    headers: capturedHeaders,
    discoveryUrl,
    modelIds,
    showRequestCap = SHOW_REQUEST_CAP,
    deadlineMs = SHOW_AGGREGATE_DEADLINE_MS,
    requestTimeoutMs = SHOW_REQUEST_TIMEOUT_MS,
    provider,
  } = options;
  // Late-worker isolation: workers that complete or throw after the phase returns mutate ONLY
  // the internal map; the returned metadata is the EXACT snapshot the phase promise resolved
  // with — never a re-snapshot of the mutable map after resolution.
  const metadata = new Map<string, OllamaShowMetadata>();

  // Same origin as the materialized discovery request, so /api/show can never point at another
  // destination than the one the credential was already materialized for.
  const showUrl = new URL("/api/show", new URL(discoveryUrl).origin).toString();
  const showHeaders = showHeadersFromCaptured(capturedHeaders);

  const deadlineAbort = new AbortController();
  const requestSignal = () => AbortSignal.any([
    AbortSignal.timeout(requestTimeoutMs),
    deadlineAbort.signal,
  ]);

  const ids = modelIds.slice(0, Math.min(modelIds.length, showRequestCap));
  let cursor = 0;
  let active = 0;
  let showRequests = 0;
  let deadlineHit = false;
  let settled = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let resolvePhase: ((snapshot: Map<string, OllamaShowMetadata>) => void) | undefined;

  // The phase-finishing path: stops launches (settled guard), takes the metadata snapshot at
  // this exact moment, and resolves the phase promise with it. The caller returns THAT resolved
  // snapshot, so late worker settlement can never change the returned metadata.
  const finish = (deadline: boolean): void => {
    if (settled) return;
    settled = true;
    deadlineHit = deadline;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    const snapshot = new Map(metadata);
    resolvePhase?.(snapshot);
  };

  const result = await new Promise<OllamaShowEnrichmentResult>((resolve) => {
    resolvePhase = (snapshot) => resolve({
      metadata: snapshot,
      showRequests,
      deadlineHit,
    });

    // The aggregate deadline TIMER ITSELF is the return bound: it prevents further launches
    // (settled guard in pump), aborts active workers, and resolves the phase IMMEDIATELY. It
    // never relies on a worker settling, its finally block, the per-request timeout, or another
    // pump() call. Declared after finish so the callback has no TDZ reference.
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      deadlineAbort.abort(new DOMException("ollama /api/show aggregate deadline", "TimeoutError"));
      finish(true);
    }, deadlineMs);

    const pump = () => {
      if (settled) return;
      while (active < SHOW_MAX_CONCURRENCY && cursor < ids.length) {
        const id = ids[cursor++];
        active += 1;
        showRequests += 1;
        void (async () => {
          try {
            const res = await providerOutboundPost("ollama-cloud", provider, showUrl, {
              headers: showHeaders,
              body: JSON.stringify({ model: id }),
              signal: requestSignal(),
            });
            const redirectError = await providerRedirectError(res, showUrl);
            // Redirect handling: never follow — the credential must never reach another origin.
            // A redirected or non-2xx show response is a per-model failure, not a retry.
            if (redirectError || !res.ok || ![200, 201].includes(res.status)) return;
            const bounded = await readBoundedResponseBytes(res, { maxBytes: SHOW_MAX_RESPONSE_BYTES });
            if (bounded.oversized) return;
            let payload: unknown;
            try {
              payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes));
            } catch {
              return;
            }
            const parsed = ollamaShowMetadataFromPayload(payload);
            if (parsed) metadata.set(id, parsed);
          } catch {
            // Fail-soft: this model simply stays unenriched. Late settlement after the phase has
            // returned only touches the internal map — the caller holds the exact snapshot.
          } finally {
            active -= 1;
            pump();
          }
        })();
      }
      if (cursor >= ids.length && active === 0) finish(false);
    };
    pump();
  });
  return result;
}

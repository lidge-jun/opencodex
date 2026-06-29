# 140.11 — Phase 1b: google-vertex HTTP hardening (retry/timeout + error classification)

> Brings Vertex (the `google` adapter `googleMode:"vertex"` branch) to the **Kiro/Cursor
> stabilization bar** for the HTTP layer. Copy-paste-ready. SOT = opencodex's own Kiro pattern
> (`kiro-retry.ts`, `kiro-errors.ts`); external cross-check = `router-for-me/CLIProxyAPI`
> (`internal/runtime/executor/gemini_vertex_executor.go`). See `05_reference-repos.md`.

---

## Why

Today the `google` adapter does **not** implement `fetchResponse`, so `server.ts:677` falls back to
`fetchWithHeaderTimeout` — a single attempt with a connect-header timeout and **no retry, no
backoff, no actionable error classification, no secret redaction**. Kiro routes its upstream call
through `fetchKiroWithRetry` (`src/adapters/kiro-retry.ts`) and normalizes errors via
`safeKiroHttpErrorMessage` (`src/adapters/kiro-errors.ts`). Vertex must match that bar.

CLIProxyAPI confirms the gap is real on the upstream too: its Vertex executor does **no** retry and
returns the raw body as `statusErr{code,msg}` on any non-2xx. We do better by classifying + retrying
transient codes, mirroring Kiro.

## Vertex error contract (cross-checked, paste-ready)

Vertex returns the standard Google API error envelope:

```json
{"error":{"code":429,"message":"…","status":"RESOURCE_EXHAUSTED","details":[…]}}
```

| HTTP | `status` enum | Meaning | Classify as |
|------|---------------|---------|-------------|
| 429 | `RESOURCE_EXHAUSTED` | rate limit / quota | `Vertex AI rate limit exceeded` (retryable) |
| 401 | `UNAUTHENTICATED` | missing/expired token | `Vertex AI authentication failed` (non-retryable) |
| 403 | `PERMISSION_DENIED` | creds ok, no access / API disabled / wrong project | `Vertex AI access denied` (non-retryable) |
| 400 | `INVALID_ARGUMENT` | bad model/region/schema | `Vertex AI invalid request` (non-retryable) |
| 404 | `NOT_FOUND` | model not found | `Vertex AI invalid request` (non-retryable) |
| 503 | `UNAVAILABLE` | overload / transient | `Vertex AI server overloaded` (retryable) |
| 500 | `INTERNAL` | server error | `Vertex AI upstream error` (retryable) |

> Retryable set mirrors Kiro: `429, 500, 502, 503, 504`. Quota-exhausted (a distinct
> `RESOURCE_EXHAUSTED` flavor with `QuotaFailure`/no `retryDelay`) is NOT retried — same split Kiro
> makes between "rate limit" and "quota exhausted".

---

## Part 1 — Plain explanation

When a Vertex call hits a temporary failure (rate limit, server overload, dropped connection), we
now retry a few times with growing, jittered delays instead of failing immediately — exactly like
Kiro. When it fails for real, the caller gets a short, classified message ("Vertex AI rate limit
exceeded: …") with file paths and secrets stripped out, instead of a raw Google error blob.

## Part 2 — Diff-level plan

### NEW `src/adapters/google-errors.ts`

Mirror of `kiro-errors.ts`, specialized to the Google/Vertex envelope. Reuses the shared
`redactSecretString` and the same absolute-path redaction.

```ts
import { redactSecretString } from "../redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;

function sanitizeGoogleErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Pull the human detail out of the Google API error envelope `{error:{message,status,code}}`. */
function googleErrorDetail(payloadText: string): { message?: string; status?: string } {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { message: trimmed || undefined };
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown; status?: unknown } };
    const err = parsed.error;
    return { message: safeString(err?.message), status: safeString(err?.status) };
  } catch {
    return {};
  }
}

function classifyGoogle(status: number | undefined, enumStatus: string | undefined, text: string): string {
  const lower = `${enumStatus ?? ""} ${text}`.toLowerCase();
  const quotaExhausted =
    lower.includes("quotafailure") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("billing");
  if (enumStatus === "RESOURCE_EXHAUSTED" && quotaExhausted) return "Vertex AI quota exhausted";
  if (status === 429 || enumStatus === "RESOURCE_EXHAUSTED" || lower.includes("rate limit")) {
    return "Vertex AI rate limit exceeded";
  }
  if (status === 401 || enumStatus === "UNAUTHENTICATED" || lower.includes("unauthenticated") || lower.includes("invalid authentication") || lower.includes("expired")) {
    return "Vertex AI authentication failed";
  }
  if (status === 403 || enumStatus === "PERMISSION_DENIED" || lower.includes("permission denied") || lower.includes("access denied")) {
    return "Vertex AI access denied";
  }
  if (status === 503 || enumStatus === "UNAVAILABLE" || lower.includes("overloaded") || lower.includes("unavailable")) {
    return "Vertex AI server overloaded";
  }
  if (status === 400 || status === 404 || enumStatus === "INVALID_ARGUMENT" || enumStatus === "NOT_FOUND" || lower.includes("invalid") || lower.includes("not found") || lower.includes("malformed")) {
    return "Vertex AI invalid request";
  }
  return "Vertex AI upstream error";
}

export function safeVertexHttpErrorMessage(status: number, payloadText: string): string {
  const { message, status: enumStatus } = googleErrorDetail(payloadText);
  const prefix = classifyGoogle(status, enumStatus, [message, enumStatus].filter(Boolean).join(" "));
  const detail = message ? sanitizeGoogleErrorText(message).slice(0, 500) : `HTTP ${status}`;
  return `${prefix}: ${detail}`;
}

/** Vertex's retryable HTTP set (mirrors Kiro). Quota-exhausted is classified above and not retried. */
export function retryableVertexStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
```

### NEW `src/adapters/google-http.ts`

A near-verbatim copy of `kiro-retry.ts`, swapping the error normalizer + retryable predicate. Keeps
the abort-aware sleep, per-attempt timeout (`AbortSignal.any([parent, AbortSignal.timeout])`),
`Retry-After` honoring, and exponential backoff with 0.8–1.2× jitter.

```ts
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { retryableVertexStatus, safeVertexHttpErrorMessage } from "./google-errors";

const VERTEX_RETRY_ATTEMPTS = 3;
const VERTEX_RETRY_BASE_MS = 250;
const VERTEX_RETRY_MAX_MS = 2_000;

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function retryDelayMs(attempt: number, headers?: Headers): number {
  const retryAfter = headers ? retryAfterMs(headers) : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter, VERTEX_RETRY_MAX_MS);
  const exp = Math.min(VERTEX_RETRY_BASE_MS * (2 ** attempt), VERTEX_RETRY_MAX_MS);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function signalWithAttemptTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function normalizeFinalVertexError(res: Response): Promise<Response> {
  if (res.ok) return res;
  const payloadText = await res.clone().text().catch(() => "");
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(safeVertexHttpErrorMessage(res.status, payloadText), {
    status: res.status, statusText: res.statusText, headers,
  });
}

export async function fetchVertexWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 100_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < VERTEX_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await fetch(request.url, {
        method: request.method, headers: request.headers, body: request.body,
        signal: signalWithAttemptTimeout(ctx.abortSignal, timeoutMs),
      });
      if (!retryableVertexStatus(res.status) || attempt === VERTEX_RETRY_ATTEMPTS - 1) return normalizeFinalVertexError(res);
      await res.body?.cancel().catch(() => {});
      await sleepWithAbort(retryDelayMs(attempt, res.headers), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      lastError = err;
      if (attempt === VERTEX_RETRY_ATTEMPTS - 1) throw err;
      await sleepWithAbort(retryDelayMs(attempt), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error("Vertex fetch failed");
}
```

### MODIFY `src/adapters/google.ts` — add `fetchResponse` (vertex-only)

The retry wrapper must apply **only** to the Vertex branch; AI-Studio Gemini keeps the default path
(it has its own behavior and tests). Gate on `provider.googleMode`.

```ts
// add import at top
import { fetchVertexWithRetry } from "./google-http";

// inside createGoogleAdapter(provider), add alongside buildRequest/parseStream:
    fetchResponse: provider.googleMode === "vertex"
      ? (request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> => fetchVertexWithRetry(request, ctx)
      : undefined,
```

> `AdapterFetchContext`/`AdapterRequest` are already imported by the adapter? If not, extend the
> existing `./base` import. `server.ts:677` already prefers `adapter.fetchResponse` when present and
> falls through to `fetchWithHeaderTimeout` when it is `undefined`, so AI-Studio is untouched.

## Tests (NEW `tests/google-vertex-http.test.ts`)

1. `fetchVertexWithRetry` retries a 503 then succeeds (mock fetch, count attempts).
2. retries a thrown network error then succeeds.
3. does NOT retry a 400/401/403 (single attempt) and returns a `safeVertexHttpErrorMessage` body.
4. honors `Retry-After` (seconds + HTTP-date), capped at `VERTEX_RETRY_MAX_MS`.
5. aborts promptly when `ctx.abortSignal` fires mid-backoff.
6. `safeVertexHttpErrorMessage` classifies each enum row above and redacts an embedded
   `Authorization: Bearer …` + an absolute `/Users/...` path.
7. AI-Studio google (`googleMode` unset) still uses the default fetch path (adapter `fetchResponse`
   is `undefined`).

## Verify

`bun x tsc --noEmit` clean + `bun test ./tests/` green (no regression in existing `google-adapter`
/ `adapter-usage` tests). Minimal proof: a mocked 503→200 retry and a classified-redacted 403.

## Depends-on / enables

- Depends-on: Phase 10 (vertex branch exists). 
- Enables: Phase 20 antigravity reuses `fetchVertexWithRetry` + `google-errors` for its CCA endpoint.

---

## ✅ Implemented (commit `b4a772b`)

- NEW `src/adapters/google-errors.ts` — `safeGoogleHttpErrorMessage(label,…)` + `safeVertexHttpErrorMessage` / `safeAntigravityHttpErrorMessage` + `retryableGoogleStatus`. (Generalized with a `label` param so antigravity reuses it.)
- NEW `src/adapters/google-http.ts` — `fetchGoogleWithRetry(label,…)` + `fetchVertexWithRetry` / `fetchAntigravityWithRetry`.
- `src/adapters/google.ts` — `fetchResponse` spread for `googleMode` vertex|cloud-code-assist; ai-studio stays undefined.
- Tests: `tests/google-vertex-http.test.ts` (9). Suite 1015/0, tsc clean.

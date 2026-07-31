# Plan: Retry upstream fetches on stale-socket ECONNRESET

**Date:** 2026-07-03 · **Class:** C2 (single logical slice: 1 new module, 5 touched files, tests) · **PABCD:** full cycle (user-requested)
**Audit:** v1 FAILED (codex worker) — missing 5th upstream path (`web-search/loop.ts`), helper-consolidation rationale, residual-risk precedent. Amended below (v2).

## Problem

Requests proxied to `https://chatgpt.com/backend-api/codex/responses` intermittently fail with
Bun-fetch `ECONNRESET` ("The socket connection was closed unexpectedly"). Evidence
(`~/.opencodex/crash.log` fetch ring): failures correlate with idle gaps of 10s–7min between
requests — the classic stale keep-alive pattern. chatgpt.com sits behind Cloudflare, which
closes idle keep-alive connections server-side; Bun's fetch pool reuses the half-closed socket
and the write fails before any response bytes arrive. The proxy currently performs exactly one
fetch attempt on every upstream path (`src/server.ts:371` passthrough, `src/server.ts:566`
generic adapter path, `src/vision/describe.ts:87`, `src/web-search/executor.ts:70`, and the
web-search loop fallback `src/web-search/loop.ts:203`), so each stale socket becomes a
user-visible 502 / failed sidecar.

## Approach

Add a small retry wrapper that retries **only connection-reset-shaped failures** (up to 2
retries, jittered backoff), and apply it at the four upstream call sites. All these requests
have `string` bodies (`AdapterRequest.body: string`, sidecars use `JSON.stringify`), so replay
is safe. `fetch` rejects only before response headers, so a caught error means no response was
ever received — mid-stream SSE failures are intentionally NOT retried.

## Diff-level plan

### NEW `src/upstream-retry.ts` (~90 lines)

- `export function isConnectionResetError(err: unknown): boolean`
  - `false` unless `err instanceof Error`
  - `false` for `err.name === "AbortError" | "TimeoutError"` (never retry aborts/timeouts)
  - `true` for `(err as {code?: unknown}).code === "ECONNRESET" | "EPIPE"`
  - `true` for message containing `"socket connection was closed unexpectedly"` or
    `"connection reset by peer"` (case-insensitive)
  - explicitly NOT retryable: `ECONNREFUSED`, DNS failures, TLS errors, HTTP error statuses
    (those are returned as `Response`, never thrown)
- `export async function fetchWithResetRetry(doFetch: () => Promise<Response>, opts?: { abortSignal?: AbortSignal; label?: string; attempts?: number }): Promise<Response>`
  - loop `attempt = 0..attempts-1` (default `RESET_RETRY_MAX_ATTEMPTS = 3`: 1 initial + 2
    retries — the pool may hold more than one stale socket)
  - before each attempt: if `abortSignal.aborted` → throw `abortError(signal)`
  - on caught error: rethrow when signal aborted, not reset-shaped, or last attempt;
    otherwise `console.warn("[upstream-retry] connection reset (<label>) — retrying (n/max)")`
    then `sleepWithAbort(retryDelayMs(attempt), signal)`
  - `retryDelayMs`: `min(150 * 2^attempt, 1000)` with 0.8–1.2 jitter
- `export function abortError(signal?: AbortSignal): unknown` and
  `export async function sleepWithAbort(ms, signal?)` — **moved** verbatim from
  `src/adapters/kiro-retry.ts` (currently module-private there) to avoid duplication.
- **Helper-consolidation scope (audit amendment):** `src/adapters/google-http.ts:25-39`
  (`abortError`/`sleepWithAbort`) and `src/adapters/cursor/transport-retry.ts:39-62`
  (`abortError`/`abortAwareSleep`) carry their own local duplicates. Consolidating them is a
  behavior-neutral refactor across two more adapters and their test suites — deliberately OUT
  of scope for this slice (one logical change / blast-radius rule). Only kiro's helpers move,
  because `upstream-retry.ts` needs those exact semantics and the import keeps a single copy
  on that path. Follow-up noted in D.
- `upstream-retry.ts` MUST stay a leaf module (imports nothing from `server.ts`/adapters) —
  audit confirmed no circular-import risk under that constraint.

### MODIFY `src/adapters/kiro-retry.ts`

- Delete local `abortError` + `sleepWithAbort`; import both from `../upstream-retry`.
- No behavior change.

### MODIFY `src/server.ts` (2 call sites)

- Import `fetchWithResetRetry` from `./upstream-retry`.
- Passthrough path (`:371`):
  ```ts
  upstreamResponse = await fetchWithResetRetry(
    () => fetchWithHeaderTimeout(request.url, {
      method: request.method, headers: request.headers, body: request.body,
    }, upstream.signal, connectMs),
    { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
  );
  ```
- Generic adapter path (`:564-568`): wrap only the `fetchWithHeaderTimeout` branch; adapters
  with their own `fetchResponse` (kiro) keep their own retry policy:
  ```ts
  upstreamResponse = adapter.fetchResponse
    ? await adapter.fetchResponse(request, { abortSignal: upstream.signal, timeoutMs: connectMs })
    : await fetchWithResetRetry(
        () => fetchWithHeaderTimeout(request.url, {
          method: request.method, headers: request.headers, body: request.body,
        }, upstream.signal, connectMs),
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
  ```
- `safeHostLabel(url)`: tiny local helper (`new URL(url).host` in try/catch → `"upstream"`),
  placed next to `fetchWithHeaderTimeout`. (Search: no existing host-label helper —
  `publicProviderBaseUrl` sanitizes full URLs, wrong shape for a log label.)

### MODIFY `src/vision/describe.ts` (1 call site)

- Wrap the `fetch(...)` at `:87` in `fetchWithResetRetry(() => fetch(...), { abortSignal: linkedSignal.signal, label: "vision-sidecar" })`.
- `recordOutcome` unchanged — it now fires once per final outcome (less quota-score noise from
  transient resets).

### MODIFY `src/web-search/executor.ts` (1 call site)

- Same wrap at `:70`, label `"web-search-sidecar"`.

### MODIFY `src/web-search/loop.ts` (1 call site — audit amendment)

- `runIteration` fallback fetch (`:203-208`): wrap ONLY the non-`fetchResponse` branch in
  `fetchWithResetRetry(() => fetch(request.url, {..., signal}), { abortSignal: signal, label: "web-search-loop" })`.
  `request.body` is an `AdapterRequest` string — replay-safe. The `adapter.fetchResponse`
  branch keeps the adapter's own policy (same rule as server.ts generic path).

### NEW `tests/upstream-retry.test.ts`

1. retries a Bun-shaped reset (`Error` with `code: "ECONNRESET"`) and returns the second
   attempt's `Response`; asserts 2 calls + one warn
2. retries on message match (`"The socket connection was closed unexpectedly."`, no code)
3. does NOT retry: `TimeoutError`, `AbortError`, `ECONNREFUSED`, generic `Error`
4. never retries an HTTP error `Response` (resolved responses pass through untouched)
5. gives up after 3 attempts and rethrows the last reset error
6. aborting the signal between attempts stops the loop (rejects with abort reason,
   no further `doFetch` calls)
7. `isConnectionResetError` table test

### Docs

- `structure/04_transports-and-sidecars.md`: add a short "Reset retry" paragraph (which paths
  are guarded, which aren't) — updated in C phase.

## Risks considered (and dispositions)

1. **Duplicate side effects from retried POSTs** — a reset thrown by `fetch` means no response
   headers were received; for stale-socket resets the request write itself fails, so the
   server never processed it. Residual: the rare "server processed, then reset before
   headers" window. Accepted: bounded by the narrow predicate + 2-retry cap; worst case is a
   duplicate billable completion, no data corruption. Mitigation kept: never retry timeouts.
   Precedent (audit): cursor's `transport-retry.ts:64-80` treats committed requests as
   non-replayable — our reset-only predicate fires strictly before commit-equivalent state
   (no response bytes), so the narrower window is consistent with that policy.
2. **Mid-stream SSE resets are not covered** — out of scope by design; would require response
   replay/resume. The SSE bridge already surfaces terminal errors. Documented in module docs.
3. **Masking a real outage** — predicate excludes `ECONNREFUSED`/DNS/TLS/timeout; every retry
   logs a `console.warn`, so persistent resets stay visible in logs.
4. **Latency budget** — worst added delay ≈ 150+300ms sleeps + 2 fast failures ≪ 1s; per-attempt
   header timeout unchanged (`connectMs` applies to each attempt; resets fail in ms).
5. **Abort correctness** — client disconnects propagate via `upstream.signal`; checked before
   each attempt and during backoff sleep (`sleepWithAbort`), so no zombie retries after cancel.
6. **Account scoring** — `recordCodexUpstreamOutcome(..., "connect_error")` now records only
   after retries are exhausted → strictly less false-negative noise for pool rotation.
7. **kiro-retry refactor** — import-only move; existing kiro tests must stay green.

## Verification plan (C)

- `bun test ./tests/upstream-retry.test.ts` + existing `bun test ./tests/` suite
- `npx tsc --noEmit`
- Manual: none required (unit-level coverage of the predicate/loop; call-site wiring verified
  by existing passthrough/adapter tests still passing).

# Phase 80 (P0-2) - Kiro HTTP retry/backoff

## Scope

Implement the retry surface that can be closed without changing credential
ownership:

- retry connect/header-timeout errors before any response body exists
- retry HTTP 429/500/502/503/504 before any body is parsed
- honor `Retry-After` when present; otherwise exponential backoff + bounded jitter
- preserve client abort propagation
- apply to both the normal Kiro call path and Kiro `parseResponse` calls used by
  the web-search sidecar loop

Defer 401/403 refresh-once to Phase 90, because provider.apiKey is resolved
outside the adapter and needs OAuth singleflight/reload semantics to be correct.

## Design

The current `ProviderAdapter` owns request construction and stream parsing, but
`server.ts` owns fetch. Kiro-specific retry therefore needs one small adapter
extension:

```ts
fetchResponse?(request, ctx): Promise<Response>
```

`server.ts` and `web-search/loop.ts` should use `adapter.fetchResponse(...)`
when present; otherwise keep the existing fetch path. This keeps Kiro retry
adapter-local and avoids changing other providers.

## File changes

### MODIFY src/adapters/base.ts

Add exported `AdapterRequest` and optional `fetchResponse`:

```ts
export interface AdapterRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface AdapterFetchContext {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;
```

### MODIFY src/adapters/kiro.ts

Add helper functions:

- `kiroSleep(ms, signal)` abort-aware delay
- `retryAfterMs(headers)` parse seconds or HTTP date
- `isRetryableKiroStatus(status)` = 429/500/502/503/504
- `fetchKiroWithRetry(request, ctx)`:
  - max attempts: 3
  - per-attempt timeout: ctx.timeoutMs ?? 30_000
  - if fetch throws due to caller abort: rethrow
  - if fetch throws connect/header timeout/network error: retry if attempts remain
  - if response status retryable: cancel/read body safely, wait, retry
  - if final attempt or non-retryable: return response/throw last error

Expose it through `createKiroAdapter(...).fetchResponse`.

### MODIFY src/server.ts

In the routed non-passthrough path, replace direct `fetchWithHeaderTimeout(...)`
with:

```ts
upstreamResponse = adapter.fetchResponse
  ? await adapter.fetchResponse(request, { abortSignal: upstream.signal, timeoutMs: connectMs })
  : await fetchWithHeaderTimeout(...);
```

Keep the existing catch/error mapping and `linkAbortSignal` behavior.

### MODIFY src/web-search/loop.ts

Use `adapter.fetchResponse?.(request, { abortSignal })` before falling back to
direct `fetch`, so Kiro sidecar iterations get the same transient retry.

## Tests

### NEW tests/kiro-retry.test.ts

Mock `globalThis.fetch` and fake timers lightly:

- 429 then 200 -> two fetch calls, final response 200
- 503 with `Retry-After: 0` then 200 -> two calls
- 400 -> no retry, one call
- caller-aborted signal -> no retry

### Existing checks

- `bun x tsc --noEmit`
- `bun test tests/kiro-retry.test.ts tests/kiro-adapter.test.ts tests/kiro-images.test.ts`

## Acceptance

- Other adapters keep existing direct fetch behavior.
- Kiro does not retry after stream parsing has begun; retry happens only before
  the caller receives a Response.
- No 401/403 refresh behavior in this phase.

## Commit

feat(kiro): retry transient HTTP failures before stream parse

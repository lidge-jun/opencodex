# wp2 — #2827: the request id a browser cannot read

## Symptom

#2827 is green across every check. The defect is not a failing test — it is a feature that
silently does nothing for its stated consumer, found by review rather than by CI.

The PR adds a response header carrying the request-log id:

```ts
const REQUEST_LOG_ID_RESPONSE_HEADER = "x-opencodex-request-id";

function withRequestLogId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_LOG_ID_RESPONSE_HEADER, requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
```

## Cause

`corsHeaders()` in `src/server/auth-cors.ts` emits `Access-Control-Allow-Origin`,
`-Allow-Methods`, `-Allow-Headers`, and `Vary` — but no `Access-Control-Expose-Headers`.

The CORS default is that cross-origin JavaScript may read only the seven CORS-safelisted
response headers. A custom `x-` header is not one of them, so `response.headers.get(
"x-opencodex-request-id")` returns `null` in a browser even though the header is on the
wire and visible in devtools.

The tests pass because they call the handler directly. Server-side fetches see every header;
the restriction is enforced by the browser, and nothing in the suite is a browser. This is
the same shape of gap as a feature guarded by a flag no test sets — the code is right and
unreachable.

`-Allow-Headers` does not help: it governs what the **request** may send, not what the
**response** may reveal.

## Design

Add the response-header allow-list next to the request one, naming exactly the header this
proxy adds:

```ts
"Access-Control-Expose-Headers": REQUEST_LOG_ID_RESPONSE_HEADER,
```

Two constraints on how:

1. **The constant moves to `auth-cors.ts` and `server/index.ts` imports it.** Two string
   literals that must agree will eventually disagree; the header name has one owner.
2. **`Vary` does not change.** `Expose-Headers` here is a constant, not a function of the
   request, so it introduces no new cache dimension. Adding it to `Vary` would fragment the
   cache for no reason.

### Scope note

**Corrected after audit.** The first draft said `managementCorsHeaders()` was "separate and
not touched". That was wrong, and the audit caught it:

```ts
export function managementCorsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const headers = corsHeaders();   // <- inherits everything, including a new Expose-Headers
  ...
}
```

Adding the key inside `corsHeaders()` would therefore have propagated it to every
management response, which is the opposite of the scope the design claimed. The two
options are to set it only in the data-plane wrapper, or to add it in `corsHeaders()` and
strip it in `managementCorsHeaders()`.

Take the first. `withCors()` is the data-plane wrapper and the only path that serves
`/v1/responses`, so exposing the header there grants exactly the reach the feature needs.
Stripping a key the shared helper just added would leave two places that must stay in
agreement about a header neither of them owns.

Concretely: `corsHeaders()` is left alone, and `withCors()` sets
`Access-Control-Expose-Headers: x-opencodex-request-id` after copying the shared keys.

## Regression test

The existing suite cannot catch this class of defect, so the test asserts the header
contract directly rather than the behavior of a browser we do not have:

- `withCors(new Response(...), req, policy)` output contains `Access-Control-Expose-Headers`
  naming `x-opencodex-request-id`. The assertion targets the wrapper, not `corsHeaders()`,
  because the amended design deliberately leaves the shared helper untouched.
- The exposed name matches the header `withRequestLogId` actually sets — one assertion
  comparing the two, so a future rename of either side fails here instead of shipping a
  header nobody can read.
- `managementCorsHeaders()` output does NOT contain the key. This assertion is the one that
  would have failed under the original design, so it is the reason the test exists.

## Wrapper order (verified)

The route composes the two wrappers as:

```ts
return withRequestLogId(
  withCors(responseWithDeferredRequestLog(response, requestId, start, logCtx), req, policy),
  requestId,
);
```

`withCors()` runs first and `withRequestLogId()` wraps its result, copying headers through
`new Headers(response.headers)`. So an expose header set inside `withCors()` survives onto
the final response. Checked on #2827's head at `src/server/index.ts:1397` and `:1441`; no
success path carrying the request-id header bypasses `withCors()`.

## Verification

- `bun x tsc --noEmit` clean.
- Focused run of the CORS and request-log tests only.
- CI green on the pushed head, including `gates`.

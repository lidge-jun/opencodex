# WP1 diff-level plan — standalone Images data plane

Date: 2026-07-10
Status: implemented and verified

## Scope

IN:

- exact `POST /v1/images/generations` and `POST /v1/images/edits` routes;
- forward ChatGPT/OpenAI provider auth and account affinity;
- bounded opaque request relay, single-attempt/cancellation behavior, safe response relay;
- regression tests and endpoint documentation.

OUT:

- hosted Responses image tool translation;
- non-OpenAI image generation adapters;
- changes to `codex-rs` or `ima2-gen`;
- provider catalog/model changes;
- global package installation, service replacement, publication, or release.

## File change map

### NEW — `src/server/images.ts`

Create the focused unary Images proxy owner instead of extending `src/server/responses.ts` (currently over 1,100 lines) or `src/server/index.ts` (over 500 lines).

Planned public surface:

```ts
export type ImagesOperation = "generations" | "edits";
export async function handleImagesRequest(
  req: Request,
  config: OcxConfig,
  operation: ImagesOperation,
): Promise<Response>;
```

Planned behavior, in order:

1. Select only a provider with `adapter === "openai-responses"`, `authMode === "forward"`, and `disabled !== true`. Deduplicate and inspect candidates in this fixed order: eligible `config.defaultProvider`, `openai`, `chatgpt`, then `Object.keys(config.providers)` insertion order. If absent, return a safe 503 `image_generation_unavailable` without echoing provider config. This explicitly excludes API-key and OAuth providers from receiving ChatGPT account credentials.
2. Resolve `CodexAuthContext`; map cooldown to 429, expired affinity to 409, credential failure/unusable context to 401, matching `/v1/responses`.
3. Apply pool auth to the provider and build outbound headers from provider static headers, `headersForCodexAuthContext`, the incoming `content-type`, and incoming `version`. Selected runtime authorization/account headers win last.
4. Reject every request `content-encoding` except absent or case-insensitive `identity` with 415 before reading or forwarding. Do not decode opaque bodies.
5. Treat a finite non-negative numeric `content-length` above `MAX_DECOMPRESSED_BODY_BYTES` as an early 413. Ignore malformed, negative, or non-numeric declarations as untrusted metadata; the actual stream is authoritative.
6. Read `req.body` through a bounded stream collector. Before retaining each `Uint8Array` chunk, compute the next logical byte total; if it crosses the ceiling, cancel the reader and return 413. Concatenate only after the stream completes under the limit. Do not parse or log the body. A test can enqueue the same 1 MiB chunk reference 257 times to exercise logical overflow without allocating 257 MiB.
7. Build `${provider.baseUrl.trimEnd('/')}/images/${operation}`. The operation is a closed enum selected by the route, never caller text.
8. Link `req.signal` to an upstream controller before fetch. Call `fetchWithHeaderTimeout` exactly once with the single collected `Uint8Array`; do not call `fetchWithResetRetry` because the paid POST has no source-proven idempotency contract.
9. On connect timeout/error/reset, return a safe 502 without including URLs, credentials, or body data. Record the outcome only when the auth context is pool/main-pool.
10. On HTTP response, record pool-only health/status including rate-limit metadata, sanitize headers, and return `relayWithAbort(upstream.body, controller)` with the original status/statusText. This covers cancellation after headers; the linked signal covers cancellation before headers. Main-account requests never mutate pool health.

No new dependency, schema, adapter, route registry, or generic helper is introduced.

### MODIFY — `src/server/index.ts`

Before the generic `/v1/*` guard and beside the compact/Responses routes:

```diff
+ if (
+   req.method === "POST"
+   && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")
+ ) {
+   if (isDraining()) {
+     return new Response("Service shutting down", {
+       status: 503,
+       headers: { ...corsHeaders(req, config), "Retry-After": "5" },
+     });
+   }
+   const authError = requireApiAuth(req, config, "data-plane");
+   if (authError) return withCors(authError, req, config);
+   if (!isAllowedRequestOrigin(req, config)) {
+     return withCors(formatErrorResponse(403, "forbidden_origin", "Origin not allowed"), req, config);
+   }
+   const operation = url.pathname.endsWith("/edits") ? "edits" : "generations";
+   return withCors(await handleImagesRequest(req, config, operation), req, config);
+ }
```

Import only `handleImagesRequest`. Do not add forwarding logic to the listener.

### NEW — `tests/images-proxy.test.ts`

Use an isolated `OPENCODEX_HOME`/Codex home and in-process upstream/server fixtures.

Required cases:

1. Generation: exact `/images/generations` upstream path, JSON bytes/content type, `version`, forwarded main auth, and `data[].b64_json` response.
2. Edit: exact `/images/edits` path and unchanged JSON `images[].image_url` body.
3. Multipart preservation: request boundary/content-type and raw bytes reach upstream unchanged.
4. Pool affinity: selected pool bearer/account headers replace inbound main values; no token appears in the client response.
5. Upstream error fidelity: a 429/5xx JSON error, safe rate-limit headers, and status survive; `set-cookie`, `content-encoding`, and stale `content-length` do not.
6. Route gates: draining returns the repository-standard 503 body + `Retry-After: 5` + CORS headers, missing/invalid data-plane auth returns 401, and a disallowed origin returns 403; each keeps upstream count at zero.
7. Body boundary: declared oversize and actual chunked overflow return 413 with zero upstream calls; malformed/non-numeric/negative declarations still rely on and accept an under-limit stream.
8. Content encoding: gzip, br, and an unknown encoding return 415 with zero upstream calls; absent/identity succeeds.
9. Provider selection: disabled candidates are skipped, API-key/OAuth candidates are excluded, fixed precedence wins with multiple candidates, and no eligible forward provider returns safe 503.
10. Auth-context error mapping: cooldown, expired affinity, credential error, and unusable context return their safe statuses with zero upstream calls.
11. Single-attempt invariant: a reset-shaped fetch failure makes one upstream attempt and returns safe 502.
12. Cancellation before headers aborts the upstream fetch; cancellation after headers cancels the relayed upstream body.
13. Health state: pool 429, 5xx, and connect-error paths call the existing health owner; main-account failures do not mutate pool health.

The first generation test is the RED regression and must fail with the current 404 before implementation.

### MODIFY — `tests/server-auth.test.ts`

Change the unknown-path test at `1020-1035`:

```diff
- ["/v1/alpha/search", "/v1/images/generations", "/v1/memories/trace_summarize"]
+ ["/v1/alpha/search", "/v1/memories/trace_summarize"]
```

Keep its JSON-404 assertions. Positive Images coverage lives in the focused new test file rather than further growing this 1,700-line suite.

### MODIFY — `structure/01_runtime.md`

- Add `src/server/images.ts` to the server responsibility map.
- State that the listener recognizes the two exact standalone Images POST paths before the generic guard.

### MODIFY — `structure/04_transports-and-sidecars.md`

Add a `Standalone Images` section that records:

- Codex's local `image_gen.imagegen` performs a second Images request;
- generation and edit suffixes;
- the request is not the hosted Responses image tool;
- auth/account affinity and opaque body relay;
- unknown image subpaths remain 404.

### MODIFY — `README.md`, `README.ko.md`, `README.zh-CN.md`

In each locale, update both the exposed-endpoint paragraph and the non-loopback data-plane-auth paragraph, not only a Development list. Exact current locations are `README.md:342-345,393-396`, `README.ko.md:323-325,374-375`, and `README.zh-CN.md:304-306,352-353`. Add `/v1/images/generations` and `/v1/images/edits` as Codex standalone-tool compatibility endpoints and state that the same non-loopback data-plane token/key protection applies. Keep localized wording and surrounding structure unchanged.

## Activation scenarios for conditional paths

| Branch | Trigger | Observable proof |
| --- | --- | --- |
| Generation route | POST exact generation path | mock upstream records `/images/generations`; caller receives base64 data |
| Edit route | POST exact edit path | mock upstream records `/images/edits`; image data URL survives |
| Multipart preservation | edit request with multipart boundary | upstream content-type/body match |
| Pool auth override | configured active pool + thread header + conflicting inbound token | upstream sees pool token/account only |
| Draining | lifecycle marked draining | caller gets 503; upstream count stays zero |
| Local API auth failure | non-loopback config without valid proxy key | caller gets 401; upstream count stays zero |
| Origin rejection | disallowed browser Origin | caller gets 403; upstream count stays zero |
| Oversize declaration | numeric content length exceeds 256 MiB | caller gets 413; upstream count stays zero |
| Oversize stream | repeated chunks logically exceed 256 MiB without a trusted declaration | reader is canceled; caller gets 413; upstream count stays zero |
| Malformed length | non-numeric/negative content length with a small actual stream | actual stream governs; request succeeds |
| Encoded body | non-identity content encoding | caller gets 415; upstream count stays zero |
| Missing forward provider | direct handler config without enabled forward provider | safe 503 body |
| Provider precedence | default/openai/chatgpt/config-order mixture, including disabled and key-auth entries | only the first eligible forward provider receives the request |
| Auth cooldown/expiry/failure | existing auth-context states | 429/409/401, no upstream call |
| Connect timeout/error | upstream fetch rejects/times out | safe 502, no token/body leakage |
| Reset-shaped error | upstream fetch resets | safe 502 and exactly one attempt |
| Upstream non-2xx | upstream returns 429 or 5xx | same status/body and safe headers reach caller |
| Client cancellation before headers | request signal aborts while fetch is pending | upstream controller aborts |
| Client cancellation after headers | caller cancels relayed body | upstream body reader is canceled |
| Pool health | pool-context 429/5xx/connect failure | existing upstream-health owner records the outcome |
| Main health isolation | main-context 429/5xx/connect failure | pool-health owner is not called |
| Generic guard | another `/v1/*` path | JSON 404 remains |

## Necessity gate

- Do nothing: rejected; exact failure reproduces and source intentionally 404s the required path.
- Delete: rejected; the generic guard is correct for unknown paths and must remain.
- Configure: rejected; Codex correctly derives `/v1/images/generations` from opencodex's injected base; no existing config can create a missing server route.
- Reuse: selected for auth, header timeout, abort relay, header sanitizer, health recording, and route gates. Reset retry is deliberately not reused for this non-idempotent paid POST. Only the Images-specific handler and its bounded collector/selector are new.

## Verification

Run the commands from `000_plan.md` and record fresh output in this unit before D. No completion claim may rely on the earlier 404 probe or subagent reports.

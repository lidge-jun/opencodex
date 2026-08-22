---
title: "M0-3: Provider delivery policy"
phase: "030"
depends: []
consumes: []
branch: codex/m0-3-provider-delivery
closes: "(informed by #1367, #1668)"
---

# 030 — M0-3: Per-provider transport and delivery policy

## Thesis

Add two per-provider config knobs — `upstreamHttpVersion` and `responseDelivery` —
so operators can work around provider-specific transport failures without global
stream mode changes.

## Current state

- `src/types.ts:709` has global `streamMode: auto|legacy-tee|eager-relay`
- No per-provider HTTP version control
- #1668 documented HTTP/2 SSE hangs on specific providers (closed for template, not fixed)
- #1367 implements bounded-json fallback but is hygiene-blocked and too large
- `src/server/responses/core.ts` fetches upstream via `providerFetch` in fetch-helpers.ts

## File change map

### MODIFY: src/types.ts (OcxProviderConfig)

Add two optional fields after `streamMode`-related fields:

```diff
+ /** Force HTTP/1.1 for upstream connections to this provider. Default "auto". */
+ upstreamHttpVersion?: "auto" | "http1";
+ /**
+  * Response delivery mode for this provider.
+  * "auto" (default): streaming SSE as usual.
+  * "stream": force streaming even if other heuristics would disable it.
+  * "bounded-json": request stream=false upstream, read bounded JSON response,
+  *   then reconstruct as Responses SSE for the client. No progressive output.
+  */
+ responseDelivery?: "auto" | "stream" | "bounded-json";
```

### MODIFY: src/config.ts (Zod schema)

Add validation for the new fields in the provider config schema:

```diff
+ upstreamHttpVersion: z.enum(["auto", "http1"]).optional().catch(undefined),
+ responseDelivery: z.enum(["auto", "stream", "bounded-json"]).optional().catch(undefined),
```

### MODIFY: src/server/responses/fetch-helpers.ts

In `providerFetch`, apply HTTP/1.1 pin when configured:

```diff
+ // When upstreamHttpVersion is "http1", inject a fetch option that forces
+ // HTTP/1.1 for this provider's upstream connections.
+ if (provider.upstreamHttpVersion === "http1") {
+   // Bun fetch supports { tls: { ... } } but not an explicit HTTP version pin.
+   // Workaround: set the ALPNProtocols to exclude h2.
+   // If Bun doesn't support this, fall back to appending a header hint.
+ }
```

### MODIFY: src/server/responses/core.ts

In `handleResponsesInner`, before building the upstream request:

```diff
+ // Apply bounded-json delivery: override stream=false upstream
+ if (providerConfig.responseDelivery === "bounded-json") {
+   // Set stream: false on the upstream request body
+   // Read the bounded JSON response
+   // Reconstruct as SSE events for the client
+   // MUST NOT resend the request on failure (no retry)
+ }
```

### NEW: tests/provider-delivery.test.ts

Test cases:
1. Default (no config) → byte-for-byte existing behavior
2. `upstreamHttpVersion: "http1"` → only affects that provider
3. `responseDelivery: "bounded-json"` → upstream gets stream:false
4. bounded-json: no request resend on failure
5. bounded-json: cancellation handled correctly
6. bounded-json: malformed JSON response → error, not crash
7. bounded-json: unexpected SSE from stream:false → fail closed
8. Invalid config values → fallback to "auto" via Zod .catch()

## Activation scenario

A provider configured with `upstreamHttpVersion: "http1"` sends all its
upstream requests over HTTP/1.1 while other providers use auto-negotiated HTTP/2.
A model on that provider configured with `responseDelivery: "bounded-json"`
sends `stream: false` upstream, reads the JSON response, and re-emits it as
SSE to the Codex client.

## Scope boundary

IN: Type additions, config validation, fetch-helper modification, core.ts delivery logic, tests
OUT: Changing global streamMode behavior, modifying WebSocket upstream (#1608),
     GUI for delivery settings, provider registry defaults

# A audit synthesis — standalone Images proxy

Date: 2026-07-10
Reviewer verdict: `GO-WITH-FIXES (blockers=7)`
Implementation gate: open — final same-reviewer verdict `GO`

## REVIEW-SYNTHESIS

The first independent plan audit agreed with the root cause and route shape, but identified seven implementation-blocking omissions. All seven are adopted:

1. Route guards are now concrete, not comments: drain returns 503 with `Retry-After`, then data-plane API auth runs, then origin policy runs. Every rejection must prove zero upstream calls.
2. Reset retry is removed. Images POSTs may create paid non-idempotent work, and the inspected Codex contract provides no idempotency key. A reset-shaped failure must make exactly one attempt.
3. `Request.arrayBuffer()` plus a post-read check is replaced by a streaming bounded collector that counts before retaining each chunk. `content-length` is only an early hint.
4. Every non-identity request `content-encoding` is rejected with 415. The proxy will not guess whether opaque payload bytes are compressed or decompressed.
5. Provider selection is deterministic and restricted to enabled `openai-responses` + `forward` entries: eligible default, `openai`, `chatgpt`, then stable config order. Key/OAuth entries never receive ChatGPT account credentials.
6. Cancellation and health contracts are split explicitly: linked abort before headers, relay cancellation after headers; pool outcomes update health, main-account outcomes do not.
7. Activation coverage now includes actual chunked overflow, malformed length, encoding policy, all provider branches, unusable auth context, reset/no-retry, both cancel phases, health isolation, and zero-upstream assertions.

Documentation scope is also corrected: every README locale must update both its exposed-endpoint paragraph and its non-loopback data-plane-auth paragraph; both structure documents receive the exact route ownership/transport contract.

## Evidence clarification

Codex decodes `ImageResponse.data[]` at `/Users/jun/Developer/codex/121_openai-codex/codex-rs/codex-api/src/endpoint/images.rs:65-70`; the local tool then requires and decodes the first entry's `b64_json` at `/Users/jun/Developer/codex/121_openai-codex/codex-rs/ext/image-generation/src/tool.rs:157-164`. The plan does not claim that the public OpenAI edit schema proves private ChatGPT edit behavior.

## Re-audit request

The same reviewer must verify that these deltas close every blocker before any product-code write. A pass may be `GO`; `GO-WITH-FIXES` is acceptable only if remaining fixes are non-blocking and explicitly folded into the build plan. Any blocking finding keeps B closed.

## Re-audit 1 delta

The reviewer confirmed all original seven blockers closed, then returned `NO-GO` for one newly exposed compile-time problem: the route pseudo-diff passed response headers as a nonexistent fourth `formatErrorResponse` argument. The plan now copies the repository's established drain response exactly: `new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } })`. The activation test now requires that exact header/CORS behavior. No product code was written while the gate was closed.

## Final re-audit

Verdict: `GO`. The reviewer verified the corrected drain construction against `src/server/index.ts`, confirmed every prior blocker remained closed, and found no remaining implementation-blocking issue. B may begin.

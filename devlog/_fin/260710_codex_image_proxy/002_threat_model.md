# Threat model — standalone Images proxy routes

Date: 2026-07-10
Scope: `/v1/images/generations`, `/v1/images/edits`

## Assets

- ChatGPT bearer tokens and `ChatGPT-Account-ID` values.
- Thread-to-account affinity and pool-account health state.
- User prompts and reference-image bytes/data URLs.
- Generated image bytes.
- Trusted provider base URLs and static headers.

## Entrypoints and trust boundaries

1. Codex or another local client sends an Images request to opencodex.
2. When opencodex is bound non-loopback, the request crosses a remote-to-local data-plane boundary protected by `OPENCODEX_API_AUTH_TOKEN`/configured keys and origin policy.
3. opencodex selects a trusted configured forward provider and a thread-affined credential.
4. The bounded opaque body and approved headers cross from opencodex to the ChatGPT backend.
5. The upstream response crosses back to the caller after header sanitization.

## Attacker capabilities

- Unauthenticated remote caller when the proxy is accidentally exposed.
- Authenticated-but-malicious data-plane caller with a valid local proxy key.
- Malicious local process able to reach loopback.
- Compromised or erroring upstream returning hostile headers, oversized data, or misleading status.

## Assumptions

- Provider configuration is trusted local state. Request data may not choose an arbitrary upstream host.
- The current Codex extension uses ChatGPT/OpenAI auth and an OpenAI-compatible forward provider; non-OpenAI image routing is out of scope.
- Image payloads may legitimately be large, but the existing 256 MiB data-plane bound is an acceptable OOM ceiling for this repair.
- Prompts/images are sensitive content and must not be written to request logs or error text.

## Controls and must-pass checks

| Risk | Control | Verification |
| --- | --- | --- |
| Remote use without local proxy auth | Existing `requireApiAuth(..., "data-plane")` before handler | Non-loopback route test remains covered by server auth suite |
| Cross-origin browser call | Existing `isAllowedRequestOrigin` gate | Existing origin tests + route order inspection |
| Token/account mismatch | `resolveCodexAuthContext` + `headersForCodexAuthContext`; pool override wins | Integration test asserts pool token/account replace inbound values |
| Credential leakage | Header allowlist; no request-body/header logging; safe client errors | Assertions inspect response/log strings for no token; privacy scan |
| SSRF | Upstream host comes only from enabled trusted forward provider config | Test asserts caller body/path cannot alter upstream host |
| Header smuggling / stale framing | Copy only approved request headers; use `sanitizePassthroughHeaders` for response | Header integration/unit tests |
| Memory exhaustion | Treat numeric `content-length` only as an early hint; stream-read and count before retaining every chunk; cancel and return 413 above 256 MiB | Declared-oversize and repeated-chunk overflow tests both prove zero upstream calls |
| Compressed-body amplification / opaque decoding ambiguity | Reject every non-identity request `content-encoding` with 415 before reading or forwarding | gzip/br/unknown encoding cases prove zero upstream calls |
| Duplicate paid work | Exactly one fetch attempt; do not reuse reset retry without a source-proven idempotency contract | Reset-shaped failure test asserts one upstream attempt and safe 502 |
| Leaked upstream work after client cancel | Link `req.signal` before fetch and use `relayWithAbort` after headers | Separate before-headers and after-headers cancellation tests |
| Error masking | Relay upstream HTTP status/body; map only local connect failures to safe 502 | Focused upstream 4xx/5xx integration case |
| Cookie/session leakage from upstream | Existing response sanitizer drops `set-cookie*` | Response header assertion |
| Wrong provider / credential class | Deterministic selector accepts only enabled `openai-responses` + `forward`; key/OAuth providers are excluded | Disabled, key, multi-provider precedence, and none-eligible cases |
| Cross-account health mutation | Call existing health recorder only for selected pool contexts; main-account failures are observational only | Pool 429/5xx/connect cases mutate health; main case does not |

## Residual risk

- Public OpenAI edit requests are multipart while current Codex private edits are JSON. Opaque forwarding avoids corruption but does not promise that every public API client is compatible with the private ChatGPT backend.
- A caller holding the local proxy key can spend the selected account's image quota. Rate limiting is not added because the normal Codex Responses data plane has the same trust model; adding an inconsistent limiter is outside this repair. Non-loopback deployments remain protected by their existing key and origin policy.
- Buffering an allowed body still consumes up to 256 MiB. The repair keeps the repository's existing ceiling, rejects encoded bodies, and avoids duplicate copies until the final contiguous buffer, but does not redesign global data-plane streaming limits.

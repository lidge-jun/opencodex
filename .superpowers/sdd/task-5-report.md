# Task 5 report — Transport

## Status

Implemented always-SSE Cloud Code Assist requests, daily/production host
failover, quota/image host candidate reuse, and Antigravity account cooldown
wire-up. The existing AI Studio and Vertex unary paths remain on
`generateContent`.

## Validation

- `bun test tests/google-antigravity-wire.test.ts tests/google-hardening.test.ts tests/antigravity-routing.test.ts tests/antigravity-quota.test.ts`
  - 104 passed, 0 failed
- `bun run typecheck`
  - passed
- `git diff --check`
  - passed

## Coverage

- Unary CCA parsing buffers the SSE event contract.
- Empty CCA streams and first-host transport/404/unavailable failures try the
  single maintained peer; authentication, geoblock, invalid request, and
  exhausted quota do not host-fail over.
- 429 responses classify rate limits versus exhausted quota and record
  account-keyed process-local cooldowns.
- Geoblock records cooldown without starting an account carousel.
- Provider documentation tables remain structurally valid after the quota and
  transport notes were folded into the Antigravity rows.

## Concerns

CCA response inspection clones and reads up to 256 KiB before returning a
successful response so an empty stream can fail over deterministically. This
preserves the response body for the adapter, but can delay the first client
event until the bounded inspection completes.

## Commit

`3b48b9802` — `feat(antigravity): always-SSE unary, host failover, and account cooldowns`

## Review fixes

- P1 streaming: replaced clone-to-EOF inspection with a bounded first-meaningful-event probe. CCA responses return as soon as a candidate or terminal frame arrives, while the consumed bytes remain attached to the response body; empty streams still fail over at EOF.
- P1 oversized SSE: valid responses larger than the old 256 KiB inspection cap are no longer classified as empty or replayed.
- P2 inline `UNAVAILABLE`: a 200 SSE error frame with `UNAVAILABLE` (or code 503) now uses the single daily/production peer fallback. Terminal authentication, geoblock, invalid-request, and quota errors remain non-failover cases.

## Review-fix validation

- `bun test tests/google-antigravity-wire.test.ts tests/google-hardening.test.ts tests/antigravity-routing.test.ts tests/antigravity-quota.test.ts`
  - 107 passed, 0 failed
- `bun run typecheck`
  - passed
- `git diff --check`
  - passed

## Re-review fixes

- EOF-residual CCA terminal frames now stay on the original host; only empty
  residuals and retryable `UNAVAILABLE` residuals invoke peer failover.
- Peer fallback now re-enters the shared Google retry, quota classification,
  compatibility replay, and final error-normalization path with host failover
  disabled for the peer leg.

## Re-review validation

- `bun test tests/google-antigravity-wire.test.ts tests/google-hardening.test.ts tests/antigravity-routing.test.ts tests/antigravity-quota.test.ts`
  - 109 passed, 0 failed
- `bun run typecheck`
  - passed

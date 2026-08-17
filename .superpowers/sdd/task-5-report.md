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
- `bun run privacy:scan`
  - passed
- Documentation build was attempted twice; `bun install --frozen-lockfile`
  stopped before `astro build` with Bun's
  `FileNotFound extracting tarball from stream-replace-string` error.

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

# 030 — Phase 3: upstream-413 tightened-retry

## Behavior contract

When Anthropic still returns 413 after normalization (budget-estimate miss: giant text
share, tool schemas, etc.), the proxy re-trims ONE tier lower and retries ONCE, then
surfaces the error cleanly. Mirrors Claude Code's single-shot guard (001 §2) — never a
spiral.

## Diff plan

### MODIFY `src/server/responses.ts`

- Locate the non-OK upstream branch (currently ~:943-987: 429 key-failover loop, then
  the generic `Provider error` formatting; RE-VERIFY line numbers at wp4 P — wp3 may
  shift them).
- Add a 413 branch BEFORE the generic formatter, gated on: provider adapter is
  `anthropic` family, request not already retried (`imageRetryAttempted` local flag),
  and the parsed request contains at least one base64 image block.
- **Active-adapter tracking (audit amendment, blocker 4):** `adapter` is created once
  before the failover loop (`responses.ts:632-633`) while the 429 loop builds a
  block-local `retryAdapter` after rotating `route.provider` (`:947-963`) — a 429→413
  sequence would otherwise rebuild against the stale pre-rotation adapter/key. Refactor
  to ONE mutable `activeAdapter` binding that the 429 loop reassigns and the 413 branch
  reads. Retry-state transitions, explicit: (a) 413 retry runs AFTER the 429 failover
  loop settles, using `activeAdapter`; (b) the 413-retry response re-enters the 429
  check once (nested rotation allowed, still bounded by pool size); (c) a second 413
  falls through to the error formatter; (d) `imageRetryAttempted` guards exactly one
  tier-biased rebuild per request; (e) **bias retention (audit round 2, blocker 3):**
  a request-scoped `currentImageTierBias` variable is read by EVERY rebuild — including
  429-rotation rebuilds after the biased 413 retry — so 413→biased retry→429→rotation
  keeps the tightened tiers; the one-increment guard (d) is separate from retention.
  Test R4 covers the 413→429→rotation sequence asserting the rotated rebuild carries
  tierBias=1.
- Retry call: `activeAdapter.buildRequest(parsed, { headers: selectedForwardHeaders, imageTierBias: 1 })`
  → re-fetch with the SAME timeout/abort plumbing as the 429 retry (including releasing
  the failed response body via `body.cancel()`).
- `imageTierBias: 1` flows adapter→`normalizeAnthropicImages(messages, { tierBias: 1 })`
  (every image one tier lower; tier-2 → floor 500px/q40/100KiB per 020's table). Threading:
  optional field on `IncomingMeta` (`src/adapters/base.ts:4-7,18-23`) — additive, other
  adapters ignore it (audit-verified).
- Image presence detection: `parsed.context.messages` carries `OcxImageContent.imageUrl`
  data URLs in ordinary and tool-result content (`src/types.ts:81-90`,
  `src/responses/parser.ts:29-53,173-199`) — gate the branch on at least one data-URL
  image (audit-verified reachable).
- Cache interaction: biased tiers are distinct cache keys — no invalidation needed.
- On second 413: fall through to the existing `Provider error 413` formatting (client
  sees the honest error).

## Tests

- R1 (activation): fake upstream returning 413 once then 200 → assert ONE rebuild with
  tierBias=1 and a successful response (fires the branch for real).
- R2 (spiral guard): upstream 413 twice → exactly two upstream calls, error surfaced,
  no third attempt.
- R3 (non-anthropic 413): branch does not fire (passthrough to formatter).
- R4 (bias retention): 413 → biased retry → 429 → key rotation; assert the rotated
  rebuild carries tierBias=1 (audit round 3, blocker 3 — authoritative listing).
- Test seam: follow existing responses.ts test patterns (see `tests/` server suites that
  stub `fetch`/adapters; pick the sibling pattern at P).

## Accept criteria (criterion c5)

R1-R4 green + full gates green + reviewer verdict.

## B-phase amendment (test-strategy, recorded at wp4; CORRECTED after C review)

Initial premise ("no server-level harness") was WRONG — the C reviewer pointed at
`tests/server-key-failover-e2e.test.ts` (scripted upstream through startServer) and the
anthropic fixture in `tests/server-auth.test.ts`. R1/R2/R4 are now REAL server-level
e2e tests in `tests/anthropic-image-retry-e2e.test.ts` (scripted 413/429/200 upstream,
recorded request bodies, sniffed tier assertions). The unit layer below remains as
defense-in-depth:

- Gate decisions (R2 spiral guard, R3 non-anthropic/no-image/other-status exclusions)
  as unit tests over the extracted `src/server/image-retry.ts`
  (tests/anthropic-image-retry.test.ts).
- R1 activation as an adapter-level proof: `buildRequest(parsed, { imageTierBias: 1 })`
  re-encodes a tier-0 pass-through image at the tier-1 edge through the REAL
  normalization path (same test file).
- R4 bias retention is additionally structural: the recovery loop's shared
  `rebuildAndRefetch` closure reads the request-scoped `imageTierBias` for EVERY rebuild.

Implementation delta: NEW src/server/image-retry.ts (gate, unit-testable);
responses.ts non-OK handling restructured into a labeled recovery loop with one mutable
activeAdapter + imageTierBias + imageRetryAttempted; base.ts IncomingMeta.imageTierBias;
anthropic.ts consumes incoming.imageTierBias into normalizeAnthropicImages.

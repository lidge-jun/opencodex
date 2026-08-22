# 030 — Issue #914: pre-connection transport failures must not rotate pool accounts

core.ts cluster 1/3. Research: explorer batch D (verified citations below).

## Verified current state

- Regular Responses maps every non-timeout fetch rejection to `connect_error`
  against the selected pool account: `src/server/responses/core.ts:1734,1737`.
- Native Compact does the same on primary and bounded alternate sends:
  `src/server/responses/compact.ts:410,480`.
- `connect_error`, timeout, and 5xx share one account-transient class:
  `src/codex/routing.ts:323`; threshold creates soft-avoid, drops affinities,
  advances the active account: `src/codex/routing.ts:1615,1650`.
- `fetchWithTransientRetry()` discards earlier 5xx evidence when a later
  retry rejects: `src/lib/upstream-retry.ts:314,337`.
- Quota-probe lease release owner: `src/codex/auth-context.ts:82`.

## Classification contract

| Evidence | Account health |
|---|---|
| `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, `EHOSTUNREACH`, `ECONNREFUSED`; Bun `ConnectionRefused`/`FailedToOpenSocket` | neutral — record provider-origin host ledger only |
| `ECONNRESET`, `EPIPE`, established/read-then-close | keep `connect_error` |
| TLS/cert/handshake or unknown rejection | keep `connect_error` |
| `TimeoutError` | keep `timeout` |
| client abort | 499 path, no health evidence |
| any real HTTP response (incl. manual 3xx) | clears the host streak; existing status policy applies |
| 5xx → then reachability rejection | account-attributed (credential path was reached) |

Never classify from message text; walk at most three `Error.cause` links,
stop on cycles/non-Errors.

## Diff-level plan

ADD `src/lib/upstream-reachability.ts` — `isPreConnectReachabilityError()`,
`classifyTransportFailureKind()`, stable code extraction, canonical
provider-origin keying.

ADD `src/codex/upstream-host-health.ts` — observational ledger keyed by
`(provider, canonical origin)`; record/reset/window helpers only, NO circuit
breaker in this issue. Retention bound (audit round 3): maximum 128 entries;
on overflow, prune the stalest entries by last-touch timestamp before
inserting; entries idle beyond the ledger window are reconciled away on the
next record. A churn test proves cardinality stays bounded across repeated
provider/base-URL changes for the process lifetime.

MODIFY `src/lib/upstream-retry.ts` — attach ordered prior-attempt evidence
(5xx, credential-visible resets) to the terminal rejection via an
observation callback, so mixed sequences classify correctly.

MODIFY `src/codex/routing.ts` — add a neutral outcome branch: releases only a
matching account/scoped probe lease and returns before account streak,
soft-avoid, affinity, or active-account mutation. Add the neutral variant to
`CodexUpstreamOutcome` and the downstream recorder contracts so the new
outcome is type-checked end to end (audit round 3 note).

MODIFY `src/server/responses/core.ts` — `transportFailureResponse` classifies
via the new helper; neutral → account-neutral settlement + host-ledger
record; `redirect: "manual"` on credential-bearing sends (primary, 429
replay, `retryCodexPoolOnAlternateAccount`), preserving 3xx + `Location`;
any real HTTP response clears the host streak.

MODIFY `src/server/responses/compact.ts` — same classification in primary and
alternate catches; same manual-redirect policy in `sendCompactAttempt`.

DOCS: five provider-configuration locale files, scoped to regular Responses +
native Compact (no sidecar claims).

## Contributor PR equivalence (040/130 gate input)

- #966 (`78c824dd`): closest semantic source — extract classifier/retry
  semantics + regular/Compact tests; do NOT inherit its 22-file sidecar
  blast radius.
- #922 (`d6c37343`): not equivalent — host-health module + ordered
  attempt observations are useful; its admission/circuit-breaking, host-only
  timeouts, and redirect-to-502 are policy expansions beyond #914.

## Tests / activation

Activation: two pool accounts, thread pinned to A, threshold 3; fake fetch
rejects three concurrent requests with Bun `ConnectionRefused` → all return
502, A keeps health/affinity/active-account, host ledger records 3; restore
fetch, same thread still uses A; repeat via `/v1/responses/compact`.

Matrix: every accepted code at cause-depth 0-2, depth-3, cycle, non-Error,
message-only negative; reset/EPIPE/TLS/timeout/unknown account-attributed;
`503→ConnectionRefused` and `ECONNRESET→ConnectionRefused` account-attributed;
all five send sites; manual 307 (credential once at origin, dead target never
contacted); concurrent neutral failures; owned probe lease released,
unrelated untouched; real Bun dead-port activation.

ADD `tests/upstream-reachability.test.ts`,
`tests/issue-914-transport-attribution.test.ts`; extend
`tests/upstream-transient-retry.test.ts`, `tests/server-auth.test.ts`,
`tests/responses-compaction-routing.test.ts`.

## Accept criteria

- Activation scenario passes on fake-fetch and real dead-port Bun runs.
- Gates: focused suites + `bun run typecheck` + `bun run privacy:scan` + full
  `bun run test` on ssh lidge.

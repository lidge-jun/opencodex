# 261102 — Request-owned bearer conversation affinity (#8080)

**Reader summary.** When Codex CLI signs in with ChatGPT and talks to a Pool-mode proxy, its own
bearer makes `main` one more round-robin candidate (#5019), but the request had no affinity key, so
every turn re-ran the strategy and a conversation hopped between main and the stored accounts. The
request log labelled each of those picks `new_bind/healthy` although nothing was stored. This unit
makes every affinity label describe what selection actually stored, and adds the opt-in
`codexPool.requestOwnedAffinity` (default off) that keeps one account per conversation for a
request-owned bearer. Research: `010_research.md`. Contract: `structure/providers/codex-request-owned-affinity.md`.

## Scope

- In: `src/codex/request-owned-affinity.ts` (key, label check, issuer helpers),
  `src/codex/request-owned-main-pin.ts` (byte-for-byte move), wiring in `src/codex/auth-context.ts`,
  request previews (`src/server/responses/request-prepare.ts`), issuer and retry/compact fallbacks,
  request log and usage normalization, config field, manual-selection issuer retention.
- Out: affinity persistence (#8091), round-robin eligibility (#8092), Claude identity lanes.

## Decisions

1. Labels are checked when selection returns: `new_bind`/`rebound` stay only if the key's entry names
   the selected account; otherwise `unbound` (`request_owned`, `no_conversation`, or the original
   reason) or `cleared`. `unbound` is not a spend move reason.
2. The opt-in key is an HMAC under a process-random secret over the exact Authorization value and the
   conversation key. Account-id claims are not used as principal.
3. Final auth and both previews (first and recovery, per candidate model) share one derivation; fixed
   selectors and Reserve get no key; request-owned traffic never records lineage.
4. A separate bearer-scoped conversation-state key (never passed to routing) carries issuer records
   for request-owned Pool and caller-owned main contexts, with or without the opt-in.
5. Manual account selection keeps issuer records while clearing routing bindings.
6. A refusal on a caller-owned main binding releases that binding without touching shared main health.

## Acceptance

Regression tests in `tests/codex-integration/codex-request-owned-affinity.test.ts`,
`tests/codex-integration/reserve-auth-context.test.ts`, `tests/responses/compact-transient-alternate.test.ts`,
`tests/responses/responses-alternate-main-cancellation.test.ts` and
`tests/responses/responses-preview-main-read-fence.test.ts` fail on the pre-change code and pass after it.

## Outcome

PR #8096. Plan audited over five rounds; implementation reviewed by a dedicated security review
and an independent code review before publication.

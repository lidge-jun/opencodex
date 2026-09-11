# 007 — audit round 4: wp1 plan re-audit against the rebased tree

Auditor: sol-high subagent, read-only, run after `codex/prio70-train-260831` was
rebased onto `origin/dev` = `7666f7d2a`. Verdict **FAIL** — the approach holds,
the plan's claims about its own tests did not.

## Findings

1. `src/codex/model-entitlements.ts:83-86` is exactly `derived ?? fallback`. The
   gated set (`src/codex/catalog/native-models.ts:5-10`) is sol/terra/luna plus
   Daybreak; the snapshot carries only the three gpt-5.6 rows, each recording
   `0.142.2` (`src/codex/data/upstream-models.json:4-66`, `:122-184`, `:238-296`).
   Daybreak has no row. Derived value confirmed as `0.142.2`.

2. **Planned regression 2 would not have gone red.** The existing mock at
   `tests/codex-model-entitlements.test.ts:245-246` admits every minor `>= 142`,
   and `144 >= 142`. Raising the floor alone leaves it green. The mock threshold
   must move to `>= 144` and the surrounding comment at `:238-240` with it.

3. **Planned regression 4 is not red-first.** "A non-empty roster stays confirmed"
   passes before and after. It is a characterization guard against over-reach, and
   the plan must stop claiming otherwise. Only 1, 2 (after the mock correction), 3
   and 5 are genuinely red.

4. The proposed `tests/claude-models-discovery.test.ts` addition needs a
   version-sensitive backend. The existing no-inbound mock at `:404-411` answers
   Daybreak for every version, so as written the new case is green on both sides.

5. Only one existing assertion changes outcome anywhere in the suite:
   `tests/codex-model-entitlements.test.ts:90`, `confirmedAccountIds.has("main")`
   from `true` to `false`. Nothing in `tests/e2e-style/` asserts it.
   `tests/codex-catalog-sync-hardening.test.ts:385-442` sends a non-empty usable
   roster and `tests/claude-models-discovery.test.ts:518-559` supplies inbound
   `0.151.7`, so neither is affected.

6. No consumer needs an all-filtered response to stay confirmed. Every projection
   requires confirmation **and** membership (`:570`, `:578-580`, `:587-593`,
   `:611-619`), so an empty set denies identically either way. Collapsing
   "zero rows returned" and "rows parsed to empty" is correct under the current
   usable-roster contract.

7. **The 15s TTL is demand-driven, not timer-driven**, so 2a opens no background
   churn. Refetch happens only through `/v1/models`
   (`src/server/index.ts:1158-1164`), Direct gated authorization
   (`src/codex/auth-context.ts:382-385`), catalog sync
   (`src/codex/catalog/sync.ts:1834-1840`) and convergence
   (`src/codex/convergence.ts:409-416`). Same account and version coalesce onto one
   flight (`:461-470`); distinct versions are capped at four concurrent per account
   (`:472-483`). Worst case for a legitimately empty account under continuous
   polling is roughly four fetches per minute per active version. Sequential
   high-cardinality version cycling is concurrency-bounded but not rate-limited —
   recorded as pre-existing, out of scope here.

## Required plan changes (all applied to `010`)

- Correct the `:245` mock threshold to `>= 144` as part of regression 2.
- Relabel regression 4 as a green characterization guard.
- Give the Claude discovery case a version-sensitive backend.
- **New regression 6:** exercise the composition with a synthetic derived floor
  *above* `0.144.0`. Without it, replacing the exported floor with the bare
  literal `0.144.0` passes every other test while destroying the stated
  future-snapshot property (`010:28-36`).
- **New regression 7:** the all-filtered case must also prove refetch after
  15,001 ms. Flipping `confirmed` while leaving the five-minute TTL in place
  would otherwise pass regression 5.

## Round 5 (same reviewer, amended plan)

**VERDICT: FAIL** — three further corrections, all now applied to `010`:

1. Regressions 3 and 7 would not have exercised a real cache entry.
   `boundedCacheSet` runs only when `currentCredentialIdentity(accountId)` matches
   the snapshot identity (`src/codex/model-entitlements.ts:486-490`, `:330-340`),
   and the suite's `credential()` helper mints `test:<account>`
   (`tests/codex-model-entitlements.test.ts:28-34`), which matches nothing — so the
   TTL assertions would have measured an uncached path. The plan now prescribes the
   Direct-caller path (identity is a SHA-256 token fingerprint, `:437-451`) or a
   genuinely persisted record, and requires both halves: no refetch before 15s and
   exactly one after 15,001 ms.
2. The churn bound wrongly credited continuous dashboard polling. `/api/models`
   reaches only `listManagementModelRows`
   (`src/server/management/model-routes.ts:352-354`), which never resolves
   entitlements (`src/server/management/model-rows.ts:50-55`). The bound belongs to
   `/v1/models` and Direct gated demand; dashboard polling becomes a caller only
   when wp2 lands, so wp2 inherits the cost.
3. The plan still claimed an unconfirmed account loses `gpt-5.5`/`gpt-5.4`. It does
   not: both projections apply the flag only to gated slugs
   (`!ACCOUNT_GATED.has(slug) || (confirmed && entitled.has(slug))` at
   `src/codex/catalog/sync.ts:1617-1620` and
   `src/codex/convergence.ts:280-284`). `confirmed` suppresses account-gated models
   only. Retracted.

## Round 6

**VERDICT: PASS.** Two non-blocking notes (a duplicated sentence and
`direct:<token>` vs the actual SHA-256 fingerprint spelling) fixed on the spot.
Cleared to implement.

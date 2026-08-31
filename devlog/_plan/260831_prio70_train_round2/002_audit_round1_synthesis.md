# 002 — audit round 1: FAIL, nine blockers

One adversarial `gpt-5.6-sol` high-effort lane against the nine staged roadmap files.
Verdict FAIL. Every blocker was re-verified in-tree by the main session before it was
accepted; all nine held. Two of them invalidate a premise the plan was built on, which
is the whole reason this gate exists.

## Blocker 2 — wp3's ownership premise is false

`030` asserted `has_user_event` is Codex-owned and never written by OpenCodex.
OpenCodex writes it in `routeOpenai`/`routeExec`
(`src/codex/history-provider.ts:1158`) and in legacy recovery (`:1013`, which sets it
to `1` unconditionally). Worse, an existing test *requires* OpenCodex's `0 → 1`
routing write to restore back to `0` (`tests/codex-history-provider.test.ts:261`).

So "preserve every observed value" would have broken a contract already under test.
The corrected rule is narrower and has to be stated as a direction rather than a
permission: preserve only monotonic `0 → 1` drift, and only while provider and source
still match the untouched original tuple. `has_user_event` stays in the CAS and
readback for OpenCodex post-images, because there OpenCodex really is the writer.

This is the round-1 lesson repeating in a new place: `005` of the previous unit found
a fix whose justification was a fact about the tree that was not true. The
justification is load-bearing, not decoration.

## Blocker 1 — wp5 was planning to fix one of two updaters

`050` changed the Bun updater and the CLI. Dashboard npm updates run through
`bin/ocx.mjs` (dispatched at `src/update/job.ts:428`), and that launcher has its own
independent guard which still aborts on any non-zero stop (`bin/ocx.mjs:346`). The
reported symptom arrives via the dashboard, so the plan as written could have gone
green while the reported path stayed broken.

The deeper point the auditor made: a TypeScript type cannot cross a subprocess
boundary. A shared "typed stop outcome" is not implementable as a type alone — it needs
a runtime wire representation, i.e. a dedicated exit code or a machine-readable
receipt, and both lanes have to consume it.

## Blocker 3 — wp2's reservation was one envelope short

Windows publication can fall back from hard-linking to copying
(`src/responses/spill-store.ts:404`), and during the fallback the destination copy
exists while the temp file still exists and destination ACL hardening is awaited
(`:597`). Peak footprint is therefore two envelopes, not one. Reserving one keeps the
cap violable by exactly the margin the issue is about.

## Blocker 4 — wp4 could turn a stale reading into a permanent block

`shortPercent` travels with `shortResetAt` (`src/codex/quota.ts:23-25`), and
`getAccountQuota()` performs no expiry check (`:510`). Partial updates preserve the old
short tuple (`:319`) and disk hydration accepts it for six hours. Scoring 100 from
`shortPercent` alone would keep excluding an account whose five-hour window has since
reset — converting a transient exhaustion into a durable exclusion.

That inverts the issue. #3029 is a complaint that an exhausted account stays selected;
fixing it by making a recovered account stay excluded is the same bug pointed the other
way. Terminal-short scoring has to be reset-aware.

## Blocker 5 — generation is not lineage

`060` claimed keying recovery on credential generation fences concurrent rotation. The
existing primitive's own documentation says otherwise: `forceRefreshCodexPoolToken`
returns `selfRefreshed` precisely because generation alone cannot distinguish this
caller's refresh CAS from somebody else's replacement
(`src/codex/account-store.ts:575-590`). A concurrent reauthentication moves
`G → G+1`, and marking `G+1` spent from the old rejection suppresses the *new*
credential's own recovery.

The doc was written without reading the comment on the function it planned to call.

## Blocker 6 — wp1's gap list was incomplete

PR #3069's head `5cf5cc1d230` still has a stale first summary line saying batches
carry no singular `query` (PR-head `src/bridge.ts:149`), and the head's review state is
`CHANGES_REQUESTED`, not merely "review required". Empty `queries: []` is also
undefined behaviour while the loose input schema admits it.

## Blocker 7 — a dependency that does not exist

wp6 was declared a stacked child of wp4 on the theory that both touch the pool quota
path. They do not: wp4 changes `src/codex/routing.ts` scoring, wp6 changes
auth/token recovery, and PR #3020's file set contains no `routing.ts`. wp6 bases
directly on `dev`. No other pair needs ordering.

A false dependency is not harmless — it serializes two phases that could land
independently and invents a rebase that can only introduce conflict.

## Blocker 8 — three named test files do not exist

`tests/responses-spill-store.test.ts`, `tests/codex-quota.test.ts` and
`tests/update.test.ts` were all invented. Confirmed against `ls tests`: the real
neighbours are `tests/responses-state.test.ts`,
`tests/quota-scoring.test.ts` / `tests/routing-policy-pool-quota.test.ts`, and
`tests/update-job.test.ts`. A verification command that cannot run is worse than none,
because it reads as evidence.

## Blocker 9 — the scores are not recheckable

`000` claims recheckable scores and then prints only totals. wp6 sits exactly on the
threshold at 70, so its admission cannot be audited at all without components. The
component values exist — the lanes produced them — they just were not carried into the
plan.

## Two corrections to the plan's own claims (accepted nits)

- Auto-switch suppression for an already-affined thread happens in
  `reevaluateAffinityQuota` (`src/codex/routing.ts:1745`, called at `:1965`), not at
  `:1604`. `040`'s branch trace named the wrong line; the behaviour is real.
- The history warning at `src/update/index.ts:269-275` is unreachable on the reported
  failed-history path, not globally. A skipped history outcome can still yield overall
  stop success while a manifest remains (`src/codex/inject.ts:1652`).

## What the audit confirmed

The codex-rs rendering trade in `010` is sound: current codex-rs prefers a non-empty
`query` and produces "<first> ..." only from plural `queries` when `query` is absent.
PR #3040's fail-open diagnosis, PR #3003's two missing pre-WHAM skip facts, PR #3056's
id-aware half-fix and PR #3032's pending-publication gap all re-checked out at their
refreshed heads.

# 080 — wp8: freeze, verification, and the GO/NO-GO report

Phase: wp8. Depends on **every** preceding phase.

## Purpose

Turn a sequence of merges into a single defensible claim: *this exact `dev` SHA
is a release candidate.* Nothing here is new development. If this phase wants to
change code, a previous phase was closed too early.

## Sequence

1. **Freeze.** Record the frozen `dev` SHA. No further PR enters the train after
   this point; a later inclusion restarts the gate matrix.
2. **Gates at the frozen SHA**, all exit 0:
   - `bun run typecheck`
   - `bun run test`
   - `bun run privacy:scan`
   - `bun run lint:gui` if any GUI file was touched (none is expected)
3. **Per-phase re-verification.** Re-run each merged phase's focused verifier at
   the frozen SHA, not at the SHA it was merged on. Individually-green fixes can
   still interact.
4. **#2472 disposition.** Per 000, the mandatory artifact is the automated
   mixed-sequence regression, not a live 100-call canary. Record the outcome and
   classify: resolved-by-existing-fix, still-open-but-not-a-blocker, or
   release-blocker.
5. **Issue closure.** For each merged PR, close its linked issue manually — these
   PRs target `dev`, and GitHub auto-closes only on merge into `main`.
   #2426 closes on wp5's evidence; #2460 on wp7's, if included.
6. **Report.**

## GO/NO-GO report contents

The report is the deliverable. It must name:

- The frozen `dev` SHA and the SHA `main` was at when the train started.
- Every included PR with its merge SHA and its focused-verifier evidence.
- Every excluded PR with the reason (from 000's tables, not re-derived).
- Every gate with its exit code and where the output is recorded.
- The known-shipped-defect ledger with each item's disposition.
- The explicit statement that no promotion, tag, or publish was performed.

## GO conditions

- `main`'s release lineage is in `dev` (wp1 ancestry proof).
- Every included PR merged at a head based on post-wp1 `dev`.
- Zero unresolved review threads on merged PRs.
- #2477 carries a recorded independent security review.
- All gates in step 2 exit 0 at the frozen SHA.
- Every phase's focused verifier green at the frozen SHA.

## NO-GO conditions

- A foreign tool-type selector can still authorize a namespace alias.
- An oversized turn opens a socket before falling back.
- #2476 changed the 24 MiB cap, TTL, or eviction order.
- A hygiene-blocked PR reached the train.
- Any merge justified by a remembered rather than exact-head result.
- New runtime feature work after freeze.

## Terminal boundary

This phase ends at the report. Promotion to `main`, tagging, and publishing
v2.32.1 are human decisions outside this unit's authority, and the report exists
to make that decision cheap — not to pre-empt it.


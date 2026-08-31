# 006 — audit round 5: two phases cleared, four blockers left

First round to clear anything outright.

**wp2 and wp5 are closed.** The reviewer walked every exit from the shutdown fallback —
the mismatch `continue`, budget terminalization, writer return and throw, no-swap
fallthrough, terminalization — and confirmed the round-4 "settle on every exit" rule
covers them all. It suggested an idempotent `finally`-style settlement as good practice
and explicitly declined to call it a blocker. Exit code `79` is unused as an exit status
across the repository; the only literals are quota fixtures and generated protobuf
metadata. Score sums re-checked: 73, 75, 75, 72, 71, 70.

## Blocker 1 — the migration table refused the ordinary case

A v1 entry recording `openai/vscode/0` whose row is now `opencodex/vscode/1` — the
everyday routed post-image from `src/codex/history-provider.ts:1158` — is a `0 → 1`
drift, and the round-4 table refused every v1 drift. That contradicts the live contract
at `tests/codex-history-provider.test.ts:261`.

I built the table around the drift because the drift is what #3026 is about, and never
asked which *other* rows also exhibit drift. Two do, and one of them is the common path.

The corrected model classifies on the shape of the observed row first — exact original,
recognized OpenCodex routed post-image, or original-tuple drift — and only the third
shape consults provenance. Rows one and two are decidable without it, which is what makes
the table disjoint and what shrinks the legacy-refusal set to something honest.

The reviewer also caught that provenance was being read as a manifest-level property.
Version is global; the field belongs on `CodexHistoryBackupEntry`, or a rewritten mixed
manifest loses which absences were legacy.

## Blocker 2 — the tri-state detected the crash instead of recovering from it

"Refuse every `relabel-pending`" wedges restore permanently after a crash between the
routing commit (`:1230`) and the marker's resolution — the exact window the tri-state was
introduced to survive.

The row answers the question the marker could not: shape A means the write did not land
(resolve to `relabel-none`), shape B means it did (resolve to `relabel-committed`),
anything else is foreign and refuses. Resolution is idempotent and runs at restore time,
so it opens no further window.

Naming the failure honestly: round 4 asked for "crash-recoverable" and I wrote
crash-*detecting*. A state that says "something happened here" and then refuses forever
is a more elaborate wedge, not a recovery.

## Blocker 3 — a test file in the command is not a test

Round 4 added `tests/subagent-model-fallback.test.ts` to wp4's verification line and left
every new assertion in `tests/codex-routing.test.ts`. If
`isNativeModelQuotaExhausted` keeps dropping its injected `now`
(`src/codex/subagent-model-fallback.ts:218`), every listed test stays green while stale
quota pushes subagents off a live model.

`040` now specifies two subagent cases with an injected clock deliberately far from wall
time — the only fixture shape that catches a `Date.now()` substitution.

## Blocker 4 — three false claims in my own documents

`000` pointed at `001` for below-bar per-item scores that were never written there.
`070` claimed 12 documents and three audit rounds against a staged 13 and four.

These are small and they are the same category as everything this gate exists to catch:
a document asserting evidence it does not contain. `001` now carries the full below-bar
matrix, and `070`'s counts match the index.

## Where this leaves the roadmap

Four phases have survived a round with no findings against them; wp3 has absorbed three
rounds of correction on one predicate, which is a fair signal of where the real
difficulty in this train sits.

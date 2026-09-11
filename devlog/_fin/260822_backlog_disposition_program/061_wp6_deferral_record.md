# 061 — WP6 disposition: #1049 stays deferred, and why that is the answer

Work-phase 6 does not implement #1049. That was the conclusion at roadmap time, and
re-verifying it against `dev@cd77ee6c8` did not change it. This document records the
re-check so the deferral is a decision with evidence rather than a phase that quietly
got skipped.

## What was re-verified

```
rg -c 'adoption-pending' src/          ->  0
src/codex/inject-coordination.ts:116   ->  kind: "legacy-uncoordinated" still returned
src/codex/transition-state.ts:392      ->  new Database(finalDatabasePath, { create: true })
```

All three still hold after eight landed work-phases. The adoption machinery exists only
as a specification in `devlog/_fin/260804_codex_write_substrate/005_contract.md`; not one
symbol of it is in `src/`.

## Why this is deferred rather than hard

The obvious move — relax `codexWriteCoordinationEligibility` so legacy homes take the
lock — is wrong, and the code says so itself.
`assertInitialStateCanBeCreated` refuses to initialise a coordinator row while native
routing residue exists, because installing a `{0, null}` row over routed bytes would
erase the evidence of an interrupted transition. The refusal is correct. What is missing
is a *different* row identity (`adoption-pending`), not a weaker gate.

And the prerequisite is bigger than the feature. The contract requires publication
through a complete temp database plus an atomic no-clobber link, while today's create
path is:

```ts
database = new Database(finalDatabasePath, { create: true });
```

Replacing that rewrites the create path used by **every clean install**, not just legacy
ones. Publication is the crash boundary: a partial implementation corrupts user installs
that were previously fine.

## The disposition

Three phases, in dependency order, none of which fits inside a backlog-clearing pass:

1. A crash-safe temp-publisher with no-clobber publication, replacing `create: true` for
   every install.
2. The `adoption-pending` row identity and the narrowed eligibility gate.
3. Positive-authority plumbing through `history-job.ts`.

Each is independently reviewable and each has real blast radius. Bundling them into this
program would produce exactly the unreviewable mega-diff that got #2222 closed.

**#1049 stays open**, and this record is linked from it rather than a fabricated diff
being attached to it. Writing a plausible-looking implementation for a crash-safety
surface without the publisher underneath it would be worse than saying it is not done —
which is the same standard applied to #2350, #2351, #2355 and #2363 earlier in this
program.

## Terminal outcome

`NEEDS_HUMAN` for the implementation: the sequencing decision (whether the publisher
phase is worth opening now, and against which release) belongs to a maintainer.
`DONE` for this work-phase, whose deliverable was the verified deferral.


# Unit C — a pull-request build gate for the docs site

Opened because unit B's review could not honestly close. The Astro 7.2 to 7.3 bump
in #4873 had no pull-request build gate anywhere, so no amount of green CI on that
head was evidence the docs site still built. The alternative was to accept an
author's local result as the record, and that is not a standard this repository
applies elsewhere.

## The gap

`.github/workflows/ci.yml` contained no `docs-site` reference and built no docs.
`deploy-docs.yml` triggers only on `push` to `main`, which is after promotion. So
the first machine to discover a broken docs build was the deploy, and the only
pre-merge evidence available was an unverifiable attestation.

## Shape

A new `docs` filter in the existing `changes` job, and one job selected by it.

`docs-site/**` is deliberately **not** added to the `ci` filter. Widening `ci`
would start the whole cross-platform matrix for a prose edit, which is a cost with
no matching evidence: a docs change has to build, not to pass the runtime suite.
A separate filter output keeps the two questions apart.

`.github/workflows/ci.yml` is in the `docs` filter so an edit to the job verifies
itself. Without that entry this unit's own pull request would skip the job it adds,
which is the failure mode the unit exists to remove.

One Linux leg. The site is static output from a Node/Bun toolchain with no
OS-specific behaviour to promise, so a Windows or macOS leg would spend queue time
without buying coverage. `--frozen-lockfile` carries as much of the value as the
build does: it fails on a manifest and lockfile that disagree, which is exactly the
shape a hand-edited override introduces.

## Constraints honoured

No existing job's sharding, timeout, or runner selection is touched. No new Windows
leg. Workflow-level `permissions` stay `contents: read` and the job adds none.
Actions stay pinned to immutable SHAs with their version comments.

The aggregate gate is the part that is easy to get wrong. `ci` is event-aware since
#4837: it derives what the event requested and demands `success` from each requested
job and `skipped` from every other one, and it fails by name on any job with no
declared expectation. So the job is added in four places that must agree:
`needs`, `CHANGES_DOCS`, `GATED_JOBS`, and `expected_for`. And
`tests/ci-workflows/ci-workflows.test.ts` independently derives the expected
`needs` list from the workflow's own job keys, so a missing entry fails rather than
passing quietly.

`structure/ops/docs-and-release.md` owns `docs-site/` and is updated in the same
change, including the workflow map.

## Sequencing

This unit lands before #4873 merges. #4873 then needs a fresh run for the new job
to appear on its head; a re-run is the cheap way to find out whether the merge-ref
workflow already carries it, before considering anything that rewrites that branch.
Both calls belong to the host.

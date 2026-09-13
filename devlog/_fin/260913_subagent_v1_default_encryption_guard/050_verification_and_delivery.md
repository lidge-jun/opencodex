# wp5 — Verification and delivery

## Local checks

`bun run typecheck`, `bun run lint:gui`, and the focused files touched by wp2 and wp3.
The full suite is the hosted gate, not a local one: CI runs typecheck and the whole suite
on Linux, Windows and macOS, and that run is the evidence the merge decision uses.

## Screenshot

`enforce-target` rejects a PR that mentions `gui` without a screenshot of the UI change.
That is a real gate and this PR is squarely a GUI change, so the dialog is captured from a
running dashboard, not mocked in a drawing tool, and attached to the description.

## PR

Target `dev`. Fill Summary, Verification and Checklist from
`.github/PULL_REQUEST_TEMPLATE.md`. Reference issue #92 as context rather than `Closes`,
because this unit does not fix the encryption limitation.

## Merge

Maintainer integration through the PR, under the `dev` policy in `MAINTAINERS.md`: record
the decision and CI evidence at the exact final head. A green aggregate on an earlier
commit is not evidence for the head being merged.

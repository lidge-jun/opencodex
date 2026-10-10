# wp2 — shepherd #3848 onto the chain (quota-exhausted registration, #3846)

Author: @shaun0927 (Junghwan). This layer is carried, not reimplemented, so the original author's
`Co-authored-by` trailers are preserved on the branch commits — `missing_coauthor_credit` in
`.github/scripts/pr-carry-attribution.cjs` reads the trailer, and a sentence in a commit body is
read by nothing.

Substance (unchanged from the original PR): a Codex account whose weekly allowance is exhausted
cannot complete the mandatory inference warmup, so registration fails outright. The change persists
it as validation-pending, keeps it out of routing and manual selection, and requires a human
dashboard "Refresh quotas" click to finish validation, because finishing it spends model quota.

Work in this phase:

- Retarget the PR base from `dev` onto the wp1 head branch.
- Resolve the conflict against current `dev`. This is a conflict inside this lane's own chain,
  which is the one case the no-rebase rule does not cover; a cross-lane rebase still returns to the
  dispatching session.
- Preserve the GUI evidence screenshots already in the description — the PR touches `gui/`, so
  `missing_ui_screenshot` (`.github/scripts/pr-quality.cjs:531`) requires them.
- Restore repository hygiene: no vendored reference clones, no tracked gitlink, no security triage
  under `devlog/` (`tests/ci-workflows/repo-hygiene.test.ts`).

Class C4 — authentication, account store, guardian and GUI in one change.

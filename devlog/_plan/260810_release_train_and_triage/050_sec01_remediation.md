# 050 — WP5: privileged workflow trust boundary

Both `pull_request_target` gate workflows resolved their trusted scripts from a
pull-request-controlled ref. They now resolve from a fixed set of integration
branches.

## Why this document carries no analysis

Same rule as `040`: `AGENTS.md` keeps pre-disclosure reasoning out of the public
tree until the fix ships. The trust analysis, the severity assessment, and the
scope reasoning are in scratch. This file records the outcome.

## What landed locally

Commits `13f3a73fe` and `febd8c8e3`. Local to `dev`; not yet pushed.

- `.github/workflows/pr-hygiene.yml` and
  `.github/workflows/enforce-pr-target.yml` — the trusted-script checkout ref is
  chosen from an allowlist rather than following the pull request. A
  `main`-targeting PR sources from `main`, because `pull_request_target` loads
  the workflow itself from the default branch and a mismatched pair would be a
  worse failure than the one being fixed. The `status` event keeps sourcing
  from the default branch. Everything else resolves to `dev`.
- `.github/scripts/pr-hygiene.test.cjs`,
  `.github/scripts/enforce-pr-target.test.cjs` — both trust-boundary
  regressions previously asserted the old design, one of them explicitly
  forbidding the new literal. They now extract the checkout step's ref and
  compare the whole expression, because independent substring checks would pass
  with the operator grouping wrong.
- `tests/ci-workflows.test.ts`,
  `tests/zz-pr-coderabbit-readiness-revalidation.test.ts` — two further suites
  pinned the same expression from the Bun side and were only found by running
  the full suite. Four tests in total guarded this one line, which is a good
  sign about the repository and a reminder that a focused run is not a green
  build.
- Both CJS suites additionally gate the **whole workflow file** against
  interpolating a PR head ref, not just the checkout step. The re-review showed
  a malicious `run:` step could otherwise be added while every existing
  assertion still passed.

## Honest scope of the change

This is defense in depth, not a barrier. `dev` has no branch protection and
maintainers may push to it directly, so it removes nothing from a malicious
writer. What it removes is narrower and still worth having: a pull request can
no longer select which scripts execute with a write-capable token.

`.npmignore` excludes `.github/`, so none of this reaches the published package.

## Verification

- `node --test .github/scripts/enforce-pr-target.test.cjs .github/scripts/pr-hygiene.test.cjs`
  — 46 pass / 0 fail
- `actionlint` on both workflows — clean
- Activation proven by ablation: reverting to the old ref, and separately using
  a bare branch literal without the `main` case, each turned the tests red.

### Limit

No local harness executes a real `pull_request_target` run, and no emulator
proves GitHub's production ref resolution. The activation evidence is the next
triggering pull request's checkout log. This document says so rather than
claiming a proof it cannot produce.

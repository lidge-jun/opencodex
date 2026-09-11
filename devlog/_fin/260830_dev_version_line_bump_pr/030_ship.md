# 030 — ship it (wp4)

## Branch and commits

Branch `codex/dev-version-line-bump-pr` off `origin/dev`. Two commits, matching
the two implementation phases:

1. `fix(release): move dev's version line past the published 2.36.0`
2. `feat(release): open the dev version bump as a PR when a release publishes`

Plus the devlog unit. Push with `--no-verify` as the user directed.

## PR

Against `dev`, filling every `.github/PULL_REQUEST_TEMPLATE.md` section: Summary,
Verification, Checklist. No screenshot section is required — this touches no GUI.

The description must state the four prior hand-repairs, because that history is the
argument for the mechanism. Reviewers who see only the version bump will read it as
routine maintenance.

Release-tooling changes require explicit security review per `scripts/AGENTS.md` and
`MAINTAINERS.md`. Call that out in the description rather than leaving a reviewer to
discover it, and be precise about what the new workflow can do: it takes
`contents: write` to push a NEW unprotected bump branch and `pull-requests: write` to
open the PR. It does not use the release deploy key, does not write to protected
`dev` directly, and is a separate file from `release.yml` so the publish job's
permissions are unchanged.

## Evidence required before the merge claim

Local:
- `bun test tests/release-version-line.test.ts` — pass.
- `bun test tests/bump-dev-version.test.ts` — pass, including the NOOP case that must
  leave `package.json` byte-identical.
- `bun test tests/release-helper.test.ts` — pass, proving the existing release
  contract is unbroken. `scripts/release.ts` is deliberately NOT modified by this
  unit, so this suite is a regression check rather than coverage of new behavior.
- `actionlint` on the new workflow if available; otherwise state that the YAML was
  not machine-validated.
- `bun x tsc --noEmit` — clean.
- `bun run privacy:scan` — clean.
- `bun run prepush` — required by `scripts/AGENTS.md` for release-tooling changes.
- Red-then-green transcript for each new assertion.

Remote:
- `gh pr checks` for the PR head showing `test 2/4` and `macos` GREEN. This is the
  specific flip that proves the fix: those two jobs are red on `dev` today for this
  exact test.

The full local root suite is prohibited by the user. State that boundary in the PR
and rely on CI for whole-suite coverage.

## Merge

Merge into `dev` once the two previously-red jobs are green. If some unrelated job
is red, check whether it is also red on `dev` at `c2778ca3a` before deciding — the
point of this unit is to stop inheriting someone else's red, not to add to it.

## Required follow-up, not part of this PR

`.github/workflows/dev-version-bump.yml` DOES NOT RUN until it reaches `main`. A
`release` event resolves the workflow file from the repository default branch, which
`gh repo view` reports as `main`; this repository documents the same trap for
scheduled workflows in `cleanup-closed-pr-branches.yml:8-10`.

So merging this PR into `dev` installs the file but arms nothing. The workflow first
fires after the next ordinary `dev` -> `main` promotion carries it there. That
promotion is maintainer-controlled (`MAINTAINERS.md`) and explicitly out of scope
here: this unit must not touch `main`.

State this in the PR description. A reviewer who assumes the merge activates the
automation will believe the loop is closed a release earlier than it is.

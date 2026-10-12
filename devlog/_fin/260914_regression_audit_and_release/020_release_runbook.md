# 020 — Release runbook for 2.55.0

The exact sequence, in order, with the check that gates each step. Every command
below was derived from `scripts/release.ts`, `release.yml` and
`dev-version-bump.yml` rather than from memory, and audited against them.

## 0. Precondition

The cross-merge audit is clean or its findings are fixed and merged into `dev`.

## 1. Preview promotion

Branch from the audited `dev` tree. Rewrite `package.json` to
`2.55.0-preview.<YYYYMMDD>`. Open a pull request into `preview`.

`preview` is protected and requires a pull request, so the version line moves
inside the promotion rather than through a direct push.

Merge it. **The merge commit is the release SHA.**

## 2. Preview publish gate

At that merge SHA, both must be green before dispatch:

- `ci.yml` from the **push** event on `preview` — a pull-request run at the
  same SHA does not satisfy the gate
- `service-lifecycle.yml`, because `package.json` is a trigger path for it

Then check by hand the two things only the script would have checked: the working
tree is clean, and the npm dist-tag for `preview` moves forward rather than back.

## 3. Preview dispatch

Dry run first, then the real one:

`gh workflow run release.yml --ref preview -f version=2.55.0-preview.<stamp> -f tag=preview -f expected-sha=<40-char merge sha> -f dry-run=true`

Watch it, then repeat with `dry-run=false`. The dry run exercises the real
release commit, which is the point of running it at all.

## 4. Main promotion

Branch from the same audited `dev` tree, leaving `package.json` at `2.55.0`.
Open a pull request into `main` and merge it. That merge commit is the stable
release SHA.

## 5. Move dev to 2.56.0

`gh workflow run dev-version-bump.yml -f intended-version=2.55.0`

The input is the version about to be released; the workflow computes 2.56.0 from
it and opens a pull request into `dev`. Merge that pull request.

This has to land **before** the stable publish, because `release.yml` asserts
`origin/dev:package.json` is strictly ahead of the version being released, and
equal versions fail.

## 6. Stable publish

Same gate as step 2, at the `main` merge SHA: push-event `ci.yml` on `main`,
plus Service lifecycle. Then:

`gh workflow run release.yml --ref main -f version=2.55.0 -f tag=latest -f expected-sha=<40-char merge sha> -f dry-run=true`

then the same with `dry-run=false`.

## 7. Record

The workflow run ids for both publishes, the resulting npm dist-tags, and the git
tag the workflow creates after publish.

## The failure this ordering prevents

Publishing stable 2.55.0 while `dev` still says 2.55.0 does not fail cleanly at
dispatch — it fails after the promotion pull requests have already merged, with
the tree public and the version line stuck. The repository has repaired that state
by hand four times, which is why `dev-version-bump.yml` exists at all. Doing the
dev move before the publish is the whole point of the workflow.

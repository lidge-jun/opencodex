# 030 — promote dev content onto main

## What changes

`main` moves from `ec51e42d7` (293 commits behind) to a merge carrying `dev`'s tree.
This is the promotion the readiness statement in `260827_dev_hardening/070` was written for.

## How

Same shape as `010`: a PR from `dev` to `main`, merged with `--admin`, because `main`
requires a pull request and the `RepositoryRole` bypass is `pull_request` only.

## Ordering

After `020`, not before. Publishing the preview channel first is what makes the stable
release a re-publication of already-exercised content rather than a first contact.

## Acceptance

- `git diff --stat origin/dev origin/main` shows only `package.json` or nothing
- the merge sha is recorded
- `main` contains `origin/dev` (`git merge-base --is-ancestor origin/dev origin/main`)

## Carried forward from the hardening unit

PR #2745 is unmerged by design, so the credential-identity drift it fixes ships to `main`
unfixed. That is disclosed in the readiness statement and is not a new decision made here.
The release notes must not imply otherwise.

## Outcome — promoted, and the plan changed on contact

`main` = `80fff9a7f47332a4445df2b26ea175053fa55b0b` (merge of PR #2760, branch
`codex/promote-main-2340` at `e25b653a2`). `git diff origin/dev origin/main` is **empty** —
not "only package.json", empty — and `main` now carries `2.34.0`.

### The stale-version pattern this page inherited is no longer legal

This page and `000` both planned to keep `main`'s `2.33.0` through the conflict, following
#2553 and #2507, so that the release bump would land on its own `release: v2.34.0` commit.
The first push of the branch (`8a0bd3f83`) did exactly that and CI failed it correctly:

```
(fail) release version line > the in-tree version is never behind a released one
```

in both `test 3/4` (job `98518314466`) and `macos` (job `98518314397`).

`tests/release-version-line.test.ts` arrived **in this very delta**. It compares
`package.json` against the highest local release tag, and once `v2.34.0-preview.20260827`
existed, `compareReleaseTags("v2.33.0", "v2.34.0-preview.20260827")` is `-1`. The stale line
put the tree behind a published version — precisely the "merging into main resolves
package.json to main's side and silently republishes" failure the test's own header
describes. The precedent PRs predate the test; they were not wrong, they are superseded.

Resolved by rebuilding from `ec51e42d7` with the conflict taken to dev's side
(`8a0bd3f83` → `e25b653a2`, force-with-lease).

### What that costs at the release step

`release.ts:568` skips the bump when `package.json` already matches the target, so
`v2.34.0` will be tagged on the promotion merge commit rather than on a separate
`release: v2.34.0` commit. Acceptable: `release.yml` creates the tag itself after a
successful publish and validates `expected-sha` against the checked-out commit, so the tag
still names exactly the audited tree. `040` proceeds against `80fff9a7f` directly.

### Gate accounting

| Check | Result |
| --- | --- |
| Cross-platform CI `33074009466` | success, zero failed jobs |
| Service lifecycle `33074009519` | success |
| PR hygiene `33074473195` | success after `suppression-approved` was re-applied |
| `enforce-target` | `wrong_base`, expected for a promotion (`ALLOWED_BASES = ["dev"]`) |
| CodeQL | 53 alerts, none introduced: `dev` already has 84 open (78 high), `main` 73, and the branch diff against `dev` is empty |

The force-push cleared `suppression-approved` and re-added `intake: hygiene-blocked`, which
is worth knowing for the next promotion: the label has to be re-applied after **every**
push, not just the first.

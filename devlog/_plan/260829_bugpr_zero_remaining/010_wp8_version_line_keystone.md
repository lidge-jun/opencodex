# wp8 — Keystone: repair `dev`'s version line

Dependency position: FIRST. Every other work-phase rebases onto the `dev` this phase
produces, because the red `test N/4`/`macos` shards on six bug PRs are inherited from
the base and cannot be repaired by rebasing onto an unrepaired `dev`.

## Defect

`tests/release-version-line.test.ts` asserts the in-tree version is never behind the
highest local release tag. Live state:

- `dev` `package.json`: `2.35.0`
- highest release tag: `v2.36.0-preview.20260829` (published 2026-08-28T16:09:12Z)
- `preview` `package.json`: `2.36.0-preview.20260829`

`compareReleaseTags("v2.35.0", "v2.36.0-preview.20260829") < 0`, so the assertion fails
on every commit whose tree descends from `dev`.

## Change map

```
MODIFY package.json                 "version": "2.35.0" -> "2.36.0-preview.20260829"
```

One line. No source, test, or workflow change.

### Why that exact string

Candidates were RUN through the repository's own comparator rather than reasoned about
(`.tmp/bugpr-campaign/probe.ts` importing `scripts/release-notes.ts`; positive means
ahead of the highest tag `v2.36.0-preview.20260829`):

```
2.35.0                           -1
2.35.1                           -1
2.36.0                            1
2.36.0-preview.20260829           0
2.36.0-preview.20260829.1         1
2.36.0-preview.20260830           1
2.37.0-preview.1                  1
```

`2.36.0-preview.20260829` returns 0, and the test's equality branch is legal only on the
commit the tag names (`tagPointsAtHead`) — a `dev` merge commit is not that commit, so
equality fails as a duplicate claim. That leaves the strictly-ahead options, and repository
precedent decides between them: `dev` carries the next STABLE version after a release,
never a preview suffix.

- `e4a85d134` set `dev` to `2.34.0` when it trailed a published `2.33.0`.
- `076ad3036` set `dev` to `2.35.0` immediately after `v2.34.0` shipped.
- `32529c2b2` set `dev` to `2.27.0` when it trailed `2.26.0`.

So the value is the next stable minor:

```
MODIFY package.json                 "version": "2.35.0" -> "2.36.0"
```

Availability confirmed live: `npm view @bitkyc08/opencodex@2.36.0` returns
`E404 No match found for version 2.36.0`, `git tag --list v2.36.0` is empty, and the
published dist-tags are `latest=2.35.0`, `preview=2.36.0-preview.20260829`. Minor rather
than patch follows the same precedent: the range since `v2.35.0` carries behavior
changes, not only fixes.

## Accept criteria

1. `bun test tests/release-version-line.test.ts` passes locally on the branch (3/3).
2. Activation scenario (C-ACTIVATION-GROUNDING-01): the failing assertion is the
   trigger. Before the change it fails with the quoted BEHIND message; after it passes.
   Both runs are recorded.
3. The PR's own `test N/4` and `macos` checks pass on the exact head SHA.
4. `scripts/release.ts` channel logic is untouched, so no release behavior changes.
5. **Review (added after the A-gate audit).** `package.json` is a restricted path in
   `.github/scripts/pr-sponsored-surface.cjs` (under `// Dependency surfaces.`). The
   `hygiene` gate passes here only because `assessSponsoredSurface` short-circuits when
   `authorHasPushPermission` is true, and the PR is maintainer-authored — that is an
   exemption from the SPONSORSHIP label, not from review. `MAINTAINERS.md` still requires a
   maintainer approval and forbids self-approval, and `gh pr view 2836 --json reviewDecision`
   returns `REVIEW_REQUIRED`.

   The gate is executable, not a promise: `scripts/ci/assert-mergeable-review.sh 2836` must
   exit 0 before merge, and the merge uses `--match-head-commit <headRefOid>` so a race
   cannot land a different tree than the one verified. At the time of writing it exits 1
   (`no maintainer approval bound to head befcac3e10...`), so #2836 is NOT merge-ready.

   The audit's round-2 position is recorded and adopted: there is no admin-merge alternative
   for this criterion. An earlier draft of the synthesis offered "or an explicit recorded
   operator decision to admin-merge"; that is exactly the bypass the criterion exists to
   close, and it is withdrawn. If the approval cannot be obtained, wp8 reports BLOCKED and
   the operator decides — the campaign does not decide for them.

## Out of scope

- Any promotion to `preview` or `main`.
- Any change to `scripts/release.ts` or `.github/workflows/release.yml`.

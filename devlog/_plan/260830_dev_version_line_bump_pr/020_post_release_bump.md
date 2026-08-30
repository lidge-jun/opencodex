# 020 — open the dev bump as a PR when a release publishes (wp3)

Third draft. Two independent audit rounds failed the first two; both verdicts and the
reasons are recorded below, because each one changed the design rather than the prose.

## Round 1 rejected a printed notice (option C)

> The detector already exists and is louder than a notice.
> `tests/release-version-line.test.ts` fails CI on every unrelated PR, and TWO
> hand-repairs happened after it landed — `e4a85d134` added it. A printout is a
> reminder, not a mechanism.

Also verified: `dryRun = !args.includes("--publish")` (`scripts/release.ts:492`) makes
the default invocation a rehearsal, so a notice fires on every dry run until it is
trained away; and `release.yml` is `workflow_dispatch`, so an Actions-tab release
never runs `scripts/release.ts` at all.

## Round 2 rejected the first PR-workflow design

Three blockers, each confirmed against the repository:

1. **It would never fire.** A `release` event runs the workflow file from the
   DEFAULT branch. `gh repo view` reports `main`. This repository already documents
   the identical trap in `cleanup-closed-pr-branches.yml:8-10` for scheduled
   workflows. Landing the file on `dev` alone starts nothing.
2. **It could not import its comparator.** `compareReleaseVersions` is exported from
   `scripts/release.ts:303`, but that file parses `process.argv` and calls
   `process.exit(1)` at module scope (lines 487-491) with no `import.meta.main`
   guard. `tests/release-version-line.test.ts:27-29` already records that importing
   it kills the runner.
3. **The bump rule was wrong for preview-first releases.** `befcac3e1` moved `dev`
   from `2.35.0` to `2.36.0` when the published tag was
   `v2.36.0-preview.20260829`. "Increment the released core's minor" would have said
   `2.37.0` and skipped a stable version that had not shipped.

## Chosen design

A separate workflow that opens a PULL REQUEST against `dev`, plus a pure script that
decides the version.

**Honest scope.** This does not silently repair `dev`; it converts a forgotten chore
into a review-queue item that a human merges. Until that merge,
`release-version-line` stays red on `dev`. That is a real improvement over today —
a PR is durable where a printout is not, and it lands in the same place
`MAINTAINERS.md` already requires every `dev` change to land — but it is not an
autobump, and this unit should not be described as one.

## The version rule

Not "+minor" — that contradicts `befcac3e1`. But not "lowest unused stable" either,
phrased as if the script could evaluate it: "unused" is a property of the TAG SET and
the npm registry, and a pure function cannot see either. Stating the rule that way
would have made the doc unimplementable in exactly the manner the previous two drafts
were.

Split the rule by who can answer it:

**The script decides the CANDIDATE from the published version's SHAPE alone.**

| published | candidate | precedent |
|---|---|---|
| `X.Y.Z-preview.*` (a prerelease of an unreleased core) | `X.Y.Z` | `befcac3e1`: 2.35.0 -> 2.36.0 on v2.36.0-preview.20260829 |
| `X.Y.Z` (stable) | `X.(Y+1).0` | `e4a85d134` 2.33.0 -> 2.34.0; `076ad3036` 2.34.0 -> 2.35.0; `32529c2b2` tip 2.26.0 -> 2.27.0 |

Both rows are pure string arithmetic on the published version, and both are pinned by
tests. The prerelease row is the one that matters: the stable core of a
preview-first release has NOT shipped, so `dev` should carry it rather than skip it.

**Freeness is verified where the tag set is visible.** The candidate is passed to the
existing detector, not re-derived: after the bump the workflow runs
`bun test tests/release-version-line.test.ts` in the `dev` checkout, which sorts the
real local tags with `compareReleaseTags` and fails if the candidate is at or behind
any published version. If that test fails, the workflow opens NO PR and the job goes
red — a visible request for a human decision, not a wrong PR.

This is the honest division: shape arithmetic in the pure function, set membership in
the tag-aware gate that already exists. The script additionally refuses to emit a
candidate that `compareReleaseTags` does not rank strictly ahead of both `dev`'s
current version and the published one, which is the part it CAN check without I/O.

## Files

**`scripts/bump-dev-version.ts`** — pure decision logic, no git and no network.

- Imports `compareReleaseTags` from `scripts/release-notes.ts`, NOT
  `compareReleaseVersions` from `scripts/release.ts`. `release-notes.ts` guards its
  CLI behind `import.meta.main` (line 1231) and already exports the comparator at
  line 66, which is exactly why `release-version-line.test.ts` imports from there.
  This avoids editing `scripts/release.ts` at all, keeping the release authority and
  its security review surface untouched.
- Takes the released version and an explicit `package.json` path, so a test can
  operate on a temp copy and the script is genuinely pure with respect to the
  checkout.
- Emits a MACHINE CONTRACT, not prose: writes `changed=true|false` and `version=<v>`
  to `$GITHUB_OUTPUT` when set, and prints the same as JSON otherwise. Round 2 was
  right that "print the chosen version" mixed with "print that nothing is needed" is
  not an interface.
- `dev` already ahead -> `changed=false`, file untouched, exit 0.
- Malformed released version -> non-zero exit, file untouched.

**`.github/workflows/dev-version-bump.yml`** — the actor.

- Trigger: `release: [published]` only. No `workflow_dispatch`: round 2 correctly
  noted that a branch-selected manual run executes THAT branch's body with
  `contents: write`, which is the pattern this repository's own workflow comments
  refuse. A missed run is re-driven by running the script by hand and opening the PR
  normally.
- `permissions: {}` at the top; the single job takes `contents: write` (to push a new
  `codex/dev-version-<v>` branch — ruleset `Protect dev` covers only
  `refs/heads/dev`, so the new branch is unprotected) and `pull-requests: write` (to
  open the PR). Not `issues: write`, not `id-token: write`.
- `actions/checkout` with `ref: dev` AND `fetch-depth: 0` (or `fetch-tags: true`). A
  `release` checkout defaults to the tag on `main`/`preview`, which is the wrong tree
  to bump — and the tags are not optional decoration: `release-version-line.test.ts`
  returns early on an empty tag set (line 93), so a shallow checkout would make the
  freeness gate below silently vacuous rather than failing loudly.
- Do NOT copy `persist-credentials: false` from the repository's read-only workflows.
  This job has to push its bump branch.
- Set up Bun and run `bun install` before the freeness gate: that gate is a
  `bun test` invocation, not a shell comparison.
- Idempotent: if `codex/dev-version-<v>` or its PR already exists, log and exit 0
  rather than failing the push. A second publish must not error.
- The workflow file must reach `main` to ever run. That is a promotion, not a
  `dev`-only change, and `030` records it as an explicit follow-up rather than
  pretending the merge to `dev` activates it.

**Known limitation, stated not hidden:** a PR opened with `GITHUB_TOKEN` does not
start `pull_request` workflows, so the bump PR arrives without CI. `Protect dev`
additionally requires an approving review and code-owner review, and
`.github/CODEOWNERS` assigns `/.github/` and `/package.json` to human owners. A bot
cannot satisfy those. The PR is therefore a prepared, reviewable change — which is
the honest ceiling for automation here, and the reason the "autobump" framing is
dropped.

## Test

`tests/bump-dev-version.test.ts`, against temp copies of `package.json`. No shim
harness: the script is pure and takes a path.

- dev `2.36.0`, released stable `2.36.0` -> `2.37.0`, `changed=true`.
- dev `2.35.0`, released stable `2.36.0` -> `2.37.0` (behind, not merely equal).
- dev `2.35.0`, released `2.36.0-preview.20260829` -> `2.36.0`. Pins `befcac3e1`, and
  fails under a naive "+minor" rule, which is what makes it the load-bearing case.
- dev `2.36.0`, released `2.36.0-preview.20260830` -> `changed=false`: dev already
  carries the prerelease's stable core, so there is nothing to do.
- dev `2.37.0`, released `2.36.0` -> `changed=false`, file BYTE-IDENTICAL, exit 0.
- dev `2.37.0-preview.1`, released `2.36.0` -> `changed=false`; a preview of a future
  core is ahead, which `release-version-line.test.ts` already pins.
- released version malformed -> non-zero exit, file untouched.

Red-first for a CLI is a behavioral red, not an import error: assert the chosen
version and the untouched-file invariant, and confirm each assertion fails against a
deliberately wrong rule (e.g. always `+minor`, which breaks the preview case) before
committing.

## Also

`MAINTAINERS.md`: after a release publishes, a `dev` version-bump PR is opened
automatically; merging it is part of closing out the release. Note that the workflow
only runs once it is on `main`.

## As implemented

Shipped in `075a33be8`. Three deviations from the sketch above, recorded because each
was forced by the tree rather than chosen:

1. **Bun setup uses the repository's composite action**, `./.github/actions/setup-project-bun`,
   not a hand-pinned `oven-sh/setup-bun` SHA. That action resolves the version from
   `package.json` so the runtime source of truth stays in one place; an independently
   pinned SHA here would have drifted from every other job. The first draft of the
   workflow pinned its own and disagreed with the one already in the tree.
2. **`parseReleaseTag` is not exported** from `release-notes.ts`, so the script does its
   own shape parse rather than widening that module's surface for one caller. Only
   `compareReleaseTags` is imported.
3. **A `v`-prefix normaliser was required.** The workflow passes
   `github.event.release.tag_name` (`v2.36.0`) while `package.json` holds a bare version,
   so prefixing blindly built `vv2.36.0` and every comparison against it misordered. It
   surfaced as the script rejecting a correct candidate: "candidate 2.37.0 does not rank
   ahead of released v2.36.0". Now pinned by a test.

The tests also caught a defect the plan did not anticipate. The ahead-check originally
compared `dev` against the CANDIDATE, which is the wrong question: a `dev` at
`2.37.0-preview.1` with `2.36.0` published is genuinely ahead of the release but behind
the candidate `2.37.0`, so the script would have "repaired" a healthy tree and
downgraded a legitimate prerelease line. It now compares against the released version,
which is the same question `release-version-line.test.ts` asks.

A security review of the shipped workflow also found one gap worth recording. The
idempotency guard originally checked only whether the bump BRANCH existed. An open bump
pull request whose head branch had been deleted leaves that check passing, so the job
would recreate the branch and then fail on `gh pr create` with "already exists" - turning
a successful release red for a repair that was already queued. It now checks for an open
pull request first, then the branch.

Two residual gaps are accepted rather than fixed, and named so a later reader does not
mistake them for oversights:

- `Bun.write` to `$GITHUB_OUTPUT` truncates rather than appends. That is equivalent to a
  first write today because the step emits nothing else, but it is not append-safe if a
  later edit adds a second output in the same step.
- There is no test that exercises the `$GITHUB_OUTPUT` path itself; the tests cover the
  decision and the file rewrite.

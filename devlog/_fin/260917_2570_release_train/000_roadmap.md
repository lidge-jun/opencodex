# 2.57.0 release train — roadmap

Status: open. Opened 2026-09-17.

## Where the repository actually is

`dev` carries 184 commits since `v2.56.0`, and `package.json` on `dev` already reads 2.57.0 — the
pre-move the 2.56.0 train performed as its own step 2. The version line is therefore ready for a
2.57.0 release, and will need a further move before that release can publish.

Two things are not ready:

1. **`dev` is red at its tip.** Cross-platform CI run `35118018849` at `2b19983bfd` failed on the
   `windows 1/6` shard with a single failing test, and the four dev commits before it
   (`d2808c0619`, `d210c46dab`, `89bdf5fa4a`, `dc9d1fabc8`) each failed a run as well. The last
   recorded success on `dev` is `35091966777` at `2203277ad4`. A release cannot be cut from a tree
   whose tip has no green run, so establishing whether these are flakes or one regression is the
   first work phase, not a side quest.
2. **The queue was never triaged.** 60 pull requests and roughly 60 issues are open. Some issues
   are already fixed by unreleased commits on `dev`, some pull requests are superseded by work
   that landed around them, and a handful are ready to land now. Publishing without that pass
   ships a release whose notes cannot be written honestly and leaves users reading open issues
   that the release already fixed.

## Constraint that shapes the whole unit

No local full suite, typecheck, build or install, anywhere, by anyone — including delegated
agents. Hosted CI at an exact head SHA is the only accepted evidence that a tree passes. Source
reading and hosted logs are the local instruments. Every claim in these documents names either a
CI run at a SHA, a job id, or a file path with line numbers.

## Work phases

| Phase | Doc | Outcome |
| --- | --- | --- |
| wp1 | this file | Roadmap locked. Implementation starts in wp2. |
| wp2 | `010_dev_green.md` | `dev` has a green Cross-platform CI run at its exact tip, with every failure on the way either fixed or proven to be a flake. |
| wp3 | `020_pr_triage.md` | Every open pull request carries a recorded verdict; the ones that land do so with CI green at their exact head. |
| wp4 | `030_issue_triage.md` | Every open issue carries a recorded verdict; issues already fixed by unreleased `dev` commits are closed against the commit that fixed them. |
| wp5 | `040_release.md` | 2.57.0 on `main` and `preview`, published, verified from the workflow's own conclusion. |

## Release order, restated because it is easy to get backwards

`MAINTAINERS.md` lines 84-91 and three gates in `.github/workflows/release.yml` force this order:

1. Freeze a candidate SHA on `dev` that has a green Cross-platform CI run.
2. Move `dev`'s version line **first** — dispatch `dev-version-bump.yml` with the intended version
   and merge the pull request it opens. `release.yml` ends with `assert-ahead <dev version>
   <release version>` and refuses to publish while `dev` still reads the version being released.
   Doing this after publication is what left `dev` and every open pull request carrying a failure
   contributors could not fix from their own diff, ten times.
3. Promote the frozen candidate to `main`, cut from the candidate rather than from the post-bump
   `dev` tip. The promotion's `enforce-target` check fails with "wrong base (main)"; that gate is
   for feature pull requests and every promotion carries the same red mark.
4. Prove the release SHA: Cross-platform CI success for the promotion commit, and Service
   lifecycle success as well, which is always required here because `package.json` always changes.
5. Dispatch `release.yml` with the version, `tag: latest`, `dry-run: false`, and `expected-sha`
   equal to the `main` release commit. The branch must not move between step 4 and here.
6. Promote to `preview` so the prerelease train does not restate a shipped stable.
7. Verify the publish from the workflow's own conclusion. Registry lag is not permission to
   publish again.

## Completion criteria

1. `dev` has a Cross-platform CI success at the exact SHA chosen as the release candidate, and
   every failing run between `2203277ad4` and that candidate is accounted for in
   `010_dev_green.md` as either fixed (naming the fix commit) or a flake (naming the test and why
   it is timing-sensitive).
2. Every open pull request has a verdict of LAND, NEEDS-WORK, HOLD or CLOSE recorded in
   `020_pr_triage.md`, and each LAND that was merged names its head SHA and its green run id.
3. Every open issue has a verdict recorded in `030_issue_triage.md`. Issues closed as already
   fixed name the `dev` commit that fixed them, and the closing comment says the fix ships in
   2.57.0.
4. 2.57.0 reaches `main` and `preview`, each with hosted CI success at its exact promotion head,
   and `release.yml` reports a successful publish dispatched with `expected-sha` equal to the
   `main` release commit.
5. No local full suite, typecheck, build or install was run anywhere in this unit.

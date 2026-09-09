# 060 — Final-head release-readiness gates

The train is not complete when its last pull request merges. It is complete only when one
immutable `dev` SHA has three independent pieces of evidence: a successful push-event
Cross-platform CI run, a successful Service lifecycle run, and a manually dispatched
Cross-platform CI run whose four Windows shards all succeeded. Treating the aggregate
`ci` conclusion as all three facts would certify coverage that did not run.

The distinction is encoded in `.github/workflows/ci.yml:549-569`. The
`platform-windows` job has the job-level guard
`github.event_name == 'workflow_dispatch'`, while the release path consumes a `push`
run. On a push, the aggregate `ci` job at `.github/workflows/ci.yml:801-838` accepts the
Windows job's deliberate `skipped` result, so that run proves Linux, macOS, and the
shared gates, not the four Windows suite shards. Windows therefore has to be dispatched
explicitly once against the train baseline and again against the final head.

The dispatch ref is part of that evidence. At `.github/workflows/ci.yml:52`, both `push`
and `workflow_dispatch` runs enter a concurrency group keyed by `github.ref`, with
`cancel-in-progress: true`. A Windows dispatch must therefore target a dedicated branch
ref, never `dev`: the next merge's `dev` push is otherwise a competing run that cancels
the dispatch and all four shards as collateral damage.

That happened to the original baseline. Run `33286530705` on full SHA
`47b8d164366b9db9e4331b2bb8b542db22766910` was cancelled at 02:02:16Z because #2952
merged at 02:01:56Z and started a competing `dev` push run. All four Windows shards died
with it. Record the `47b8d1643` baseline as unavailable, never as a Windows pass.

Recovery was dispatched from the isolated branch `codex/win-gate-260830`: run
`33287093789` on head `dca16949b`. No `dev` push can enter that branch's concurrency
group. This is the post-#2952 baseline and must retain its own terminal outcome; it is a
different baseline, not a substitute for the cancelled `47b8d1643` measurement. The
final dispatch must likewise use a dedicated branch ref pointing at the frozen final SHA
and expose jobs `windows 1/4` through `windows 4/4`, all completed successfully.

## The release-helper mismatch

`release.yml` already asks the right question. In the step named `Require successful
Cross-platform CI for this commit`, `.github/workflows/release.yml:179-200` invokes
`gh run list` with the branch, exact commit, and `--event push`. The accompanying error
text explains why a pull-request run cannot substitute for the promotion run.

The local release authority is looser. `scripts/release.ts:426-430`, function
`listCiRuns`, filters by workflow and commit but not event; `waitForSuccessfulCi` at
`scripts/release.ts:432-455` can therefore accept the manual Windows run while the push
run is absent or red. `release.yml` then rejects a release the helper declared ready.

## Patch shape

`scripts/release.ts` changes only at the CI lookup seam and its two callers.
`listCiRuns` gains an optional event selector and appends `--event <event>` to the
`gh run list` arguments when supplied. `waitForSuccessfulCi` carries that selector
through without changing its exact-`headSha`, completed-state, failure, or timeout
handling. The Cross-platform CI call at `scripts/release.ts:593-595` passes `push`;
the Service lifecycle call at `scripts/release.ts:597-601` does not.

Service lifecycle remains event-agnostic. `.github/workflows/release.yml:223-239`
requires a successful exact-SHA run when the release delta touches its service surface,
but does not restrict its event. Wp6 records it for the final SHA unconditionally.

`tests/release-helper.test.ts` extends the fake `gh run list` evidence around
`tests/release-helper.test.ts:200-215` and adds this exact case under the existing
`describe("release helper")` block at line 352:

`test("Cross-platform CI wait is restricted to push events", ...)`

The case fixes `headSha` and asserts that the `ci.yml` lookup contains
`--commit <headSha> --event push`, while the `service-lifecycle.yml` lookup contains the
same commit and no `--event`. It fails on `47b8d1643`, where neither lookup is scoped.

No workflow file changes. Their current semantics are the contract this patch aligns
with; wp6 does not put Windows on push, alter the aggregate gate, or broaden permissions.

## Runner routing is evidence, not trust

At `.github/workflows/ci.yml:85-121`, `select-windows-runner` routes `push` and
`workflow_dispatch` to `["self-hosted","Windows","X64","ocx-home"]` only when
`OCX_SELF_HOSTED_WINDOWS` is `1`; otherwise it uses `windows-latest`. This is an
operational switch, not a security boundary: a PR can rewrite workflow-owned outputs,
as the source commentary at lines 57-84 states. Either runner still owes four green shards.

## Final evidence packet

First fetch and freeze the candidate SHA. `git log --oneline origin/dev` supplies the
ordered integration history and makes the last commit explicit. For every planned merge,
`gh pr view <n> --json mergedAt,mergeCommit` must report a non-null `mergedAt`; its
`mergeCommit.oid` must appear in that history. A closed, superseded, or deliberately
unmerged candidate instead receives its terminal disposition in the relevant phase doc.

Then identify the final runs without reading a convenient older success:

```bash
gh run list --branch dev --workflow=ci.yml --event push --commit <final-sha>
gh run list --branch dev --workflow=service-lifecycle.yml --commit <final-sha>
gh run view <push-ci-id> --json event,headSha,status,conclusion,jobs
gh run view <service-id> --json event,headSha,status,conclusion,jobs
```

Cross-platform CI must say `event=push`, match the full SHA, and have a successful run
and aggregate `ci` job. Service lifecycle must match that SHA and have all three jobs
defined from `.github/workflows/service-lifecycle.yml:36` successful.

Dispatch Windows only after the frozen SHA is still `origin/dev`. Create or update a
dedicated branch ref to that exact SHA, let any same-ref push run reach a terminal state,
do not move the branch again, and dispatch against that ref. Never dispatch against
`dev`. Then inspect jobs rather than trusting the top-level row:

```bash
gh workflow run ci.yml --ref <dedicated-windows-branch>
gh run list --branch <dedicated-windows-branch> --workflow=ci.yml --event workflow_dispatch
gh run view <windows-run-id> --json event,headSha,status,conclusion,jobs
```

The final dispatch satisfies wp6 only when its `headSha` equals the final SHA, its ref is
the dedicated Windows branch, and all four `windows N/4` jobs succeed. Run `33286530705`
is already terminal evidence of an unavailable baseline; do not reinterpret cancellation
as a pass. Inspect recovery run `33287093789` independently as the post-#2952 baseline.
If `dev` moves, repeat the final push, service, and isolated-branch Windows evidence;
mixed-head evidence is invalid.

## Focused verification and close-out

The only local command for the patch is:

```bash
bun test tests/release-helper.test.ts
```

The repository-wide local suite is forbidden for this train. Workflow truth comes from
the exact-head GitHub runs above, not from rerunning unrelated local tests.

Once wp1 through wp6 each has a terminal outcome, move the whole
`devlog/_plan/260830_release_readiness_train/` unit to
`devlog/_fin/260830_release_readiness_train/`. Per `AGENTS.md:85-86`, `_fin` records work
already visible in public git history; it must not be used while a merge, disposition, or
gate is still pending. Promotion from `dev` to `preview` or `main`, dispatch of
`release.yml`, and npm publication are explicitly out of scope for this train.

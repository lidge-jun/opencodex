# 050_outcome.md — terminal record

## Result

Landed on `dev` as `6188458ae3f4fd84ef57344b60cf3ceeed80aa6f` through
[#3941](https://github.com/lidge-jun/opencodex/pull/3941) on 2026-09-07.

| Layer | Source | Disposition |
|---|---|---|
| wp1 | [#3900](https://github.com/lidge-jun/opencodex/pull/3900) by @x3M3x | carried, PR closed as superseded |
| wp2 | new here | landed |
| wp3 | [#3896](https://github.com/lidge-jun/opencodex/pull/3896) by @parkjs101 | carried, PR closed as superseded |
| — | [#3893](https://github.com/lidge-jun/opencodex/issues/3893) | closed |

Both `Co-authored-by` trailers are on the landed squash commit. The 13 files in
the reviewed tip hash identical to their landed counterparts, `atomic-write.ts`
on `dev` hashes identical to #3900's pinned version, and `initialize.ts` equals
#3896's pinned file apart from wp2's two intended substitutions.

## What the plan got right

The tip-only CI mechanism worked exactly as designed. `ci.yml` triggers on
`pull_request` with no draft filter, so the first plan's assumption that draft
status suppresses CI was wrong; opening no pull request for the lower layers is
what actually produced one workflow subject. No Cross-platform CI run exists for
either lower branch.

Ordering wp2 between the two carried PRs also paid off as predicted. The cherry-pick
of #3896 produced exactly one conflict — the adjacent hunk where `hardeningFailed = true`
sits directly after the rewritten `openSync` line — and it was resolved once.

## What the plan got wrong, and what caught it

The first roadmap draft failed its independent audit with seven findings. Three
mattered: the false draft-CI claim above, merging on stale-base CI evidence, and
proving delivery by ancestry alone when a squash can silently drop a contributor
hunk. It also misstated the file overlap as wp1/wp3 when #3900 never touches
`initialize.ts`. The revised plan passed re-audit, and the stale-base rule
earned itself back: `dev` moved twice during this delivery, so the tip was
rebased and re-certified rather than merged on its first green run.

## The CI failure that was not ours

The pre-rebase head failed one job, `test 4/4`, in
`prompt probe process lifecycle > the last cancellation drains the exact child`.
Investigation attributed it to that test's final parent-side PID poll expiring at
its 15-second internal deadline: every preceding assertion passed, the replacement
command had already observed the old child gone, and the same test passed on macOS
in the same run. `src/codex/prompt-text-probe.ts` imports `node:fs` only for
`existsSync`/`statSync` and never calls the changed writers. A same-head rerun
passed; the rebased head passed 25/25 on the first attempt.

Worth recording honestly: the investigation could not name the exact mechanism.
The replacement considered the PID absent while the parent still considered it
alive, which PID reuse, runtime liveness behavior, or a real observation defect
could all explain. It is a flake by evidence of non-reproducibility, not by proof.

## Follow-up left open

Three exclusive opens under `src/lab/` share the numeric spelling this track
replaced: `ledger/store.ts` (two) and `public/private-file.ts`. Lab is opt-in and
off the core request path, so they stayed out rather than widening a config-surface
fix. The read/write sites in `artifacts/secure-fs.ts` need individual treatment
because `"wx"` would drop read access; they are not a mechanical substitution.

## Verification boundary

The local product suite, typecheck, and build were **NOT RUN** by owner
instruction. Acceptance rested on repository CI against the tip
([run 34153124187](https://github.com/lidge-jun/opencodex/actions/runs/34153124187):
19 jobs succeeded, 2 skipped, zero failures on the first attempt) plus independent
read-only audits at each layer. The two skips are the dispatch-only `macos control`
and Windows shard lanes, so Windows packaging and keyring smoke passed but the
Windows suite itself did not run.

One limit worth stating plainly: the green PR run tested the tip against the base it
was rebased onto, and #3940 landed on `dev` between that run and the merge. The
C-track content is byte-identical either way, and the four files #3940 touched do not
overlap this change, but the combined tree is certified by the post-merge `dev` run
rather than by the PR run. That run has since completed:
[run 34153892496](https://github.com/lidge-jun/opencodex/actions/runs/34153892496) on
`6188458ae` succeeded, 19 jobs and 2 skips, so the landed combined tree is certified.

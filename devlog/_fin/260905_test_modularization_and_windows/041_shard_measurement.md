# 041 - macOS shard measurement after PR #3501

Method: same extraction as 003 §1 (`gh run view <id> --json jobs`, job
duration = completedAt - startedAt; wall = run updatedAt - createdAt). Sample:
every successful `dev` push run of `ci.yml` since #3501 merged (`4cacdfbb6`),
taken 2026-09-05 with the six move slices landing in the same window.

## Runs

| run | sha | wall | macos 1/2 | macos 2/2 | linux max |
|---|---|---:|---:|---:|---:|
| 33921559086 | 6580694c7 | 8.1 | 7.4 | 7.7 | 5.3 |
| 33910174714 | 6edc56328 | 13.8 | 7.0 | 9.4 | 4.4 |
| 33907943254 | 4cacdfbb6 | 15.8 | 8.4 | 5.6 | 4.4 |

Mean of the shard job itself: 7.6 min per half (was 14.9 unsharded, 003 §1).
Mean wall is skewed by macOS runner queueing: on 33907943254 `macos 1/2` did
not start until 4.3 min after `macos 2/2`, and on 33910174714 `macos 2/2`
waited 3.7 min after Linux finished. The job-duration column is the property
this PR controls; the wall column is GitHub-hosted macOS capacity on a day
this repository ran ~20 CI runs.

On the PR head itself (033904330976, no queueing): wall 9.4 min, shards 9.0 / 5.7.
With a free runner pool the wall converges on the slower half, ~7.6-9 min,
against 15.4 mean before. The 10x-billed macOS minutes per run went from
~14.9 to ~15.2 (two setups instead of one).

Shard balance: 1/2 and 2/2 alternate as the slower half across runs (8.4/5.6,
7.0/9.4, 7.4/7.7), so the round-robin split is roughly even and a
`--timings` rebalance is not needed yet.

Windows shards were not part of this measurement; `platform-windows` stays
`workflow_dispatch`-only and was skipped on every run above.

## Criterion c-4

Met: shard count on macOS 1 -> 2, measured per-job critical path 14.9 -> 7.6
min, wall on an unqueued run 15.4 -> 9.4 min, unsharded whole-pool control
preserved on `workflow_dispatch` (`lane=macos-control`, run 33904336284 green).


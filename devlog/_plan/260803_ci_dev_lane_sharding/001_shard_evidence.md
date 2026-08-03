# Evidence: shard semantics, runner economics, required-check behavior

Collected 2026-08-03. Every external claim below was opened at its primary
source; every local claim was run on this tree at
`dev@f9b9440c551e3d7f3e2041098caa2ee4de57698e` with Bun 1.3.14.

## 1. Baseline timings (measured, not estimated)

`gh run view 30748690567` — PR #880, all jobs `success`:

| job | started | completed | wall |
|---|---|---|---|
| ubuntu | 12:51:19Z | 12:57:08Z | 5m 49s |
| macos | 12:51:19Z | 12:56:42Z | 5m 23s |
| windows | 12:51:19Z | 13:07:42Z | **16m 23s** |
| npm-global ubuntu | 12:51:07Z | 12:51:44Z | 0m 37s |
| npm-global macos | 12:51:06Z | 12:51:36Z | 0m 30s |
| npm-global windows | 12:51:06Z | 12:52:59Z | 1m 53s |
| select windows runner | 12:51:13Z | 12:51:17Z | 0m 4s |

Total run wall clock is set by the Windows test leg: **16m 23s**, against a
Linux critical path of 5m 49s. This run used GitHub-hosted `windows-latest`
(the self-hosted route only applies to `push`/`workflow_dispatch`).

## 2. Bun `--shard` semantics

Primary source: [Bun v1.3.13 release notes](https://bun.com/blog/bun-v1.3.13),
2026-04-20.

> "Test files are sorted by path for determinism and distributed round-robin
> across shards, keeping each shard balanced to within one file of each other.
> The shard index is 1-based (`1 <= index <= count`)."

> "Workers automatically run with `--isolate` between files."

Sharding is file-level, not test-level, and it composes with `--isolate`
without requiring it.

### Verified locally

A 10-file scratch directory under `tests/` (bunfig pins discovery to `./tests`,
so scratch files elsewhere are invisible to the runner — worth knowing before
trusting a shard experiment run outside that root):

```
shard 1/3: f01 f04 f07 f10
shard 2/3: f02 f05 f08
shard 3/3: f03 f06 f09
```

Round-robin over path-sorted files, exactly as documented, disjoint and
complete.

Against the real suite (480 discovered `*.test.ts` files):

```
shard 1/4: 120 files
shard 2/4: 120 files
shard 3/4: 120 files
shard 4/4: 120 files
union: 480 total, 480 unique
find tests -name '*.test.ts' | wc -l => 480
```

No file appears twice; no file is lost. Four shards divide this suite exactly.

### Shard count choice

Four. The suite is 480 files over a ~5m 49s Linux leg, of which install +
typecheck + GUI build are fixed overhead that every shard repeats. Splitting
the *test* step four ways trims the variable part while paying that overhead
four times; beyond four the overhead dominates and the concurrency budget
(20 jobs, Free plan) starts to matter more than the wall clock saved. Four is
also the number that divides 480 evenly, which keeps the shards balanced
exactly rather than to within one file.

## 3. Runner economics

Primary sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
[Actions limits](https://docs.github.com/en/actions/reference/limits),
[hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

> "GitHub Actions usage is free for self-hosted runners and for public
> repositories that use standard GitHub-hosted runners."

This repository is public, so **minutes are not billed** and the 1x/2x/10x
multipliers do not apply as a cost argument. The honest justification for this
unit is latency and concurrency, not money. Stating it the other way round
would be a nicer story and a false one.

The binding limits instead:

> "Standard GitHub-hosted runner | Free | 20 | 5."

20 concurrent jobs, of which at most 5 may be macOS. Current shape spends 6
jobs per push (3 test legs + 3 npm-global legs); with ~20 open pull requests
that budget is the queue.

Runner sizes, which explain the Windows gap only partially — Linux and Windows
are both 2 vCPU / 8 GB, so the 3x difference is filesystem and process-spawn
cost under `--isolate`, not a smaller machine:

| label | vCPU | RAM |
|---|---|---|
| `ubuntu-latest` | 2 | 8 GB |
| `windows-latest` | 2 | 8 GB |
| `macos-latest` | 3 (M1) | 7 GB |

## 4. Required checks and skipped jobs

Primary sources: [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

The two behaviors that decide the design, and they are opposites:

> "If a workflow is skipped due to path filtering, branch filtering, or a
> commit message, then checks associated with that workflow will remain in a
> 'Pending' state. A pull request that requires those checks to be successful
> will be blocked from merging."

> "A job that is skipped will report its status as 'Success'. It will not
> prevent a pull request from merging, even if it is a required check."

Hence: filter **jobs**, never the workflow, for anything a required check
depends on.

For the aggregate gate:

> "If a job fails or is skipped, all jobs that need it are skipped unless the
> jobs use a conditional expression that causes the job to continue."

> "If you would like a job to run even if a job it is dependent on did not
> succeed, use the `always()` conditional expression in `jobs.<job_id>.if`."

So the gate needs `if: always()` or it inherits the very skipping it is
supposed to summarize.

### Current protection state

```
GET /repos/lidge-jun/opencodex/branches/dev/protection
=> 404 "Branch not protected"
```

Nothing is required today, matching `AGENTS.md` ("enforced by convention until
branch protection is configured"). No existing required-check name can break,
which is precisely why introducing the stable gate name now costs nothing.

## 5. Local test-runner interaction

`scripts/test.ts` blocks a run while another `bun test --isolate` process
exists on the same machine, discovered via `pgrep`. That is a developer-box
concern (parallel worktrees fighting over one CPU turned a 210s suite into 13
minutes). CI invokes `bun test --isolate tests` directly and each shard runs on
its own runner, so shards cannot see or serialize against each other.

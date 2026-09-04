# 003 — CI timing baseline (`ci.yml` on `dev`)

Measured 2026-09-05 (KST) against `lidge-jun/opencodex`. Read-only `gh` only. Durations are `completedAt - startedAt` from `gh run view --json jobs` unless a step table cites `gh api .../actions/jobs/<id>`.

Repo HEAD for this plan unit: `9c0e3ca80` (`codex/test-modularization-260905`). The ten successful **push** runs below are on `dev`, not this branch.

## Commands

Last 10 successful push runs of `ci.yml` on `dev`:

```bash
gh run list -R lidge-jun/opencodex --workflow ci.yml --branch dev --status success --limit 10 \
  --json databaseId,headSha,createdAt,event,displayTitle,updatedAt,url
```

Per-run jobs:

```bash
gh run view <databaseId> -R lidge-jun/opencodex --json jobs,status,conclusion,event,headSha,createdAt,updatedAt,displayTitle,url,databaseId
```

Step-level setup (used for jobs `101042019022` macos, `101042019055`/`101042019125`/`101042019133`/`101042019108` Linux shards on run `33878757189`; plus slow macos `100961650058` and slow Linux `100998636129`):

```bash
gh api repos/lidge-jun/opencodex/actions/jobs/<jobId> \
  --jq '{id,name,started_at,completed_at,steps:[.steps[]|{name,started_at,completed_at,conclusion,number}]}'
```

Latest `ci.yml` workflow_dispatch runs (unfiltered `--event workflow_dispatch` mixes in `Release`; this is the intended set):

```bash
gh run list -R lidge-jun/opencodex --workflow ci.yml --event workflow_dispatch --limit 5 \
  --json databaseId,headSha,createdAt,event,displayTitle,conclusion,updatedAt,status,url,headBranch
gh run view 33894541984 -R lidge-jun/opencodex --json status,conclusion,updatedAt,headSha,jobs
```

## 1. Last 10 successful `dev` push runs

All ten are `event=push`, `conclusion=success`, `headBranch=dev`. Wall clock is `updatedAt - createdAt` (includes `changes` + queue). Critical path is the longest **non-skipped** job in that run.

| run | SHA (12) | created UTC | wall min | crit job | crit min |
| --- | --- | --- | ---: | --- | ---: |
| [33878757189](https://github.com/lidge-jun/opencodex/actions/runs/33878757189) | `1e3589531aaa` | 2026-09-04T13:33:46Z | 15.88 | macos | 15.43 |
| [33874074134](https://github.com/lidge-jun/opencodex/actions/runs/33874074134) | `24c0409ae33b` | 2026-09-04T12:41:45Z | 15.82 | macos | 15.43 |
| [33865218696](https://github.com/lidge-jun/opencodex/actions/runs/33865218696) | `df416a439c0d` | 2026-09-04T10:51:42Z | 16.42 | macos | 15.40 |
| [33863743040](https://github.com/lidge-jun/opencodex/actions/runs/33863743040) | `974283269c7f` | 2026-09-04T10:32:45Z | 13.52 | macos | 13.18 |
| [33857559143](https://github.com/lidge-jun/opencodex/actions/runs/33857559143) | `0bf9d080b9bb` | 2026-09-04T09:16:55Z | 15.55 | macos | 14.72 |
| [33853561807](https://github.com/lidge-jun/opencodex/actions/runs/33853561807) | `5ea3f2089abc` | 2026-09-04T08:27:57Z | 18.20 | macos | 17.43 |
| [33836061468](https://github.com/lidge-jun/opencodex/actions/runs/33836061468) | `072df52eb172` | 2026-09-04T04:14:14Z | 14.77 | macos | 14.38 |
| [33827785365](https://github.com/lidge-jun/opencodex/actions/runs/33827785365) | `07414e0f16a9` | 2026-09-04T01:58:51Z | 14.67 | macos | 14.32 |
| [33826200182](https://github.com/lidge-jun/opencodex/actions/runs/33826200182) | `19017e98b18b` | 2026-09-04T01:33:09Z | 15.02 | macos | 14.73 |
| [33824781610](https://github.com/lidge-jun/opencodex/actions/runs/33824781610) | `4dbf6147c2ef` | 2026-09-04T01:11:15Z | 14.02 | macos | 13.63 |

**macos is the critical path on 10/10 runs.** Linux max-shard never exceeded 5.13 min. `npm-global *` reached 7.85 min once and still lost to macos. `platform-windows` is skipped on every push (`if: github.event_name == 'workflow_dispatch'`).

### Per-job minutes (push, successful)

`npm-global *` is gated on `needs.changes.outputs.packaging == 'true'` ([.github/workflows/ci.yml](.github/workflows/ci.yml) `npm-global-smoke`). It ran on 7/10 of these pushes and was skipped on 3 (docs/ci-timeout/test-fixture SHAs). Skipped rows are omitted from that job's mean.

| job | n | mean | median | min | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| test 1/4 | 10 | 2.59 | 2.64 | 2.35 | 2.78 |
| test 2/4 | 10 | 2.90 | 2.84 | 2.78 | 3.22 |
| test 3/4 | 10 | 3.32 | 2.96 | 2.75 | 4.60 |
| test 4/4 | 10 | 4.45 | 4.68 | 2.93 | 5.13 |
| **Linux max shard** | 10 | **4.74** | 4.68 | 4.52 | 5.13 |
| storage policy | 10 | 0.52 | 0.53 | 0.42 | 0.58 |
| api usage | 10 | 0.43 | 0.43 | 0.37 | 0.53 |
| gates | 10 | 1.37 | 1.34 | 1.22 | 1.55 |
| **macos** | 10 | **14.87** | **14.73** | 13.18 | **17.43** |
| keyring ubuntu | 10 | 0.45 | 0.44 | 0.37 | 0.70 |
| keyring macos | 10 | 0.27 | 0.27 | 0.22 | 0.37 |
| keyring windows | 10 | 0.55 | 0.53 | 0.48 | 0.68 |
| npm-global ubuntu-latest | 7 | 4.45 | 4.80 | 0.60 | 7.58 |
| npm-global macos-latest | 7 | 2.97 | 3.13 | 0.72 | 7.85 |
| npm-global windows-latest | 7 | 3.62 | 2.93 | 2.22 | 7.02 |
| ci (aggregate) | 10 | 0.05 | 0.05 | 0.03 | 0.07 |
| run wall (created→updated) | 10 | 15.38 | 15.28 | 13.52 | 18.20 |

Linux four-shard **sum** of job minutes: mean 13.26, range 13.02–13.68. That sum is almost a constant; the slow shard moves around (usually `test 4/4`, twice `test 3/4`).

### Per-run job grid (minutes)

| run | 1/4 | 2/4 | 3/4 | 4/4 | storage | api | gates | macos | kr-u | kr-m | kr-w | npm-u | npm-m | npm-w | ci |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 33878757189 | 2.77 | 2.87 | 4.58 | 2.93 | 0.42 | 0.43 | 1.42 | **15.43** | 0.48 | 0.23 | 0.58 | 0.60 | 0.72 | 2.25 | 0.07 |
| 33874074134 | 2.67 | 2.85 | 4.60 | 3.27 | 0.55 | 0.37 | 1.52 | **15.43** | 0.70 | 0.30 | 0.50 | 0.67 | 0.72 | 2.22 | 0.03 |
| 33865218696 | 2.35 | 2.90 | 2.75 | 5.13 | 0.50 | 0.40 | 1.35 | **15.40** | 0.38 | 0.37 | 0.53 | 7.58 | 0.90 | 7.02 | 0.05 |
| 33863743040 | 2.47 | 2.80 | 3.30 | 4.73 | 0.53 | 0.48 | 1.32 | **13.18** | 0.45 | 0.27 | 0.68 | — | — | — | 0.03 |
| 33857559143 | 2.43 | 3.22 | 2.88 | 4.52 | 0.55 | 0.48 | 1.22 | **14.72** | 0.42 | 0.30 | 0.48 | — | — | — | 0.05 |
| 33853561807 | 2.40 | 3.12 | 2.90 | 5.00 | 0.53 | 0.53 | 1.40 | **17.43** | 0.47 | 0.28 | 0.50 | — | — | — | 0.03 |
| 33836061468 | 2.77 | 2.80 | 2.95 | 4.55 | 0.53 | 0.38 | 1.33 | **14.38** | 0.42 | 0.23 | 0.58 | 3.73 | 3.13 | 2.47 | 0.07 |
| 33827785365 | 2.78 | 2.78 | 2.90 | 4.92 | 0.58 | 0.37 | 1.55 | **14.32** | 0.47 | 0.27 | 0.52 | 7.58 | 4.17 | 3.80 | 0.07 |
| 33826200182 | 2.60 | 2.82 | 2.97 | 4.63 | 0.50 | 0.45 | 1.32 | **14.73** | 0.38 | 0.27 | 0.53 | 4.80 | 3.28 | 4.65 | 0.05 |
| 33824781610 | 2.68 | 2.82 | 3.40 | 4.78 | 0.47 | 0.42 | 1.25 | **13.63** | 0.37 | 0.22 | 0.55 | 6.17 | 7.85 | 2.93 | 0.03 |

`windows N/4` is present on every push as a skipped matrix placeholder (`conclusion=skipped`, duration ~0). It is not in the grid.

## 2. Setup-step measurement (not the 1–1.5 min guess)

The prompt's "assume ~1–1.5 min fixed setup" is **high vs live hosted runners**. Named setup = Checkout + Setup project Bun + Install dependencies + Build GUI.

### Run 33878757189 (latest of the ten; SHA `1e3589531`)

| job | job id | Checkout | Bun | Install | GUI build | **named setup** | Test step | job total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| macos | 101042019022 | 0.12 | 0.07 | 0.02 | 0.25 | **0.46** | 14.77 | 15.43 |
| test 1/4 | 101042019055 | 0.12 | 0.07 | 0.02 | 0.20 | **0.41** | 2.30 | 2.77 |
| test 2/4 | 101042019125 | 0.12 | 0.05 | 0.02 | 0.22 | **0.41** | 2.42 | 2.87 |
| test 3/4 | 101042019133 | 0.10 | 0.03 | 0.03 | 0.18 | **0.34** | 4.17 | 4.58 |
| test 4/4 | 101042019108 | 0.13 | 0.02 | 0.02 | 0.18 | **0.35** | 2.53 | 2.93 |

macOS also pays Set up job 0.02 + CLI help smoke 0.02 + post/complete ~0.12. Job − Test = 0.66 min overhead on this run.

### Cross-check on the slow outliers

| job | run | job id | named setup | Test step | job total |
| --- | ---: | ---: | ---: | ---: | ---: |
| macos (slowest of 10) | 33853561807 | 100961650058 | 0.50 (11s+3s+2s+14s) | 16.77 (08:29:10Z–08:45:56Z) | 17.43 |
| test 4/4 (slowest Linux) | 33865218696 | 100998636129 | 0.40 (8s+3s+1s+12s) | 4.65 (10:53:03Z–10:57:42Z) | 5.13 |

**Use measured setup 0.40 min Linux / 0.46 min macOS as the primary model.** Keep 1.0 and 1.5 min as a sensitivity band only; they would matter at 8 shards, not at 2.

Derived test-work (mean job minus measured setup):

- Linux four shards: mean job-sum 13.26 − 4×0.40 = **11.66 min** of test-work
- macOS: mean job 14.87; Test/job ratio 14.77/15.43 ≈ 0.957 and 16.77/17.43 ≈ 0.962 → Test ≈ **14.27 min**, leftover overhead **0.60 min**

## 3. Critical path and shard estimates

### Who dominates

macos, unsharded, ~15 min. The comment in `ci.yml:450-452` that this leg is "the cheapest leg on the board — 5m23s on the baseline run" is **stale**. Live macos is ~2.8× the old figure and ~3.1× the Linux max-shard (14.87 / 4.74).

Linux 4-way is already off the critical path by ~10 min. Extra Linux shards cannot shorten a push/PR until macos drops below ~4.7 min (or ~7.6 min on a packaging run, where `npm-global ubuntu-latest` has hit 7.58).

### macOS N-way, same per-file cost

Model: `overhead 0.60 + 14.27/N`. Imbalance ignored (macOS currently runs the whole tree in one pool, so there is no live shard-skew sample; Linux skew says max can sit ~1.4× even-split).

| N | est. job min | est. CP if Linux stays 4-way | wall save vs 14.87 | macOS minutes billed | billed vs now (10×) |
| ---: | ---: | --- | ---: | ---: | --- |
| 1 (now) | 14.87 | macos 14.87 | 0 | 14.87 | 149 Linux-eq |
| 2 | 7.74 | macos 7.74 | **7.1** | 15.48 | 155 (+4%) |
| 3 | 5.36 | macos 5.36, or npm-global on packaging spikes | **9.5** | 16.08 | 161 (+8%) |
| 4 | 4.17 | **Linux max 4.74** (or npm-global 4.5–7.6) | **10.1** then stuck on Linux/npm | 16.68 | 167 (+12%) |

Sensitivity if setup were the assumed 1.5 min instead of 0.46: 2-way ≈ 8.6, 3-way ≈ 6.3, 4-way ≈ 5.1. Still macos-dominated at 2-way; 4-way still collides with Linux max 4.74.

### Linux 4→6/8, same per-file cost

Optimistic even-split: `0.40 + 11.66/N`. Conservative (keep today's max-shard skew, scale test-work 4.34 × 4/N): `0.40 + 4.34×4/N`.

| N | even-split job | conservative max job | workflow CP if macos stays unsharded |
| ---: | ---: | ---: | --- |
| 4 (now) | 3.32 even / **4.74 measured max** | 4.74 | **macos 14.87** (no save) |
| 6 | 2.34 | 3.29 | macos 14.87 (no save) |
| 8 | 1.86 | 2.57 | macos 14.87 (no save) |

With 1.0–1.5 min setup: 6-way 2.94–3.44, 8-way 2.46–2.96. Still irrelevant to wall clock while macos is unsharded.

Linux 6/8 only pays off **after** macos is 4-way (CP would then be ~4.7 Linux). Then 6-way conservative 3.29 would make CP ≈ max(macos 4.17, Linux 3.29, npm-global). Packaging npm-global becomes the next bottleneck, not the suite.

## 4. How Linux shards are assigned, and why macos is unsharded

### Linux: sorted round-robin, matching Bun `--shard`

[`.github/workflows/ci.yml:236-261`](.github/workflows/ci.yml):

> `scripts/ci/run-bun-test-batches.sh` mirrors Bun's sorted round-robin shard assignment, then runs each shard in small batches so every batch gets a fresh Bun process.

Matrix is `shard: [1, 2, 3, 4]`, `TEST_SHARD: ${{ matrix.shard }}/4`, invoked as `bash scripts/ci/run-bun-test-batches.sh "$TEST_SHARD"` ([ci.yml:307-310](.github/workflows/ci.yml)).

[`scripts/ci/run-bun-test-batches.sh:196-210`](scripts/ci/run-bun-test-batches.sh) is the assignment:

1. `find tests -type f -print0 | LC_ALL=C sort -z` — byte-sorted, stable.
2. Skip non-general files (`tests/api-storage-policy*.test.ts`, `tests/api-storage.test.ts`, `tests/api-usage.test.ts`) plus anything that is not a Bun test/spec suffix. Those excluded files run in the dedicated `storage policy` / `api usage` jobs so a Linux isolate/epoll wedge cannot take a quarter of the suite with them ([ci.yml:240-244](.github/workflows/ci.yml), [ci.yml:312-353](.github/workflows/ci.yml)).
3. Round-robin: `general_index % SHARD_COUNT == SHARD_INDEX - 1`. Shard `k/N` gets files whose 0-based general index satisfies `index % N == k-1`. That is Bun's `--shard=k/N` rule on a sorted file list.
4. Each shard then batches ≤12 files per fresh Bun process (`BUN_TEST_BATCH_SIZE`, default 12), retries only runtime crash/timeout, never assertion failures.

Gates stay out of the shards on purpose ([ci.yml:246-248](.github/workflows/ci.yml)): typecheck/lint/build/scans are fixed cost; paying them four times would eat the shard savings. Measured gates: 1.22–1.55 min, well off CP.

### macOS: unsharded control (quote)

[`ci.yml:445-452`](.github/workflows/ci.yml):

> macOS runs on every pull request, and runs the WHOLE suite unsharded.
>
> That is the point of it. The four Linux shards each cover a quarter of the files, which quietly assumes no test depends on a sibling file having run in the same process pool. This leg is the control that would notice if that assumption ever broke. It is also the cheapest leg on the board — 5m23s on the baseline run, faster than the ubuntu leg it sits beside — so there was never a latency argument for touching it.

Second copy on the job itself ([ci.yml:461-464](.github/workflows/ci.yml)):

> The unsharded control for the sharded Linux lane: the only place the whole suite runs in one pool, so it is the place that catches what sharding hides.

The control argument still stands. The "5m23s / cheapest" clause does not: this sample's macos mean is 14.87 min and it is the **only** reason push CI is ~15 min.

macOS runs `bun test --isolate --timeout 60000 tests` in one job, with a single retry only on Bun crash signatures aligned with `is_bun_runtime_crash` ([ci.yml:509-547](.github/workflows/ci.yml)). It does not call `run-bun-test-batches.sh`.

### Windows: dispatch-only, must stay that way

[`ci.yml:547-569`](.github/workflows/ci.yml):

> Windows runs only when a maintainer asks for it by hand.
>
> … gating the release on them blocks shipping fixes to the platforms that pass, for a platform that has never shipped green.
>
> The leg stays in the workflow, sharded and dispatchable …

Hard gate ([ci.yml:568-569](.github/workflows/ci.yml)):

```yaml
    if: >-
      github.event_name == 'workflow_dispatch'
```

Do not add `push` or `pull_request` to that `if`. Release already keys off a successful **push** run of this workflow, which is Linux + macOS + gates; Windows re-enters when issue #1059 is actually green. Timeout is 25 min/shard because 15 min cancelled a still-running green shard (run 32340498394 cited in-tree).

## 5. Latest `workflow_dispatch` runs (Windows 1/4..4/4)

Filtered to `--workflow ci.yml`. Observation of run `33894541984`: still **in_progress** at last `gh run view` (jobs snapshot `updatedAt=2026-09-04T16:21:44Z`, with later completed Linux jobs through ~16:24:45Z). SHA `9c0e3ca80d24af299dfe740c6cb046aaed0285d0`, branch `codex/win-dispatch-9c0e3ca80`, URL https://github.com/lidge-jun/opencodex/actions/runs/33894541984

| run | SHA | created UTC | conclusion | win 1/4 | win 2/4 | win 3/4 | win 4/4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 33894541984 | `9c0e3ca80d24` | 2026-09-04T16:20:07Z | *(in_progress)* | in_progress since 16:20:31Z (Test step from 16:21:xx) | in_progress 16:20:32Z | in_progress 16:20:30Z | in_progress 16:20:33Z |
| 33618250161 | `272ff6b115cf` | 2026-09-02T10:12:27Z | **success** | 20.50 success | 21.85 success | 17.17 success | 22.60 success |
| 33612731522 | `f85978251573` | 2026-09-02T09:11:16Z | failure | 18.55 success | 23.07 **failure** | 16.62 **failure** | 23.08 success |
| 33610501053 | `26de9cac0691` | 2026-09-02T08:46:22Z | failure | 18.55 success | 23.08 success | 18.18 success | 21.27 **failure** |
| 33605898170 | `2e2b411ba13f` | 2026-09-02T07:54:04Z | failure | 19.45 **failure** | 22.48 success | 17.40 success | 23.27 **failure** |

Only one of the last five finished green (33618250161). On that green run the Windows critical path was **windows 4/4 at 22.60 min** (macos on the same dispatch was 12.33 min). Across the 16 completed Windows shard jobs in this sample: min 16.62, max 23.27, mean ~20.4. That sits 2 min under the 25 min timeout — extra Windows shards would help *dispatch* wall, not push/PR wall.

Run 33894541984 at snapshot: Linux `test 1/4` 2.60, `test 2/4` 4.20, `test 3/4` 2.32 already done; `test 4/4`, macos, and all four Windows shards still running. Not finished; do not treat it as a duration sample.

## 6. Recommended shard plan

**Keep Linux at 4. Shard macos 2-way. Leave Windows at 4 shards, workflow_dispatch-only.**

| change | expected push/PR wall | save vs 15.4 wall / 14.9 macos | billed cost |
| --- | --- | --- | --- |
| **macos 2-way (recommended)** | **~7.7 min** (still macos) | **~7 min** (~46% of wall) | macOS minutes +0.6/run; at 10× that is +6 Linux-eq min (~+4%). Runner *count* doubles. |
| macos 3-way | ~5.4 min, or npm-global 4.5–7.6 on packaging | ~9–10 min if no npm spike | +1.2 macOS min/run (+8% at 10×); control property weaker |
| macos 4-way | ~4.7 min (Linux max) until Linux also moves | ~10 min, then diminishing | +1.8 macOS min/run; CP leaves macos |
| Linux 4→6 or 8, macos unsharded | still ~15 min | **0 min wall** | +2 or +4 Linux jobs of ~2–3 min each; wasted parallelism |
| Linux 6 after macos 4 | ~4.2 macos or npm-global | extra ~0.5 vs macos-4 alone | only then is Linux 6 worth discussing |

GitHub-hosted macOS minutes bill at **10×** Linux. That multiplier argues *against* naive "more macos shards to spend our way to 4 min," because 4-way only buys ~3 min more wall than 2-way while adding two extra 10× jobs and destroying the unsharded control the comment exists for. 2-way is the knee: half the wall, almost the same billed macos minutes (setup duplication is 0.6 min, not 1.5).

Preserve the unsharded-control invariant without paying 15 min on every PR: keep one periodic unsharded macos (nightly / `workflow_dispatch` / `dev` tip) if 2-way lands on the PR path. Do not re-enable Windows on push/PR; a 22 min 10×-or-Windows-hosted path would become the new CP and re-block release on #1059.

Stale in-tree number to fix when the workflow is touched: `ci.yml:450-452` still claims macos is 5m23s and cheaper than Ubuntu. It is not.

## 7. Sources

- Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (844 lines; Linux matrix `ci.yml:249-261`; macos comment `ci.yml:445-465`; Windows `if` `ci.yml:565-569`)
- Shard helper: [`scripts/ci/run-bun-test-batches.sh`](scripts/ci/run-bun-test-batches.sh) (round-robin `196-210`)
- Sample: 10 successful `dev` push runs of `ci.yml` on 2026-09-04, ids listed in §1
- Dispatch sample: 5 latest `ci.yml` `workflow_dispatch` runs in §5, including in-progress `33894541984` on `9c0e3ca80`


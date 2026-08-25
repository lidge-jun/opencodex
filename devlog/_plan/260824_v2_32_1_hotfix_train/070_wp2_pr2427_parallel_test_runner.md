# 070 — wp2: #2427, parallel test runner (last, or deferred)

Phase: wp2 — runs **last**, immediately before freeze. PR: #2427, head
`eb7b101a9`, author `olddonkey`.

> This phase was originally planned first. The A-phase audit argued it should be
> last and won; see 000 §"Why #2427 moved to the end". The decade number keeps
> its original identity while the dependency order in 000 governs execution.

## What it changes

`scripts/test.ts` — MODIFY. The default child invocation moves from

```
bun test --isolate ./tests/
```

to

```
bun test --isolate --parallel ./tests/
```

with argv handling (`:62-141`) that preserves a caller-supplied `--parallel`,
consumes separated option values for `--timings` / `-c` / `--config` so they are
not mistaken for file filters, and respects the `--` delimiter.
`bunfig.toml:8` documents that file-level parallelism comes from the script.
`tests/test-runner.test.ts:79-163` covers the resolver plus a real subprocess
fixture.

The wiring is genuine — `scripts/test.ts:251-259` spawns through
`resolveBunTestArgs`, not merely a helper.

## Why it is last and conditional

The PR's own body reports **7 failures across 902 files** on its exact head,
and simultaneously has all four readiness boxes ticked including "All CI tests
are green on my local testing." Those two statements cannot both be true. The
branch is also 6 commits behind `dev` (merge-base `35a89903c`).

Beyond the metadata contradiction there is a structural argument: parallel
execution raises shared-state contention, so landing it *before* the runtime
fixes would make every later failure ambiguous between "this PR broke it" and
"the new runner is flaky." A verification instrument gets changed against a
known-good baseline; it does not get used to establish one.

## Required sequence

1. Rebase onto `dev` at the post-wp1 head.
2. Let the readiness checklist reset (the gate does this on push) and have it
   re-ticked truthfully.
3. Run `bun run test` at the exact rebased head. Record exit code and the
   failure list if non-zero.
4. If exit 0 and cross-platform CI is green: merge, then re-run the wp3–wp7
   focused verifiers under the new runner to confirm the instrument change did
   not alter their outcome.
5. If not: **defer**, record the evidence, and freeze on the existing runner.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Branch rebased onto post-wp1 `dev` | `git merge-base` == dev head |
| 2 | PR body no longer self-contradicts | PR body diff |
| 3 | `bun run test` exit 0 at exact head | captured output |
| 4 | Cross-platform CI green at that SHA | `gh pr checks` |
| 5 | Post-merge: wp3–wp7 focused verifiers still green | captured output |
| 6 | Merged **or** deferred with evidence | merge SHA or defer record |

## Scope boundary

IN: `scripts/test.ts`, `bunfig.toml`, `tests/test-runner.test.ts`.
OUT: #2429 (`test:changed`), which is stacked on this PR and belongs to the next
minor.

---

## Outcome (wp2 close, 2026-08-25): DEFERRED

Ran last, exactly as the roadmap audit required, and the deferral is this
document's own rule applied rather than a new judgement: *"If it does not, it is
deferred and the train proceeds on the existing runner. It is a convenience,
never a blocker."*

### The measurement

Five full-suite runs on an idle machine, across two heads. The PR head moved
mid-phase — the author pushed `cdeda10c` bounding the default to
`--parallel=4` while the first runs were in flight, so the first two rows are
stale and are kept only to show the bound's effect.

| head | workers | result | wall |
|------|---------|--------|------|
| `e03b9fca` | 15x | 14601 pass / 0 fail | 47s |
| `e03b9fca` | 15x | 14600 pass / **1 fail** (`codex-shim`) | 47s |
| `cdeda10c` | 4x | 14601 pass / 0 fail | 130s |
| `cdeda10c` | 4x | 14601 pass / 0 fail | 125s |
| `cdeda10c` | 4x | 14600 pass / **1 fail** (`issue-452`) | 123s |

Serial baseline on the same machine: ~560s. The speedup is real and the four-worker
bound measurably reduces the failure rate. Neither fact was the deciding one.

### Why it was deferred

Four **different** tests failed intermittently across those runs —
`cursor-native-exec-shell`, `openai-provider-option-e2e`, `codex-shim`,
`issue-452-empty-503` — and every one passes in isolation (17/17 and 88/88
respectively). An independent reviewer additionally had one run stop emitting
output for ten minutes without a terminal summary.

These are **pre-existing latent order dependencies that parallelism exposes**, not
defects the PR introduces. The reviewer named a concrete mechanism worth chasing:
`scripts/test.ts` supplies one common startup `HOME`, and `homedir()` is fixed at
process start, so the `.claude` sentinel in `openai-provider-option-e2e` can observe
a path shared across workers even after preload rewrites the environment.

The blocking argument is specific to this train's position: wp8's freeze gate **is**
a full-suite run, and every remaining criterion depends on it meaning something. A
runner that fails roughly one run in three for unrelated reasons makes a red result
indistinguishable from noise — the same attribution problem that moved this PR from
first to last, arriving one step later.

### What would land it

Fix or quarantine the order-dependent tests (the shared-`HOME` sentinel first), then
three consecutive green full-suite runs at one head plus Linux and Windows CI. It
belongs early in the next cycle: 2 minutes versus 9 changes how often the suite gets
run at all.

Criterion c-7's #2427 half is met by this recorded deferral. Nothing in the v2.32.1
train depends on it; wp8 freezes on the existing serial runner. Posted to the PR at
https://github.com/lidge-jun/opencodex/pull/2427#issuecomment-5402835810.

**LOOP-PESSIMIST-01.** What died here is my own P-phase recommendation: I reached A
saying MERGE on one green run at what turned out to be a stale head. Two lessons,
both cheap to state and easy to skip: re-read the PR head immediately before
claiming exact-head evidence, because a contributor can push mid-verification; and
one green run of a flaky-capable suite is not evidence of stability — the third run
is what produced the finding.


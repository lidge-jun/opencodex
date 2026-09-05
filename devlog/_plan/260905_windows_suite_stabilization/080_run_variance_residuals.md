# 080 — wp5 (research): two more hosted-runner timing residuals surface on the 5th run

Run 33930757649 (head `fd786be83`, PR #3555): windows 1/4 and 3/4 SUCCESS.
**The change under test passed** — `anthropic-quorum-cache` 7/7 on 2/4. But 2/4
and 4/4 each failed on ONE case that had passed on every one of the four
previous runs of this stack:

| shard | case | wall | what timed out |
|---|---|---|---|
| 2/4 | `codex-write-lock > two real processes contend for one lock > one OS user and one home take ONE lock, case 0` | 10.67 s | `waitFor(holdMarker)` — default 10 s (`codex-write-lock.test.ts:314`) waiting for a spawned holder child to write its marker |
| 4/4 | `codex-composed-acceptance > B-reduced: a held local provider cannot commit after the HTTP route persists OFF` | 57.7 s | a `fx.request(..., SERVER_BUDGET_MS)` (30 s) `AbortSignal.timeout` — `TimeoutError: The operation timed out` |

## Same class, already named

Both are `test-budget-sized-from-local-timing` (corpus, added this unit) with a
twist: neither is a per-test budget. They are **internal waits** whose bound is
shorter than a Windows child boot or a Windows server round-trip under load.

- `waitFor(holdMarker)` has the same shape as the 8-11 s child boot that
  `retained-root-serialization` documented at its `:99` comment. The file's own
  comment at `:430` already knows this ("process boot took >4 s on
  windows-latest in run 33603770447") and raised `holdMs` to 20 s for it — but
  left `waitFor`'s default at 10 s. On this run the holder took longer than
  that to boot.
- The composed-acceptance case already carries one Windows fix in its
  comments (`idleTimeout: 255` because Bun's 10 s default cancelled the held
  request on a loaded shard). This time the client-side `SERVER_BUDGET_MS`
  abort fired first. Its siblings on the same run took 47.9 s and 57.8 s and
  passed, so 30 s for one round-trip is inside the runner's noise band.

## What this run says about the runner

Five dispatches of this stack on `windows-latest`, same job class:

| run | 1/4 | 2/4 | 3/4 | 4/4 |
|---|---|---|---|---|
| 33920624827 | ✓ | K-owner 15 s timeout | ✓ | ✓ |
| 33923803071 | ✓ | K-owner 20 s timeout (next case) | ✓ | ✓ |
| 33926041666 | ✓ | ✓ | ✓ | ✓ |
| 33928082123 | ✓ | quorum-cache ×3 (dev drift) | ✓ | ✓ |
| 33930757649 | ✓ | write-lock `waitFor` 10 s | ✓ | composed-acceptance 30 s abort |

Every red cell is a bound that a slower-than-usual run crossed; no red cell
is an assertion about behaviour. The runner is not getting worse — the
quorum-cache file (fixed here) and the K-owner file (fixed in #3550) are both
green on this run — it is that each run samples a different slow child, and
the suite has more sub-10 s waits than the four we have fixed.

## Honest reading of the acceptance bar

`c-1` asks for 0 fail twice consecutively. Run 3 was the first; run 4 broke on
dev drift (fixed, #3555); run 5 broke on two more waits of the same class.
"Twice consecutively" is not going to be reached by fixing the residual each
run exposes and re-dispatching, because each 25-minute run samples one or two
new ones out of a population we have not enumerated.

The faster path is to enumerate the population once: grep the suite for every
internal wait shorter than the hosted-runner floor and budget them as a
class, the way `retained-root-serialization` was fixed in `050` after
budgeting one case moved the failure. That is the next work-phase.

## Next work-phase (wp5)

1. Inventory: every `waitFor`/`waitForPath`/`AbortSignal.timeout`/
   `Bun.sleep`-poll deadline under `tests/` with a literal below 30 s that
   gates on a spawned child or a real server round-trip. `rg` for the
   patterns, then read each hit for what it waits on.
2. Classify each: intrinsic child/server wait → `SPAWN_BUDGET_MS` /
   `SERVER_BUDGET_MS` / `isolationBudgetMs()`; pure-logic wait → leave alone.
3. One PR (stack 5) with the class change and a comment per site naming the
   run that motivated it, then two consecutive dispatches.

Fixing only `waitFor`'s default and the one `SERVER_BUDGET_MS` call would be
the same mistake `050` recorded: it moves the failure to the next site.

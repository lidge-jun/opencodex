# 009 — Confirmation run 1: 25 failures → 1

First full four-shard run with both fixes applied. Pinned runtime
(`./node_modules/bun/bin/bun.exe`, 1.4.0), serial under `/c/ocxwin/.suite.lock`,
tree verified clean before starting.

| shard | pass | skip | fail | wall | baseline was |
|---|---|---|---|---|---|
| 1/4 | 4462 | 39 | **0** | 974s | 2 |
| 2/4 | 4627 | 16 | **1** | 1044s | 22 (contaminated — `007`) |
| 3/4 | 4305 | 12 | **0** | 1272s | 1 |
| 4/4 | 4413 | 12 | **0** | 978s | 0 |
| total | **17807** | 79 | **1** | 4268s | 25 |

## What the fixes did

- **Shard 1, 2 → 0.** `tests/multi-agent-keep-native-v1.test.ts` no longer reads
  the `cmd.exe` launcher's positional argv. `featureActionOf` parses the two
  shapes `commandInvocation` emits.
- **Shard 3, 1 → 0.** `tests/update-notify.test.ts` skips the unlinked-cwd case
  on Windows, where the state cannot exist.
- **Shard 2, 22 → 1.** Not a fix — `007`. Twenty-one of those were contamination
  from a killed 1.3.14 run. The survivor is a different, real problem: `008`.

## The one that remains

`multi-account auth store > OAuth 30 second wait timeout releases an unstarted
lease and never enters the chain` — EPERM on the `afterEach` directory delete,
last case in its file, 21 siblings green.

It does **not** reproduce alone: 0 failures in 5 consecutive solo runs of that
file on an idle box. So it needs the shard around it, and it cannot be diagnosed
by reading the test. `008` carries the measurement plan; a shard-2 solo re-run is
in flight to establish whether one occurrence is deterministic or a flake.

## Honest status against the unit's acceptance

`000_plan.md` asks for **0 fail, twice consecutively**. This is one run with one
failure, so the bar is not met and this unit is not done. What IS established:

- both planned fixes work, verified on the platform that had the defects;
- no product source changed;
- the three shards that had defects are now green;
- the remaining failure is scoped to one case and one shard.

## Evidence

`/c/ocxwin/logs/fix-{1,2,3,4}.log` on the box (601/632/597/645 KB). The 1.3.14
baseline logs and the corrected 1.4.0 baseline are at `v140-*.log`; retrieved
copies live in `.tmp/win/` (gitignored).

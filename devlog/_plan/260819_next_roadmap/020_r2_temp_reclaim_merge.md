# 020 — R2: merge the response-state temp reclaim stack

Work-phase: wp1. Scope: **the only merges authorized this session.**

## State at plan time

| PR | Head | Base | Checks | mergeStateStatus |
|---|---|---|---|---|
| #2084 sweeper | `816024c95` | `dev` | zero FAILURE | `BLOCKED` (review requirement only) |
| #2089 doctor | `3cb6bb497` | `codex/tmp-reclaim-1-sweeper` | zero FAILURE | `CLEAN` |

Both are hygiene-green (they carry real tests) and 5 commits behind dev.
`#2084`'s `BLOCKED` is the review-requirement ruleset, which admin merge
passes — it is not a failing check.

## Order is forced

`#2089` targets `#2084`'s branch. Merging the child first would land the
doctor command on top of a sweeper that is not on `dev`.

1. Merge `#2084` into `dev`.
2. Retarget `#2089` base from `codex/tmp-reclaim-1-sweeper` to `dev`.
   GitHub rewrites the child's diff on retarget; confirm it shows only the
   doctor changes afterward, not the sweeper's.
3. Merge `#2089`.

After step 1 the parent branch is deletable, but **not before step 2** — deleting
the base of an open PR closes it.

## What the change actually does (read, not summarized from the title)

The defect: `~/.opencodex` accumulates multi-GB of
`responses-state.json.ocx.<pid>.<seq>.tmp`, growing after every reboot.

Root cause is two-part, and the second part is the interesting one:

1. The existing cleanup ran **once per process, at cache load** — before that
   process writes anything. So a crashed-and-restarted proxy swept too early to
   see its predecessor's temp (15-minute grace) and never looked again.
2. The cleanup **skipped any file whose owning PID was still alive**. After a
   reboot the OS reissues PIDs, so an old file is permanently mistaken for a
   live process's. That is why growth tracked reboots.

### Design points that hold up on review

- **The boot floor retires a vacuous probe, it does not claim death.** A temp
  older than the current boot cannot be owned by the PID we would probe, so the
  probe is meaningless and is skipped. The comment is explicit that this does
  not prove the file is dead; the unconditional 15-minute grace remains the
  safety floor.
- **An anomalous boot time disables the floor rather than clamping it.**
  Clamping a future-dated boot to "now" would retire the liveness probe for
  every file past the grace — the worst possible response. Absent floor costs a
  missed reclaim; a wrong floor costs a live file.
- **`ENOENT` on unlink counts as reclaimed, not failed.** Another proxy sharing
  the config dir may have won the race; reporting that as failure would tell an
  operator a file is "in use or locked" when nobody holds it.
- **The sweep covers the resolved directory too.** Atomic writes place the temp
  beside the *resolved* target, so a symlinked config dir strands temps where a
  literal-dir scan never looks.
- **The periodic pass rides the liveness tick, not the TTL tick**, because
  `sweepExpiredOnWrite` puts `sweepExpired` on hot write paths and a directory
  scan does not belong there. It carries a 25 ms wall-clock deadline: an entry
  cap bounds syscalls, not time, and on a network-mounted config dir each
  `lstat` can cost 10-20 ms.
- **The doctor reports `eligible`, never `matched`.** `matched` increments
  before the file-type, age, boot-floor and liveness gates, so reporting it
  would tell an operator that live-PID and young temps are abandoned.
- **Report is the default; reclaim is opt-in** behind
  `--reclaim-response-temps`, and a typo'd `--reclaim*` flag warns instead of
  silently degrading to "nothing to reclaim".
- **Dry run and reclaim share one predicate**, so the report and the subsequent
  removal cannot disagree about which files are reclaimable.

## Exit criteria

- `c-2084`: `gh pr view` state MERGED; merge commit is an ancestor of
  `origin/dev`; post-merge CI inspected on the merge SHA.
- `c-2089`: base reads `dev`; state MERGED; ancestry proof; CI inspected.

# 020 — #5456: keep the batch deadline without GNU timeout

## Acceptance

Without GNU `timeout`, each batch keeps the same `BUN_TEST_BATCH_TIMEOUT_SECONDS` ceiling and
the same exit disposition as `timeout --signal=TERM --kill-after=GRACE SECS`: 124 when the
command ends after TERM, 137 when KILL was needed. A hung batch is killed together with its
child processes. With neither GNU `timeout` nor a way to start a process group, the runner
still exits 69 as before.

## Review items on the pull request

- The fallback runs Bun with no batch deadline. Valid; fixed below.
- `sort -z` is GNU-only. Not reproduced: the macOS system `sort` (2.3-Apple) accepts `-z`
  and sorts NUL-delimited input.
- The test covers only a green run. Valid; a hung-batch case is added.
- `mapfile` is Bash 4 only. Already replaced on `dev`; the merge takes `dev`'s loop.

## Changes

MODIFY `scripts/ci/run-bun-test-batches.sh`

- Replace the hard `command -v timeout` requirement with a probe:
  GNU (`timeout --signal=TERM --kill-after=1s 1s true` succeeds) selects `gnu`;
  otherwise `perl` present selects `portable` with a `::notice::` naming the kept deadline;
  otherwise exit 69 with the old message extended to name the portable option.
- Add `run_with_batch_deadline SECS GRACE cmd...`:
  - start `cmd` through `perl -e 'setpgrp(0, 0) ...; exec { $ARGV[0] } @ARGV'` in the
    background, so the batch leads its own process group as it does under GNU `timeout`;
  - a watchdog subshell with output sent to `/dev/null` (it must not hold the `tee` pipe)
    sleeps SECS, marks the timeout, sends TERM then CONT to the group, waits up to GRACE
    seconds for the group to empty, then sends KILL to whatever is left;
  - the wrapper forwards INT, TERM and HUP to the group, waits for the command, and on a
    timeout waits for the watchdog too; it returns 137 when the command itself needed KILL,
    124 for any other timed-out end, and the command's own status otherwise.
- `run_test_once` calls GNU `timeout` or the wrapper with the same arguments, keeping
  `PARALLEL_ARG` from `dev`.
- The wrapper stays a pipeline element (`wrapper ... 2>&1 | tee`) rather than writing through a
  process substitution: bash waits for every pipeline member, so the log the crash classifier
  reads is complete when `PIPESTATUS[0]` is taken.

MODIFY `tests/ci-workflows/ci-crash-disposition.test.ts`

- A `timeoutTool` option selects the fake `timeout`; the non-GNU fake rejects GNU options
  the way a BSD `timeout` does.
- Two hang modes for the fake `bun`, multi-file batches only so the attribution singletons
  stay clean: `hang` starts a child that ignores TERM, records its pid and blocks while the
  batch process itself still dies on TERM; `hang-ignore-term` makes the batch process itself
  ignore TERM.
- New cases without GNU `timeout`, under a 1 s deadline and 1 s grace: a clean run is green;
  `hang` exits 124 and the TERM-ignoring child is gone afterwards; `hang-ignore-term` exits
  137, the GNU status when KILL was needed.

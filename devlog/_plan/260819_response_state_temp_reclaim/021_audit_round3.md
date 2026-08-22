# Audit round 3 — phase 2 implementation

Reviewer: independent `explorer`, read-only, against `24a901d5c`. Verdict:
**GO-WITH-FIXES (blockers=5)**. Main-agent judgment: **near-pass** — all five folded,
none rebutted.

## Confirmed

- **The dry run shares one predicate.** The `dryRun` branch sits AFTER every gate
  (basename, pid/seq sanity, inspect failure, isFile + grace, boot floor, self-pid,
  liveness), so `eligible` is by construction the exact set that would reach `unlink`.
  The drift risk the plan named is closed.
- **The default path deletes nothing** and needs no running server: the only syscalls are
  `readdir`/`lstat`/`realpath`, and `getConfigDir()` is pure string resolution.
- **The layer stands alone** at its own tip.

## Blocker 1 (accepted) — report and reclaim disagreed in MAGNITUDE

The predicate agreed; the budget did not. The report was bounded by `maxEntries` (4096)
while the reclaim used the default `maxCleanups` (512). On the reported ~816-file backlog
doctor would say "816 reclaimable", then free 512 and print that, leaving 304 with no hint
that another run was needed.

Fixed twice over: the doctor reclaim now passes a matching budget, AND a partial pass
prints how many remain with an instruction to run again. The second half matters because
any budget can still be exceeded.

## Blocker 4 (accepted, the most serious) — the safety property had no test

`formatResponseTempLines` tests feed literal objects to a pure formatter, so none of them
can observe deletion. Nothing covered the call site: **inverting the report/reclaim
ternary would have left the whole suite green.** The flagship property — "doctor does not
delete by default" — was claimed by three accept criteria and demonstrated by none.

Fixed with an end-to-end `describe` that seeds a stale temp in an isolated
`OPENCODEX_HOME`, runs `runDoctor([])`, asserts the file SURVIVES, then runs the flag and
asserts it is gone. That test fails if the default is ever inverted.

## Blocker 5 (accepted) — the CLI told a lie to its own target reader

Both the CLI string and the docs promised locked files "are retried automatically". True
only while a proxy runs and ticks — but this command exists for the operator whose proxy
will NOT start. Reworded to "retried on the next reclaim — automatically while the proxy
runs, otherwise re-run this command", in the CLI and the docs, with a regression test
asserting the phrase "retried automatically" never appears.

## Blockers 2 and 3 (accepted) — discoverability

The flag had no help text, and a typo (`--reclaim-response-temp`) silently degraded into a
report, so an operator would read "nothing to reclaim" as an answer to a question they
never asked. Added to `ocx help`, and any unrecognized `--reclaim*` argument now warns.

## Non-blocking, recorded

- `bytesRemoved` under-counts against `eligibleBytes` when another process wins an ENOENT
  race. Defensible — we did not free those bytes — and left as-is.
- The "none abandoned" line now names that it covers response-state temps specifically,
  since the sibling producers (B9 in `002`) remain unreclaimed by design.
- i18n: only the English page was added, matching the existing convention for
  `windows-memory.md`. Locale readers fall back to English; no contradiction is introduced.

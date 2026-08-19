# Audit round 2 — phase 1 implementation plan

Reviewer: independent `explorer`, read-only, against `6d89332b6`. Verdict:
**GO-WITH-FIXES (blockers=6)**. Main-agent judgment: **near-pass** — all six folded, none
rebutted. The two that would have shipped real damage are 1 and 5.

## The safety argument was wrong, and the fix is the wording

Round 1 justified the boot floor as "a temp predating boot cannot belong to any live
pid." That is false under three environments the reviewer named: a container sharing the
config dir by volume mount (uptime is sandbox uptime), suspend-excluding `os.uptime()`
(a 3-hour lid-close shifts computed boot forward by 3 hours), and a network config dir
where `mtimeMs` comes from the server clock.

What actually keeps this safe is the UNCONDITIONAL 15-minute grace at `state.ts:581`,
which stays ahead of the new gate. The boot floor never bypasses it. So the honest claim
is narrower: **the boot floor retires a liveness probe that has become vacuous, and the
15-minute grace remains the safety floor.** The residual exposure is a writer stalled
>15 minutes mid-write, whose worst case is a lost cache write (and on Windows an
`EACCES` that merely increments `failed`).

60 s of skew is also the wrong order of magnitude for those three cases — they are
hours — so the constant is not what buys the safety, and the doc must stop implying it.

## Blockers (all accepted)

1. **CI flake, `tests/responses-state.test.ts:1522`.** The existing fixture ages files
   exactly 60 minutes and keeps `live` via `isProcessAlive: pid => pid === 5252`. On a
   host booted <60 min ago — the normal state of a CI runner — the boot floor bypasses
   that skip and deletes `live`, so `removed` becomes 2. Fix: inject `bootTime: () => 0`
   in that test (and `:1575` for symmetry). The 010 scope boundary widens to include
   these tests.
2. **`state.ts:524`.** A required `bootTime` on the IO interface fails typecheck until
   the default literal `responseStateTempRecoveryIO` gains it. Name it in the change map.
3. **`state.ts:582`.** Hoist `io.bootTime()` above the loop — as drafted it was one
   `os.uptime()` syscall PER directory entry — and guard it:
   `const bootMs = Math.min(io.bootTime(), io.now())`, skipping the floor when the value
   is not finite. Replace the false comment with the accurate one above.
4. **Accept criterion 4 was vacuous.** `recoverStaleResponseStateTemps` already swallows
   `list` failures at `:561` and iterator failures at `:567`, so a throwing `list` can
   never reach the wrapper's new `catch` — the test would pass with the `catch` deleted.
   Fix: the `try` must enclose `responseStateSweepDirectories()`, whose
   `snapshotPath()`/`getConfigDir()` can genuinely throw, and criterion 4 grounds there.
5. **A unit test would touch the developer's real home.** Once `sweepLiveness` is
   registered, the fake-clock test at `tests/state-store-sweeper.test.ts:132` invokes the
   REAL reclaim, and that describe block sets no `OPENCODEX_HOME` — so
   `bun test tests/state-store-sweeper.test.ts` would `opendir` `~/.opencodex` and could
   unlink real temps as a side effect. Fix: isolate `OPENCODEX_HOME` in that block.
6. **An entry cap does not bound time.** 512 synchronous `lstat`s is 2-5 ms on APFS but
   5-10 s on an SMB/NFS config dir, blocking the event loop and stalling in-flight SSE
   streams. Round 1's answer (a smaller constant) addressed the symptom, not the
   mechanism. Fix: add a wall-clock deadline inside the scan loop
   (`io.now() - startedAt > SCAN_DEADLINE_MS`), keeping the entry cap as a backstop.

## Confirmed non-issues

- Adding a required member to `ResponseStateTempRecoveryIO` does NOT break existing call
  sites: `Options` is `Partial<IO> & {...}` (`:507`). No export needed for phase 1;
  round 1's defect (b) is genuinely phase-2-only.
- The registration-name test (`:100`) and the fake-clock test (`:132`) need no assertion
  changes, because we EXTEND the existing `responses-continuation` entry instead of
  adding a store. That design choice is load-bearing. The 010 Verification section
  claimed otherwise and is corrected.
- Reclaim throughput is fine: ~800 files at 64 cleanups/tick is ~13 minutes.

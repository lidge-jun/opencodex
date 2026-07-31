# Issue #44 — close-out (2026-07-03)

Both the primary and the cancel-path finalization are now fixed.

## Fixes

1. **Primary (already landed, `2481c80`)** — native passthrough always uses the finalizable
   `consumeForInspection` path (guard broadened to `recordTerminalOutcomes`), so successful turns
   stop going missing from `/api/logs`.
2. **Cancel-path finalization (this change)** — `consumeForInspection` gained an `onCancel`
   parameter, fired on both the early-abort branch (already-aborted signal) and the mid-drain abort
   listener, and `onDone` now runs on the early-abort branch too (it previously returned before
   `pump()`'s `finally`). `reportNativeTerminal` no longer downgrades a *detected* terminal to a
   cancel when the client has disconnected — a turn that reached a real terminal logs as
   completed/failed; only a pure cancel (no terminal seen) records `499 client_cancel`.
   `finalizeNativePassthroughLog` is idempotent (`logged` guard), so exactly one entry is recorded.

Net: a native-passthrough turn always records exactly one `/api/logs` entry — completed/failed when
it finished, `499 client_cancel` when the client disconnected first.

## Tests

`tests/consume-for-inspection-cancel.test.ts` (3 cases: already-aborted → onCancel+onDone;
mid-drain abort → onCancel+onDone, onTerminal suppressed; clean close → onTerminal(incomplete), no
cancel). `consumeForInspection` exported for the test. tsc 0; suite 1378 pass / 0 fail.

## Accepted residual (non-blocking, reporter-noted)

`/api/logs` remains memory-only (`requestLog`, max 200) — a crash/restart still drops prior-process
entries. Optional log-to-disk persistence is a separate future item, not part of this bug.

## Status: CLOSED.

# Cycle 5: PID Cleanup Fallback Diagnostics

## Goal

Reduce Windows stop/uninstall confusion when a tracked proxy PID is stale or cannot be killed cleanly, while preserving the existing process-tree kill behavior for real running proxies.

## Scope

- MODIFY `src/service.ts`:
  - Replace the current all-or-nothing `stopTrackedProxyIfRunning()` flow with a small cleanup result helper.
  - If no pid exists, return a no-op result.
  - If the pid is already dead/stale, remove the pid file and report that stale cleanup happened.
  - If kill succeeds, remove the pid file as today.
  - If kill fails, keep the existing warning and make the result explicit so stop/uninstall continues to restore/delete as today.
- MODIFY `tests/service.test.ts`:
  - Extend static lifecycle tests to assert stale pid cleanup is covered.
  - Preserve ordering assertions: stop task -> cleanup tracked pid -> restore/delete.

## Non-goals

- Do not change `killProxy()` signal/taskkill semantics in this cycle.
- Do not remove pid files after a live-process kill failure unless the process is confirmed exited.
- Do not add platform-specific process enumeration beyond the existing `isProcessAlive`/`killProxy` helpers.

## Verification

- `bun test tests/service.test.ts tests/process-control.test.ts`
- `bun x tsc --noEmit`

# 020 — WP2: startup-health chip converges without a click

## Observed failure

User report: the "재부팅 후 Codex 모델 연결이 끊길 수 있습니다" chip only synced when
they clicked something (quota refresh, tab switch). Root cause chain:

1. `src/server/startup-health-cache.ts:130-135` — `getCachedStartupHealth` answers a
   cold/expired read from `conservativeFallback` (or a `diagnosticStale`-marked copy of
   the last value) and refreshes in the background. The real probe spawns
   `bun cli __startup-health`, so the first answer after a restart is a placeholder.
2. `gui/src/pages/dashboard-core-poll.ts:97-113` — `fetchStartupHealth` reads
   `diagnosticStale` only to decide whether the payload is valid, then returns the bare
   status string. The staleness marker is dropped on the floor.
3. `gui/src/pages/use-dashboard-data.ts:181-186` — the chip polls at 30s.

So the placeholder is displayed for up to 30 seconds. Any user action that re-mounted
the dashboard triggered a cold fetch, which is why clicking appeared to be the fix.
`gui/src/pages/Startup.tsx:186-190` already does the right thing (re-ask after 2s while
`diagnosticStale`), so the fix is to give the chip the same behavior.

## MODIFY map

### MODIFY `gui/src/startup-health-ui.ts`

- NEW `interface StartupHealthProbe { status: StartupHealthStatus; stale: boolean }`.
- NEW `STARTUP_HEALTH_STALE_RETRY_MS = 2_000` (matches the Startup page's delay).
- NEW `probeNeedsFastRetry(probe)` — true when `stale && status !== "error"`; a hard
  error is left to the ordinary poll because it will not resolve on its own.

### MODIFY `gui/src/pages/dashboard-core-poll.ts`

`fetchStartupHealth` returns `StartupHealthProbe` instead of `StartupHealthStatus`:
`{ status: mapped, stale: data.diagnosticStale === true }`, and `{ status: "error",
stale: false }` on a non-abort failure.

### MODIFY `gui/src/pages/use-dashboard-data.ts`

- Read `startupHealthPoll.data.status` where the bare string was used (state commit,
  session cache write, generation bump).
- Schedule a single `startupHealthPoll.refresh()` after
  `STARTUP_HEALTH_STALE_RETRY_MS` when `probeNeedsFastRetry` holds; clear the timer on
  unmount and on a fresh snapshot so stale answers cannot stack timers.

## TESTS

`tests/startup-health-ui.test.ts` (extend the existing file)

- `probeNeedsFastRetry({status:"at-risk", stale:true})` → true
- `probeNeedsFastRetry({status:"protected", stale:false})` → false
- `probeNeedsFastRetry({status:"error", stale:true})` → false
- `probeNeedsFastRetry(undefined)` → false

## Verification (C)

```
bun test tests/startup-health-ui.test.ts    # 0 fail
bun run typecheck                           # exit 0
```

Rendered proof: reload `#dashboard` and watch the chip settle within ~2s instead of
holding the placeholder until the 30s tick.

# Windows Service Lifecycle Fix Outcome

## Changes

- Added `src/process-control.ts` with shared process liveness and `killProxy` process-tree termination.
- Updated `src/service.ts` so direct `ocx service stop` stops the service manager, attempts tracked PID kill, then restores native Codex.
- Updated `src/service.ts` so direct `ocx service uninstall` stops the service manager, attempts tracked PID kill, then deletes service assets and restores native Codex.
- Updated `src/cli.ts` top-level uninstall ordering to stop service manager, kill tracked proxy, then remove service assets.
- Added focused regression tests for service stop/uninstall ordering, kill failure non-skip behavior, top-level uninstall ordering, and process-control helpers.

## Verification

- `bun test tests/service.test.ts tests/uninstall.test.ts tests/process-control.test.ts` => 12 pass.
- `bun x tsc --noEmit` => exit 0.
- `bun test tests` => 417 pass.
- Read-only Backend verifier result => DONE.

## Residual note

- The current local environment is macOS, so Windows Task Scheduler runtime behavior is covered by static/order and helper tests rather than a live Windows Task Scheduler smoke.

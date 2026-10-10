# OAuth fixture teardown carry

Original source: #3383 commit 51726d2c7c58146defdd6088aefa2b95a1e58553.
Original contributor: x3M3x <amroeid1999@gmail.com> (Git commit metadata).

## Concrete delta

MODIFY `tests/oauth/oauth-store-multi.test.ts` only: import flushConfigDirHardeningForTests and the async ICACLS test runner; stub synchronous and asynchronous runners consistently in setup. Change teardown to await the tracked hardening work before resetting runners/caches, restoring OPENCODEX_HOME, or removing the fixture. Preserve removeTreeWithRetry and all production semantics. Add a deterministic held-async-runner regression against the actual cleanup routine if the existing fixture seams allow it without a new production test API.

Production path proof: store reads call hardenConfigDir; config/paths tracks asynchronous directory hardening; resetHardenedStateForTests clears caches but does not drain those jobs. Deletion retries alone do not ensure ordering. The prior carry #3258 only replaced the removal function.

## Acceptance

No real asynchronous ICACLS escapes the fixture runner. Cleanup waits while a controlled ACL flight is unresolved and only deletes/restores environment after completion. The same OAuth test file passes in final Linux/macOS/Windows CI. Local tests/typecheck are NOT RUN by owner instruction. No numeric-open-flags change is included without current Bun reproduction. No new API/auth policy, credentials, or production runtime change.

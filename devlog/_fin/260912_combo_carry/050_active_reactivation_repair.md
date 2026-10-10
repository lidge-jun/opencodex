# Deterministic Combo reactivation expiry verification

Hosted run 34674763850, job 103503977506 failed the active reactivation case because Save remained disabled. The test did not explicitly execute the activation effect's zero-delay callback.

The fixture now captures cancellable immediate timers only during active and commit-boundary scenarios, commits inactive/active state synchronously to preserve the cached quota snapshot, requires one new callback and executes it inside act. The old expiry timer must be cancelled. Dirty alias preservation, initial disabled state, final enabled state, timer/visibility scenarios and cleanup assertions remain. Subsequent fetches stay unresolved so a new server response cannot satisfy the assertion.

Independent source review found no blocker and traced the callback to the active-dependent effect in Combos.tsx. This covers reactivation while the resource cache survives; it does not claim coverage after cache eviction.

Local tests, build, typecheck and installation: NOT RUN by maintainer instruction. git diff --check passes. Hosted CI at the published final head remains required before merge.

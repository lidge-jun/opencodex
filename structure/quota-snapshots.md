# Account Quota Snapshots

`src/codex/quota.ts` and `src/providers/account-quota-disk.ts` persist last-known account
quotas for restart recovery. The Codex snapshot also carries bounded observation history
and separately identity-bound main-policy evidence; provider snapshots include Kiro's
identity-bound exhaustion verdicts. Their existing hydration and expiry rules govern readers.

## Bounded write deferral

Both writers coalesce updates with a 250 ms idle debounce and a one-second maximum
deferral from the first pending update, measured on the monotonic clock. Continued
observations cannot postpone the scheduled write beyond that deadline; event-loop delays
and disk failures remain best-effort. This uses the same maximum deferral as the quota
reset ledger in `src/quota/reset-seen-store.ts` without making producer calls write synchronously.

The timer snapshots the latest accepted state and resolves the configured home when it
runs. Completion, failure, and cancellation reset the deadline. Clearing all Codex quotas
cancels its pending snapshot; clearing one account persists the remaining rows with the
existing deadline. Provider cancellation discards the pending row and verdict callbacks.
Atomic replacement and account identity checks stay with the existing writer and producer.

`tests/codex-integration/codex-quota-persistence.test.ts` and
`tests/providers/provider-account-quota-persistence.test.ts` check real disk contents under
controlled timers: idle debounce, consecutive sustained-update windows, cancellation and
home reset, removed rows, latest provider callbacks, and recovery after a failed write.

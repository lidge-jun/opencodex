# Account Quota Snapshots

`src/codex/quota.ts` and `src/providers/account-quota-disk.ts` persist last-known account
quotas for restart recovery. The Codex snapshot also carries bounded observation history
and separately identity-bound main-policy evidence; provider snapshots include Kiro's
identity-bound exhaustion verdicts. Their existing hydration and expiry rules govern readers.
Meta Muse rows carry a private account and credential incarnation digest and a provider-configuration fingerprint. Hydration requires the same enabled OAuth provider, adapter and destination as the observation; missing or mismatched bindings are unknown. A cold routing lookup validates them against the home-scoped adopted config without network access, independently of active selection. Selection revisions fence in-flight publication, not retained observations or reset baselines. Managed credential replacement changes the incarnation even if the old credential is later restored. The digests are excluded from quota responses.

The state-store sweeper exposes a home-scoped live-config reader registered by the composition root; quota hydration cannot import the registration module without crossing the Lab boundary. Without an adopted config, a persisted Muse row stays unavailable to unscoped account readers until reconciliation proves the binding; a standalone reader can use it only when its supplied configuration matches. Ranking, account management and quota-pool projection pass their caller's config, and the fallback rechecks ownership at delayed publication. A ranking call checks each account's ownership once and reuses that observation only within the synchronous decision; the next decision rereads the store. Both key probes and in-band observations verify the adopted provider or, when none exists, hydrate first and replace an existing row only for its same account and provider configuration. A configless historical row is discarded rather than adopted under a new provider.

Muse key-mint quota probes serialize by account: a caller with a replacement credential cannot join the old owner's result or start a parallel mint. A later attempt remains subject to the account's success spacing and failure backoff.

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

# Account Quota Snapshots

`src/codex/quota.ts` and `src/providers/account-quota-disk.ts` persist last-known account
quotas for restart recovery. The Codex snapshot also carries bounded observation history
and separately identity-bound main-policy evidence; provider snapshots include Kiro's
identity-bound exhaustion verdicts. Their existing hydration and expiry rules govern readers.
Accepted Anthropic usage probes schedule a snapshot even when they only retire the monthly fallback.
The v1 snapshot stores Anthropic credential ownership in `anthropicCredentialKeys`, alongside
`rows`. Older readers can still project those quota rows into account responses.
Hydration of an older Anthropic row with both plan and monthly meters drops the monthly fallback even if the plan meters have expired.
When Business or Enterprise WHAM reports a group-based individual spending limit without
ordinary rate-limit windows, a finite usage percentage from 0 to 100 supplies the monthly
primary tuple. A reached control supplies 100% only when its percentage is absent or null.
A present invalid percentage leaves the display tuple unset so a merge can carry the prior
reading forward, and rejects the response as trusted policy and history evidence.
The [spendable credit snapshot](providers/openai-tiers.md#spendable-codex-credits)
and the [account DTO](providers/openai-accounts.md#display-only-codex-credits) use the same
WHAM credit normalization for these limits.
Meta Muse rows carry a private account and credential incarnation digest and hydrate for any matching usable account, independently of the active selection; a cold routing lookup hydrates them passively, and legacy unbound rows are ignored. Selection revisions fence in-flight publication, not retained observations or reset baselines. Managed credential replacement changes the incarnation even if the old credential is later restored. The digest is excluded from quota responses.

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

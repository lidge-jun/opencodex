# Pool credit renewal

`src/codex/auth-api/pool-mode-gate.ts` renews independently aged pool credit evidence on the
existing `codex-cooldown-recovery` after-tick hook, using `primeCodexPoolQuotas` with reason
`credit-renewal`. No extra timer or inference request is added.

Only configured pool accounts opted into `creditCodexAccountIds` with a currently exhausted
included window qualify. In Direct mode, a stored account must also be a current target of
`codexAccountNamespaces`; duplicate aliases still produce one account read. Unqualified Direct
requests do not enable general pool priming. Startup, pre-route and priority-failback reasons
remain Pool-only. Paused, reauthentication-required, below-limit and non-opted-in accounts
are skipped. A credit observation younger than three minutes is retained; due or missing evidence
uses the existing bounded-concurrency quota reader with cache bypass, because traffic headers can
keep aggregate usage fresh while the independent credit clock expires.

The existing per-credential attempt map bounds retries to at least three minutes. Query backoff,
request admission and generation/configuration publication fences remain owned by the quota reader.
Only actual WHAM evidence advances the credit clock. A failed read leaves stale evidence unusable;
no credit freshness limit or spending consent is relaxed. Negative evidence remains discoverable.
The eligibility check runs again before each queued account read and after asynchronous token
preparation, immediately before WHAM (including a 401 refresh/replay). It checks the current provider,
enabled state, Direct namespace binding, consent, pause/reauth, account membership and renewal age.
The prepared credential generation must still be live; a current rotated generation is accepted.
A skipped first dispatch earns no attempt marker or query backoff. Ordinary metadata readers keep
their own authority and do not join a renewal flight whose dispatch can still be revoked.
This stored-account renewal reason does not
claim, reconcile or read native main; its separate renewal owner is unchanged. In-flight metadata
remains owned by the dispatched credential even if its namespace is rebound. Revoking spending
consent still blocks auth admission after an already dispatched metadata read completes.

All prime reasons share one in-flight pass. A renewal joining an older startup pass can leave due
credits untouched until the next sweep; it does not start a competing pass. Failures retain the
existing query backoff, and this contract does not promise uninterrupted credit availability.

Regression coverage: `tests/codex-integration/codex-quota-prime.test.ts` exercises pre-expiry and
expired evidence, admission after a fresh read, the sweep entry, no native-main work, exclusions
and failed-read backoff. Tests use fake metadata and private homes, not paid inference.
`tests/codex-integration/codex-direct-credit-renewal.test.ts` adds schema-valid Direct bindings,
the registered sweep callback, real auth admission, coalescing, next-sweep recovery, queued policy
revocation and credential-replacement fencing. `tests/responses/direct-credit-renewal-ingress.test.ts`
checks fresh success, expired local refusal, metadata renewal and terminal success on the same
stored account through the Responses ingress, with fake upstream HTTP only.
`tests/codex-integration/codex-direct-renewal-revocation.test.ts` suspends token preparation to
verify policy revocation, credential deletion/replacement, current-generation acceptance, replay
revocation and ordinary metadata isolation through the real primer and quota reader.

> Decision record: [ADR-7377](../decisions/ADR-7377-pool-credit-renewal.md)

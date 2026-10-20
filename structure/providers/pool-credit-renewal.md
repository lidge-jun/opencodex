# Pool credit renewal

`src/codex/auth-api/pool-mode-gate.ts` renews independently aged pool credit evidence on the
existing `codex-cooldown-recovery` after-tick hook, using `primeCodexPoolQuotas` with reason
`credit-renewal`. No extra timer or inference request is added.

Only configured pool accounts opted into `creditCodexAccountIds` with a currently exhausted
included window qualify. Paused, reauthentication-required, below-limit and non-opted-in accounts
are skipped. A credit observation younger than three minutes is retained; due or missing evidence
uses the existing bounded-concurrency quota reader with cache bypass, because traffic headers can
keep aggregate usage fresh while the independent credit clock expires.

The existing per-credential attempt map bounds retries to at least three minutes. Query backoff,
request admission and generation/configuration publication fences remain owned by the quota reader.
Only actual WHAM evidence advances the credit clock. A failed read leaves stale evidence unusable;
no credit freshness limit or spending consent is relaxed. Negative evidence remains discoverable.
The eligibility check runs again before each queued account read. The pool-only reason does not
claim, reconcile or read native main; its separate renewal owner is unchanged.

Regression coverage: `tests/codex-integration/codex-quota-prime.test.ts` exercises pre-expiry and
expired evidence, admission after a fresh read, the sweep entry, no native-main work, exclusions
and failed-read backoff. Tests use fake metadata and private homes, not paid inference.

> Decision record: [ADR-7377](../decisions/ADR-7377-pool-credit-renewal.md)

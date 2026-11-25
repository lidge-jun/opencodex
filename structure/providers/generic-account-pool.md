# Generic OAuth Account Pool

Muse's in-band quota evidence follows the serving credential and its per-account incarnation independently of the operator's selection; selection still fences an in-flight publication. The physical-send and reset contracts are described in [Providers and adapters](../providers-and-adapters.md).

## Conversation affinity

`src/oauth/generic-session-affinity.ts` owns opt-in generic-pool conversation bindings. Provider-local
`oauthAccountFailover.sessionAffinity: "conversation"` requires proactive enablement; it does not
change reactive failover activation. Bindings are scoped to configuration home, provider and caller
principal, store only a hashed session key, account ID and selection receipt, and expire after 24 idle
hours within a process-wide 2,000-entry bound. Pause, reauth, model/family ineligibility and persisted
selection-revision changes release them. Cross-process revisions are checked on every lookup.
For `google-antigravity` a binding is kept per quota family (`gem`, `cla`) with the family-less key
as a read fallback, so a conversation alternating Gemini and Claude keeps one account per family. Each bind therefore writes two entries per session (the family key and the family-less key), and both count toward the 2,000-entry cap.
`src/oauth/session-affinity-key.ts` supplies the existing client-thread/header/cache-key precedence
for both generic and Anthropic callers; shared Desktop cache cohorts do not establish identity.

`src/oauth/pool-settings-capability.ts` restricts [reset-near-weighted](reset-near-weighted.md) to Codex and built-in
Anthropic pool settings. Generic pool writes using that value return HTTP 400.

`src/server/responses/request-transport.ts` admits every automatic generic affinity-mode choice
without persisting an active-account change, including new/unkeyed sessions and failovers. The
operator's saved selection/revision fences queued sends independently of each conversation's serving
snapshot and credential generation. An unchanged selection with a renewed credential re-resolves
that same account; a changed selection follows the operator. Off-active 401 refresh remains bound
to the sent account. Admitted replacements rebind; affinity hits do not advance round-robin.
Fill-first has a bounded process-local cursor and prefers below-threshold alternatives without
moving the persisted selection. Kiro capacity retains wait/refusal semantics. Codex and Anthropic
are excluded. `tests/oauth/generic-session-affinity.test.ts` and
`tests/server/server-generic-oauth-affinity.test.ts` exercise these boundaries with synthetic accounts.

`src/types/provider.ts` declares the optional `sessionAffinity` mode; omission keeps existing behavior.

## Combo sibling probes

Antigravity sibling discovery passes its root/cache authority through `src/oauth/index.ts` to
generic refresh dispatch. After the account lock is acquired and newer credentials are adopted,
stale discovery stops before the token request without marking the account for reauthentication.
A rotation already dispatched still persists its result under the existing credential CAS.
An independent consumer sharing a discovery-cancelled flight releases its waiter permit before
one new resolution attempt. Callers carrying discovery authority keep the cancellation; unknown
stale outcomes, including post-dispatch uncertainty, never receive this automatic retry.

Antigravity model routing in `src/oauth/generic-account-failover.ts` ranks siblings by configured strategy or family headroom only within the best readiness/model-support tier. A known omission stays excluded, and unknown support stays usable. Reactive model-404 rotation excludes accounts already attempted in the request and prefers positive support before unknown support without changing account-wide auth or cooldown state.

Antigravity round-robin runs one ring per quota family: `genericPoolKey(provider, family)` in `src/oauth/pool-kernel.ts` keys the ring, and `preferredInitialAccount`, `noteGenericPoolSelection`, the model-listing reroute and reactive rotation all read the same model- and exhaustion-filtered candidate list, so the committed pick matches the peeked one and a Gemini request never advances the Claude ring. After the model-listing filter, `preferKiroModelSupport` drops accounts whose family quota is known to be spent unless every listing account is spent; unknown quota counts as headroom. A manual selection seeds the provider ring and both family rings through `seedGenericPoolSelection`, and `reconcilePoolRotationState` treats `generic:<provider>:<family>` keys as part of their provider. `tests/adapters/google/antigravity-account-roster.test.ts` covers the rings, the per-family affinity and the exhaustion filter.

`src/server/responses/core-combo.ts` asks `src/oauth/generic-account-failover.ts` whether a refused
account has an eligible sibling before cooling the whole target. This probe records the refused
account's cooldown but passes `commit: false`, so it only peeks at a round-robin pool. An unsent
sibling does not consume a sticky turn. Dispatching callers retain the default committed pick.
`tests/oauth/generic-oauth-combo-account-cooldown.test.ts` covers this distinction.

## Account diagnostics

`GET /api/oauth/accounts/diagnostics?provider=<id>` (`src/server/management/account-diagnostics-routes.ts`, loaded on demand by `src/server/management-api.ts`) explains why each account of one OAuth login can or cannot serve now. It runs inside `runPassiveReadSync`, so the credential-store read neither hardens, publishes nor backs up anything. Each row carries the account id, `active`, `paused`, `needsReauth`, `eligible`, `eligibleModels`, `lastRefresh`, `cooldownUntil`, `inFlight` and, for Kiro with `maxConcurrentPerAccount`, `atCapacity`; never an email, label, organization or credential field.

Eligibility reuses the selection readers, once per quota family a known model has: Anthropic instances ask their routing (`getEligibleAnthropicAccounts`, grouped by `anthropicModelFamily`), generic pools ask `eligibleFailoverAccounts` with the model's quota family, and Antigravity additionally drops a model its account roster is known to omit (`antigravityAccountModelSupport` reads the credential generation at most once per account, and not at all without roster or denial evidence). A Kiro account holding as many leases as `maxConcurrentPerAccount` is not eligible. Other OAuth providers count an account eligible when it is neither paused nor flagged for reauthentication. The model list is the discovered catalog, else the configured `models`; with neither, `eligibleModels` is `null`. With a known list, `eligible` means at least one model is eligible. `cooldownUntil` is the account-wide hold (`genericAccountCooldownUntil` or the Anthropic health snapshot); family-scoped holds show up as models missing from `eligibleModels`.

`lastRefresh` comes from `src/oauth/refresh-outcomes.ts`. The generic, xAI and Anthropic refresh paths in `src/oauth/index.ts` wrap their upstream refresh call in `observeOAuthRefresh`, which records the time and outcome per config home, login slot, account and login incarnation (the `loginId`, else `addedAt` for legacy rows, taken from the same account row the dispatched credential was read from, with the config home fixed at that moment), keeping at most 1024 entries. A login that replaces the account before, during or after the refresh therefore never inherits the old credential's result. A failure is reduced to a fixed reason (`rejected`, `upstream_error`, `network`, `timeout`, `aborted`, `error`) plus an HTTP status read from `status`, `statusCode` or `httpStatus`; no error text is kept. The record is process-local, so a restart reports `null`. `tests/server/account-diagnostics-routes.test.ts` covers the row fields, cooldown and family exclusion, the Antigravity roster and Kiro capacity cases, refresh recording through `refreshGenericAccountWithLock`, the scoping and bound, the passive read, and the absence of credential fields.

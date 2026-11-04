# Codex Request-Owned Affinity

A Codex request that carries the caller's own forwardable ChatGPT bearer in Pool mode is
request-owned (`codexRouteCredentialOwnership` in `src/server/responses/core-auth.ts`). Since #5019 that
bearer makes main an ordinary Pool candidate next to the stored accounts, while a stored-account pick is
served from that account's stored credential. This document owns how such a request may keep one account
per conversation, and how every affinity decision reports whether a binding was actually stored (#8080).

## Ownership invariant

By default a request-owned bearer owns no Pool affinity, lineage, persistence, entitlement cache, health
state or shared-active state: `codexRequestAffinityKey` in `src/codex/auth-context.ts` returns no key, so
every turn is placed by the strategy again.

With `codexPool.requestOwnedAffinity: true` the request may own a process-local binding from the pair
(exact Authorization value, conversation key) to the account that served it. The key is
`request-owned:v1:` followed by an HMAC-SHA256 under a process-random secret
(`src/codex/request-owned-affinity.ts`), so:

- two requests share a binding only when they present the byte-identical Authorization value and the same
  conversation key; a stored-credential request's raw `app:` key cannot collide with it;
- a binding to `__main__` is always served from the presenting request's own bearer, so no caller is ever
  served with another caller's credential; a binding to a stored account names an account ordinary
  selection could already give this caller, and every reuse re-checks eligibility;
- a ChatGPT account-id claim is never the principal: it is header-suppliable and shared by workspace
  members, so a rotated bearer simply starts a new binding;
- a restart makes every key unreproducible.

Fixed account selectors and Reserve get no key in final auth or in either preview. Request-owned traffic
never records lineage; key derivation may read only the caller's own lineage scope, which that traffic
never writes, so session-less multi-generation subagent chains key per thread.

The manual-pin exception for a request-owned bearer (`requestOwnedMainPinState`, #3166, #4850) lives in
`src/codex/request-owned-main-pin.ts`, read-free by construction and shared by final auth and both previews.

## Labels

`honestAffinityDecision` runs synchronously when selection returns. A `new_bind` or `rebound` decision
stays only when the ordinary or model-detour entry for the key names the selected account; otherwise
`new_bind` becomes `unbound` and `rebound` becomes `cleared`. The `unbound` reason is `request_owned` when
the key was withheld for a request-owned bearer, `no_conversation` when no key exists for another reason,
and the original reason when a key existed but nothing was stored. The label describes selection time, not
dispatch. `requestSpendRecord` does not count `unbound` as a move reason. A caller-main refusal
releases only the exact ordinary and model-detour entries captured at selection, so a delayed outcome
cannot delete a later binding. The snapshot is opaque and process-local; only an actual release records
a pending reason.

## Caller-owned main and carried state

Request-owned Pool contexts and caller-owned main contexts carry a process-local `conversationStateKey`
separate from the optional routing `affinityKey`. The issuer key is derived even when affinity is off
and on the manual-pin path; it is never passed to the routing selector. For conversation-state issuer
purposes a main context with either key is `__main__` (`conversationStateAccountId`). Pool to main and
main to Pool moves, including regular retry and compact alternate paths, scrub `previous_response_id`
when the issuer differs. This also applies with affinity off: those requests now record a bearer-scoped
issuer instead of leaving main untracked or using the stored-credential raw conversation key. Fixed
account selectors and Reserve do not receive a request-owned issuer key. Manual account selection
clears routing bindings while retaining issuer records, so the selected account can detect carried
state from the previous account: `clearThreadAccountMap({ preserveConversationStateIssuers: true })`
in `src/codex/routing/active-account.ts` retains issuers; a full reset clears both. Fixed-account and
other stored-credential traffic keeps the shared stored-credential issuer namespace; its `app:` key
is not caller-scoped by design and is unchanged by this feature.

## Persistence contract

Persistence of thread affinity must, for every key where `isRequestOwnedAffinityKey` is true: never register
an anchor for it, never serialize its thread rows (any scope, including model detours) or issuer rows, and
never adopt a restored row into it. The conversation-state key carries the same prefix, so the predicate
covers issuer records too. The durable store enforces this in `src/codex/routing/thread-affinity-store.ts`
([Durable Codex Pool Affinity](codex-pool-affinity.md)); `tests/codex-integration/codex-affinity-request-owned.test.ts`
proves it across a flush and restart.

## Tests

`tests/codex-integration/codex-request-owned-affinity.test.ts`, `tests/codex-integration/reserve-auth-context.test.ts`,
`tests/responses/compact-transient-alternate.test.ts`, `tests/responses/responses-alternate-main-cancellation.test.ts`.

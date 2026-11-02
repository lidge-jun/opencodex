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
dispatch. `requestSpendRecord` does not count `unbound` as a move reason.

## Caller-owned main and carried state

Every caller-owned main context returned after key derivation carries the key and its decision. For
conversation-state issuer purposes such a context is `__main__` (`conversationStateAccountId`), so Pool to
main and main to Pool moves, including the regular retry and compact alternate paths, scrub
`previous_response_id` like any other account change. Without the opt-in, main records no issuer, as before.

## Persistence contract

Persistence of thread affinity must, for every key where `isRequestOwnedAffinityKey` is true: never register
an anchor for it, never serialize its thread rows (any scope, including model detours) or issuer rows, and
never adopt a restored row into it. Whichever of the persistence change and this change lands second adds a
combined flush-and-restart regression.

## Tests

`tests/codex-integration/codex-request-owned-affinity.test.ts`, `tests/codex-integration/reserve-auth-context.test.ts`,
`tests/responses/compact-transient-alternate.test.ts`, `tests/responses/responses-alternate-main-cancellation.test.ts`.

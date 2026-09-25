# 012 — wp2: request-owned main stays out of shared active state

## Problem

Unreleased on `dev` since #5024: a request that carries its own main credential makes the
stored `main` account an ordinary pool candidate for that request
(`CodexAccountUsabilityOptions.requestOwnedMainCredential`). #5654 stopped three writes in
`resolveCodexAccountForThreadDetailed` from recording such a pick as the shared active account,
through a local `sharesActiveSelection` closure in `src/codex/routing.ts`. The same resolve still
reaches other writers of shared active state with the request's `selectionOptions`:

| Site | Writer | Path |
|---|---|---|
| `src/codex/routing/selection.ts` `pickUnboundStrategyAccount`, round-robin and fill-first/reset-first branches | `rememberActiveCodexAccount` | new unbound session under a non-quota strategy |
| `src/codex/routing/selection.ts` `applyQuotaAutoSwitch` | shared active write inside the helper (persisted) | default `quota` strategy crossing the switch threshold |
| `src/codex/routing/selection.ts` `applyFailureFailover` | shared active write inside the helper | failover streak on the active account |
| `src/codex/routing.ts` priority preemption | `rememberActiveCodexAccount(preempted)` | a higher tier becomes selectable |
| `src/codex/routing.ts` bound-thread quota re-evaluation | `promoteActiveCodexAccount(cooler)` | bound thread moves to a cooler account |
| `src/codex/routing.ts` expired transient hold | `promoteActiveCodexAccount(expiredDetour)` | bound thread adopts its detour |

When any of them picks `main` for a request that owns the main credential, later requests that
do not carry that credential read `main` as the effective (or persisted) active account.
No credential moves between callers: only the account id is recorded.

## Change

One rule, one helper, applied at every shared-state write reachable from a request-owned
selection.

`src/codex/routing/selection.ts` exports:

```ts
/**
 * A main that is live only through this request's own credential serves this request alone.
 * Recording it as the shared active account would route later requests through a credential
 * they do not carry (see CodexAccountUsabilityOptions.requestOwnedMainCredential).
 */
export function sharesActiveSelection(
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  return !(accountId === MAIN_CODEX_ACCOUNT_ID && selectionOptions?.requestOwnedMainCredential === true);
}
```

and guards with it:

- `pickUnboundStrategyAccount`: both `if (commitSharedActive)` blocks become
  `if (commitSharedActive && sharesActiveSelection(picked, selectionOptions))`.
- `applyQuotaAutoSwitch` and `applyFailureFailover`: every write of shared active state is
  skipped when `sharesActiveSelection(target, selectionOptions)` is false. The returned account
  is unchanged, so the request is still served by its own credential.

`src/codex/routing.ts` (1618 lines against a 1626 cap; the change must not grow it past the cap):

- Delete the local `sharesActiveSelection` closure and its comment; import the helper from
  `./routing/selection`; the three existing call sites pass `selectionOptions`.
- Add the same condition to the existing `if` guarding `promoteActiveCodexAccount(cooler)`,
  `promoteActiveCodexAccount(expiredDetour)` and `rememberActiveCodexAccount(preempted)`,
  editing the condition in place.

Post-response failover (`recordCodexUpstreamOutcome` quota-refusal branches and the account
exclusion path) promotes `meta.promoteAccountId` or `pickAlternateCodexAccount(...)` without
request selection options. The implementation traces where `meta.promoteAccountId` is set; if a
request-owned retry can place `main` there, the same rule is applied by carrying the request's
ownership into that metadata, and if it cannot, the PR states the reason with file and line.

Thread affinity, round-robin ring bookkeeping and the account that serves the request are
unchanged.

## Regression tests

`tests/codex-integration/codex-pool-rotation.test.ts` (no file-size cap), next to the existing
`getEffectiveActiveCodexAccountId` assertions, each resolving through
`resolveCodexAccountForThreadDetailed` with
`{ requestOwnedMainCredential: true, isMainAccountTokenLive: () => true }` on a pool whose
operator-selected active account is a stored account:

- default `quota` strategy with the active account over its switch threshold and `main` the
  cooler candidate: the request resolves to `main`, while `config.activeCodexAccountId` and
  `getEffectiveActiveCodexAccountId(config)` still name the operator's account;
- round-robin and fill-first new sessions whose next pick is `main`: same assertions;
- control: each scenario without `requestOwnedMainCredential` (stored main live) does move
  the active account to `main`, proving the new cases are not passing because nothing moves.

Preemption and the bound-thread paths get a case each when the fixture can reach them with a
request-owned selection; otherwise the PR names why they are unreachable for such a request.

## Acceptance

- The PR's pull-request run executes this file (`src/**` and `tests/**` match the `ci` filter)
  and every requested job succeeds at the exact head; `file-size ratchet` passes with no cap
  change.
- An independent reviewer enumerates every writer of `runtimeActiveCodexAccountId` and
  `config.activeCodexAccountId` (`git grep -n -E 'rememberActiveCodexAccount|promoteActiveCodexAccount|setActiveCodexAccount|activeCodexAccountId =' -- src`)
  and confirms each is guarded or unreachable from a request-owned main selection, and that
  the new tests fail without the change.

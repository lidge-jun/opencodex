# Phase 2 — one kernel, and the generic kind consumes its persisted settings

Base: the phase-1 layer. Branch: `codex/pool-shared-kernel`, PR base
`codex/pool-manual-selection`. Same lane-L3 precondition as phase 1.

## Thesis

Extract the rotation primitives into a credential-neutral kernel, then make the
generic OAuth kind actually consume the `strategy` and `autoSwitchThreshold` it
already persists.

## Current behaviour (verified on dd9a2906b)

The primitives already take an opaque `poolKey`, so a third key is addable:

```
src/codex/pool-rotation.ts
  4-5  POOL_KEY_CODEX = "codex"; POOL_KEY_ANTHROPIC = "anthropic";
  13   const selectionState = new Map<string, SelectionState>();
  86   selectPriorityTier(ids, priorityOf, hasHeadroom, pinnedId?)
  189  pickRoundRobinAccount(poolKey: string, eligibleIds, stickyLimit)
  201  peekRoundRobinAccount(...)
  213  notePoolRotationSuccess(poolKey, accountId, stickyLimit)
  232  notePoolRotationFailure(poolKey, accountId)
  245  seedPoolRotationAccount(poolKey, accountId)
  270  reconcilePoolRotationState  // only sweeps "anthropic", "codex", "codex:*"
```

Fill-first is duplicated rather than shared: `pickFillFirstCodexAccount`
(`routing.ts:1370`) and `pickFillFirstAnthropicAccount`
(`anthropic-routing.ts:513`).

`src/oauth/generic-account-failover.ts` imports nothing from `pool-rotation.ts`.
It keeps its own cooldown `health` map (`:64-70`, keyed `provider\0accountId`),
rotates on 429 through `rankAccountsByHeadroom` (`:178-218`) and steers the first
attempt through `preferredInitialAccount` (`:246-292`) when
`oauthAccountFailover.enabled`. It never reads `failover.strategy` or
`autoSwitchThreshold`.

`src/oauth/pool-settings-capability.ts` returns `"codex" | "anthropic" | "generic"`
and stamps `inert: true` on the generic DTO (`:40-54`, `:57-67`).
`src/server/management/oauth-account-routes.ts:395-396` still rejects
`stickyLimit` and `quotaWindow` for the generic kind.

## Change surface

NEW `src/oauth/pool-kernel.ts`
- move `SelectionState`, `pickRoundRobinAccount`, `peekRoundRobinAccount`,
  `seedPoolRotationAccount`, `notePoolRotationSuccess`, `notePoolRotationFailure`,
  `selectPriorityTier`, and the strategy/sticky normalizers
- add `genericPoolKey(provider) => \`generic:\${provider}\``
- lift fill-first to `pickFillFirst(ids, afterId, hasHeadroom)` so both existing
  copies call one implementation
- extend the reconcile sweep to `generic:*` keys, which `:270-276` currently skips

MODIFY `src/codex/pool-rotation.ts` — re-export the kernel so existing importers
and `tests/codex-integration/codex-pool-rotation.test.ts` keep working unchanged.

MODIFY `src/oauth/generic-account-failover.ts` — route selection through the kernel
by strategy: `quota` keeps `rankAccountsByHeadroom`, `round-robin` calls
`pickRoundRobinAccount(genericPoolKey(name), ...)`, `fill-first` calls the lifted
helper; seed on manual selection; note success and failure. Keep the presence
quorum, the `EXCLUDED_PROVIDERS` guard and the per-provider `health` cooldown.

MODIFY `src/oauth/pool-settings-capability.ts` — drop `inert: true`, add
`stickyLimit`. MODIFY `src/types/provider.ts:512-518` comments and
`oauth-account-routes.ts:395` to accept `stickyLimit`.

MODIFY `src/codex/routing.ts` and `src/oauth/anthropic-routing.ts` — import from
the kernel instead of holding their own copies.

## Reversibility (audit blocker, mandatory)

1. **Flag.** `pool.kernel` defaults to `false`. With it off, Codex and Anthropic
   take the pre-kernel code path and the generic kind keeps reporting `inert`.
2. **Dual-read.** The kernel reads the already-persisted keys without rewriting
   them: `accountPoolStrategy`, `accountPoolStickyLimit`, `autoSwitchThreshold`,
   `anthropicAccountPool.*`, `providers.<name>.oauthAccountFailover`,
   `activeCodexAccountPinned`. No migration writes on upgrade.
3. **Rollback.** Flag off. No config is rewritten, so downgrade is a restart.
4. **Parity proof.** Golden selection traces recorded before and after for Codex
   and Anthropic across manual, affinity, quota, round-robin and fill-first, plus
   the `__main__` and independent-quota-scope callers. Identical picks are the
   gate; a differing pick is a blocker, not a note.

## Tests

- `tests/codex-integration/codex-pool-rotation.test.ts` — unchanged behaviour
  through the re-export (`pickRoundRobinAccount` `:270`, `selectPriorityTier` `:111`)
- `tests/oauth/generic-oauth-failover.test.ts` — a configured strategy changes the
  selected account, which is the criterion that closes "no longer inert"
- `tests/server/account-pool-management-api.test.ts` `:435`, `:449` and
  `tests/cli/cli-account-pool-verbs.test.ts` `:315` — update the inert assertions
- `tests/adapters/anthropic/anthropic-account-pool.test.ts` — parity
- `tests/providers/kiro/kiro-pool-rank.test.ts` — the kiro exhaustion special case
  in `account-quota-rank.ts:84-108` survives

# Phase 2 — one kernel, and the generic kind consumes its persisted settings

Base: the phase-1 layer. Branch: `codex/pool-shared-kernel`, PR base
`codex/pool-manual-selection`. Same lane-L3 precondition as phase 1.

## Thesis

Extract the rotation primitives into a credential-neutral kernel, then make the
generic OAuth kind actually consume the `strategy` and `autoSwitchThreshold` it
already persists.

## Availability and the slice this cycle can actually take

Re-verified at the wp2 P entry against `origin/dev`. The lane partition for the
round in flight does not list `src/oauth/generic-account-failover.ts`,
`src/oauth/pool-settings-capability.ts` or `src/codex/pool-rotation.ts`, so the
kernel extraction and the generic-kind strategy work are available now. Two things
are not:

- `src/codex/routing.ts` is owned by lane L3, so the Codex-side import swap waits.
- `src/server/responses/core.ts` is owned by lane L1 and is the most contended
  file in the round with four open PRs, which is also why the wp4b call-site
  wiring could not follow #4277 immediately.

This cycle takes the kernel, the Anthropic import swap and the generic consumer.
Only the CODEX import swap is deferred, and it is deferred for free: once
`pool-rotation.ts` re-exports the kernel, `src/codex/` keeps its existing import
path and needs no edit at all. So the contended files stay out of this PR without
the kernel being an orphan.

Two kinds of change are moving here and they carry different risk, which is why
only one of them is behind the flag:

- **Relocation** is behaviour-preserving. Moving the state and primitives into
  `pool-kernel.ts` and re-exporting them changes no selection outcome, so it is
  not flagged. `git` history and a green existing suite are its proof.
- **Behaviour** is flagged. The generic kind consuming `strategy` and
  `autoSwitchThreshold`, and the DTO reporting `inert: false`, only happen when
  `pool.kernel` is on. Flag off restores today's outcomes exactly, because the
  pre-kernel path is the same code reached through the shim.

Anchors confirmed present on `origin/dev`: `selectPriorityTier` :86,
`pickRoundRobinAccount` :189, `notePoolRotationSuccess` :213,
`seedPoolRotationAccount` :245, `reconcilePoolRotationState` :260 in
`pool-rotation.ts`; `preferredInitialAccount` :246 and the
`rankAccountsByHeadroom` import :19 in `generic-account-failover.ts`.

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
- move the WHOLE private `selectionState` map together with
  `pickRoundRobinAccount`, `peekRoundRobinAccount`, `seedPoolRotationAccount`,
  `notePoolRotationSuccess`, `notePoolRotationFailure`, `clearPoolRotationState`,
  `selectPriorityTier`, the priority parsers, `POOL_KEY_*` and the strategy and
  sticky normalizers. Moving a function subset while leaving the map behind would
  split one piece of state across two modules.
- the move is safe: `pool-rotation.ts` imports only two TYPES,
  `OcxAccountPoolRotationStrategy` from `../types` and `GenerationContext` from
  `../lib/state-store-sweeper`. Neither creates a cycle into `src/oauth`.
- add `genericPoolKey(provider) => \`generic:\${provider}\``
- add a fill-first helper with the signature
  `pickFillFirst(ids, afterId, hasHeadroom, stableAll)`. The earlier three-argument
  shape was rejected by the audit: both existing copies walk a STABLE FULL roster
  and not the eligible subset, so dropping `stableAll` changes the wrap order
  whenever an ineligible id sits between two eligible ones.
- extend the reconcile sweep to `generic:*`. `buildGenerationContext` already fills
  `oauthAccountKeys` from `listLiveOAuthAccountKeys` as `provider\0id` for every
  live OAuth provider, so the sweep needs no new field and no Codex dependency;
  today those keys are simply skipped as `valid === null`.

NOT moved, deliberately: the Codex fill-first copy in `src/codex/routing.ts` stays
where it is. Deleting it is the only thing that would force an edit to a file lane
L3 owns, and the audit flagged that as a blocker against this unit's own freeze.
Only `anthropic-routing.ts` and the generic kind switch to the kernel helper, and
the Anthropic caller keeps its weekly `exhausted5h` pre-filter rather than pushing
that rule into the shared helper.

MODIFY `src/codex/pool-rotation.ts` — re-export the kernel so existing importers
and `tests/codex-integration/codex-pool-rotation.test.ts` keep working unchanged.

MODIFY `src/oauth/generic-account-failover.ts` — branch BOTH paths on strategy, not
just the proactive one. `preferredInitialAccount` currently no-ops when the active
account is healthy and requires `hasHeadroomEvidence`, and the 429 path always ends
in `rankAccountsByHeadroom`; leaving either unbranched keeps the strategy inert in
practice even after the DTO says otherwise. `quota` keeps
`rankAccountsByHeadroom`, `round-robin` calls
`pickRoundRobinAccount(genericPoolKey(name), ...)`, and `fill-first` uses the
kernel helper with `autoSwitchThreshold` as its headroom test. Keep the presence
quorum, the `EXCLUDED_PROVIDERS` guard and the per-provider `health` cooldown.

MODIFY `src/server/management/oauth-account-routes.ts` — a manual account selection
must seed the cursor, or the operator's pick immediately loses to sticky
round-robin. Today that PUT calls only `forgetGenericFailoverRoster`, which clears
the presence cache and not the rotation state. Add
`seedPoolRotationAccount(genericPoolKey(provider), accountId)` beside it, mirroring
what `resetAnthropicRoutingForManualSelection` already does for Anthropic.
`clearGenericFailoverHealth` is the wrong map and `clearPoolRotationState` wipes
where seeding is wanted.

MODIFY `src/oauth/pool-settings-capability.ts` — report `inert` from the flag rather
than as a type literal. While `pool.kernel` is off the generic DTO must keep saying
`inert: true`, because nothing consumes the strategy yet and the reversibility rule
below requires the old behaviour to be exactly restorable. The literal becomes a
computed field and only turns false once the kernel is on.

Known readers of that field, all of which move in the same PR:
`src/cli/account-extended.ts` (forces generic auto-switch inactive),
`tests/server/account-pool-management-api.test.ts` and
`tests/cli/cli-account-pool-verbs.test.ts`. The GUI does not read it.
Also lift the `stickyLimit` rejection at `oauth-account-routes.ts:395` and update
`src/types/provider.ts:512-518` comments.

MODIFY `src/oauth/anthropic-routing.ts` — import from the kernel. `src/codex/`
keeps importing `./pool-rotation`, which is now a re-export, so this layer needs
no edit inside lane L3's files at all. The audit confirmed the shim is sufficient:
`routing.ts`, `auth-api.ts`, `account-priority.ts` and
`state-store-registrations.ts` all keep their existing import path.

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

Audit record: the A-phase reviewer returned PASS-WITH-FINDINGS with two blockers,
both folded above. The first was that lifting fill-first out of its Codex copy
would have forced an edit inside lane L3's freeze. The second was that dropping
`inert: true` unconditionally contradicts this document's own reversibility rule,
which requires `pool.kernel` to default off and the old behaviour to be exactly
restorable.

## Second-half audit (the flagged behaviour change)

The extraction shipped as PR #4279. A separate audit of the remaining half returned
FAIL, and its findings change that half materially. Recorded here so the next cycle
starts from them rather than rediscovering them.

1. **BLOCKER. Branching the final ranking expression is not enough.**
   `preferredInitialAccount` encodes the quota strategy BEFORE its tail: the
   healthy-active early return tests `isAccountQuotaExhausted` (:262) and the
   roster-wide `hasHeadroomEvidence` check (:272) returns null when a provider has
   no quota data at all. Leave those untouched and round-robin can never run for a
   provider without quota evidence, and fill-first never reaches
   `autoSwitchThreshold` because the healthy active account already returned. Both
   guards have to be strategy-gated: skip the evidence requirement for round-robin,
   and use the threshold rather than exhaustion for fill-first.
2. **BLOCKER. The preference must peek, not pick.**
   `pickRoundRobinAccount` mutates live ring state, but
   `preferredInitialAccount` is explicitly a discardable proposal that the caller
   drops on a resolver throw or a missing project. Mutating there desyncs the
   cursor against requests that never happened. Use `peekRoundRobinAccount` and
   mutate with `pickRoundRobinAccount` plus `notePoolRotationSuccess` only after
   the selection is admitted, which is what Anthropic already does.
3. **The 429 path is safe to branch but fill-first must still move.** That tail has
   no evidence guard, so a strategy branch is structurally fine. Fill-first there
   cannot mean keep-active: the account that just returned 429 is already cooled,
   so staying put would skip rotation entirely.
4. **`stickyLimit` does not exist for the generic kind yet.** The
   `oauthAccountFailover` type carries only `enabled`, `strategy` and
   `autoSwitchThreshold`. Lifting the 400 at `oauth-account-routes.ts:395` before
   adding the field to the type, the DTO, GET and the PUT writer would accept a
   value and then drop it. The kernel default is 1.
5. **The flag lands in a lane-owned file.** `OcxConfig` has no `pool` key today,
   so `pool.kernel` belongs in `src/types/config.ts` (around :363) - which lane L3
   owns. This half therefore inherits the same freeze as work-phases 1 and 2 until
   that ownership clears, or the flag needs a different home.

- `tests/codex-integration/codex-pool-rotation.test.ts` — unchanged behaviour
  through the re-export (`pickRoundRobinAccount` `:270`, `selectPriorityTier` `:111`)
- `tests/oauth/generic-oauth-failover.test.ts` — a configured strategy changes the
  selected account, which is the criterion that closes "no longer inert"
- `tests/server/account-pool-management-api.test.ts` `:435`, `:449` and
  `tests/cli/cli-account-pool-verbs.test.ts` `:315` — update the inert assertions
- `tests/adapters/anthropic/anthropic-account-pool.test.ts` — parity
- `tests/providers/kiro/kiro-pool-rank.test.ts` — the kiro exhaustion special case
  in `account-quota-rank.ts:84-108` survives

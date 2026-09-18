# Account pool unification

Unit opened 2026-09-11. Base: `dev` at `dd9a2906b` (2.52.0).

## Objective

Collapse the three independent account-pool implementations into one shared
selection kernel with per-kind policy, and make an operator's manual account
selection actually win over the pool cursor.

## Why this unit exists

An audit of `dev` on 2026-09-11 found pooling is not one feature but three,
plus a fourth path for API keys:

| Kind | Owner | What it actually does |
|---|---|---|
| Codex | `src/codex/routing.ts`, `src/codex/pool-rotation.ts` | full: strategy, sticky, priority tiers, auto-switch threshold |
| Anthropic | `src/oauth/anthropic-routing.ts` | full: strategy, session affinity, manual preference |
| generic OAuth (10 providers) | `src/oauth/generic-account-failover.ts` | 429 rotation plus a proactive headroom preference when `enabled`; only `strategy` and `autoSwitchThreshold` are persisted-but-inert |
| API keys | `src/providers/key-failover.ts` | reactive 429/401 index walk; no strategy at all |

The generic kind already has a settings DTO and a capability enum
(`src/oauth/pool-settings-capability.ts` returns `"codex" | "anthropic" | "generic"`),
so the seam for a shared layer was designed and then left hollow. This unit fills
it rather than inventing a new abstraction.

## The defect that motivates work-phase 1

Reported by the maintainer and confirmed in code: the pool moves the active
account to B, the operator then selects A through the dashboard or
`ocx account use`, and the runtime keeps serving B.

The shape of the defect, not its patch: the Codex pin is a priority-tier ceiling
rather than a selection input, so the strategy picker and the preemption path can
return a different account and record it as the runtime choice. Anthropic solves
the same problem with a one-shot `manualPreference` that Codex and the generic
kind do not have. GUI and CLI are not the divergence: both issue the same
`PUT /api/codex-auth/active`.

This is a pin-semantics change, not a one-expression bug. An earlier draft named
`applyQuotaAutoSwitch` as the cause; the A-phase audit rejected that, because that
path only moves at `autoSwitchThreshold`, which the drain handler already treats
as the end of a pin. Exact call sites, line anchors and the before/after contract
belong to `010_phase1_manual_selection.md`, not here.

## Settled semantics

Recorded during the 2026-09-11 interview (session tracker rounds 1-5):

- **Manual selection is a one-shot preference that commits on success.** The next
  dispatch uses the operator's account; if that dispatch succeeds the account is
  committed as the stored active one. The pool may move again only for a real
  reason such as 429, cooldown or quota exhaustion. This is the shape Anthropic
  already implements through `manualPreference`; Codex and the generic kind lack it.
- **One shared layer, different policy per kind.** Selection order, cooldown and
  account state are shared. Policy is not: API keys are a rate-limit scheduling
  problem and rotate cheaply, while subscription accounts lose their prompt cache
  on every move, so cache affinity must be consulted before quota for them.

## Constraints

- `dev` is the only integration branch. Layers that sit in a chain target the layer
  below them; layers that are not in a chain target `dev` directly. The Delivery
  section names which is which.
- Bun-native TypeScript. No Node-only APIs, no compile step.
- Touching OAuth account selection and credential resolution puts this unit inside
  the AGENTS.md security boundary, so each layer needs explicit security review and
  must not log tokens or account identifiers.
- `privacy:scan` must stay green.
- Existing Codex and Anthropic pool behavior must not regress; they migrate onto
  the shared layer rather than being rewritten in place.
- **Lane ownership.** `devlog/_plan/260911_lane_dispatch_round/010_lane_partition.md`
  is the authoritative ownership list for the multi-lane round in flight on `dev`,
  and lane L3 owns `src/codex/auth-api.ts`, `src/codex/routing.ts` and
  `src/types/config.ts`. Work-phases 1 and 2 need those files, so no implementation
  cycle may open against them until that lane releases them or the maintainer
  reassigns ownership. This roadmap cycle writes documents only and takes no owned path.
- **Reversibility is a precondition, not a nicety.** Because this unit changes
  credential selection, every migrating phase ships behind a flag that defaults to
  the existing pools, dual-reads the already-persisted keys
  (`accountPoolStrategy`, `accountPoolStickyLimit`, `autoSwitchThreshold`,
  `anthropicAccountPool`, `providers.<name>.oauthAccountFailover`,
  `activeCodexAccountPinned`), and proves parity with before/after selection traces
  for Codex and Anthropic across manual, affinity, quota, round-robin and fill-first.
  Flag-off is the rollback.

## Work-phase map

Dependency order, not effort order. Each layer stands alone with its own tests.

| Phase | Doc | Thesis | Depends on |
|---|---|---|---|
| 0 | this unit | roadmap written to diff level | — |
| 1 | `010_phase1_manual_selection.md` | an operator pick beats the pool cursor | 0 |
| 2 | `020_phase2_shared_kernel.md` | one kernel, and the generic kind consumes its persisted strategy and threshold | 1 |
| 3 | `030_phase3_cache_affinity.md` | cache affinity ranks ahead of quota | 2, plus the three open assumptions closed |
| 4 | `040_phase4_key_pool_strategy.md` | API keys gain proactive selection | none (parallel off trunk) |
| 5 | `050_phase5_surface_consolidation.md` | three contracts and two GUIs become one | 2 |

Phase 4 was reparented during the A-phase audit. It does not depend on phase 2:
`src/providers/key-failover.ts` shares no module with the OAuth kernel, and an API
key is a different identity from an OAuth account set. It runs parallel off trunk,
and would gain a dependency only if phase 2 chose to export a credential-kind-agnostic
kernel that `key-failover` imports, which phase 2 does not promise.

Phase 3 is the speculative layer: all three open assumptions below live in it, so it
does not ride the first train.

Phase 5 and phase 4 must not both edit the pool management routes and the shared GUI
controls. Phase 5 owns `src/server/management/oauth-account-routes.ts`, the route
registry entries and the GUI pool surfaces; phase 4 keeps key-strategy fields out of
those files and exposes nothing operator-visible until phase 5 gives it a home.

## Delivery

A manual branch chain, each layer a PR based on the layer below
(`gh pr create --base`). GitHub native stacks are not used: per
DEV-STACK-OPT-IN-01 a generic request to stack is not native opt-in.

The first chain is two layers, phase 1 then phase 2. Phase 5 opens off the phase-2
layer once the kernel lands. Phase 3 waits for its assumptions to close. Phase 4 is
an ordinary PR off `dev` and joins no chain. This replaces an earlier 1-2-3 chain
that the audit rejected for carrying the speculative layer.

## Open assumptions

Carried out of the interview unresolved. Each is a question the roadmap answers in
its own phase doc, not a blocker on this plan.

1. **Affinity key composition.** Codex keys on thread id, Anthropic on a session
   key. A shared key shape is not yet chosen. Phase 3 decides it.
2. **Shared-cohort handling.** `promptCacheKeyIsSharedCohort` currently discards
   affinity entirely when a `prompt_cache_key` looks shared. Whether to fall back
   to another identifier instead of discarding is open.
3. **Cache minimum threshold.** There is no minimum-token gate before applying
   `cache_control`, and Anthropic's own 1024/2048 breakpoint minimum is not
   implemented locally. Whether to add one is open.

## Audit record

Two independent reviewers audited this plan at A and both returned FAIL. Folded
findings: the phase-1 implementation recipe moved out of this 000 document
(LEXICO-SPLIT-01); the causal story corrected away from `applyQuotaAutoSwitch`; the
generic-OAuth description corrected from "reactive only"; phase 4 reparented off
trunk; rollback, feature flag, persisted-config dual-read and parity proof added as
constraints; the lane-ownership collision with `260911_l3_account_pool` recorded as
a hard precondition on phases 1 and 2.

One finding is passed to a phase doc rather than folded here: `key-failover` already
logs `failedId` and `candidateId`, so `040` must forbid inheriting that logging shape.

## Evidence

Audit conducted 2026-09-11 against `origin/dev`. Interview record:
`.codexclaw/interviews/01a08fce-634e-7531-b383-26f2251d9dae.jsonl`, tracker
`.codexclaw/sessions/01a08fce-634e-7531-b383-26f2251d9dae.json` (five scan rounds,
no unresolved contradictions).

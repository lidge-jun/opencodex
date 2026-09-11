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
| generic OAuth (10 providers) | `src/oauth/generic-account-failover.ts` | reactive 429 rotation only; `strategy` and `autoSwitchThreshold` are persisted but inert |
| API keys | `src/providers/key-failover.ts` | reactive 429/401 index walk; no strategy at all |

The generic kind already has a settings DTO and a capability enum
(`src/oauth/pool-settings-capability.ts` returns `"codex" | "anthropic" | "generic"`),
so the seam for a shared layer was designed and then left hollow. This unit fills
it rather than inventing a new abstraction.

## The defect that motivates work-phase 1

Reported by the maintainer and confirmed in code: the pool moves the active
account to B, the operator then selects A through the dashboard or
`ocx account use`, and the runtime keeps serving B.

The cause is a single expression. `getEffectiveActiveCodexAccountId`
(`src/codex/routing.ts:1626`) resolves
`runtimeActiveCodexAccountId ?? config.activeCodexAccountId` and the pin is not
part of it, while `rememberActiveCodexAccount` (`:1645`) writes the pool's pick
into `runtimeActiveCodexAccountId` without releasing the pin. The runtime cursor
therefore outranks the stored operator choice. `applyQuotaAutoSwitch` has no pin
check at all. GUI and CLI are not the divergence: both issue the same
`PUT /api/codex-auth/active`.

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

- `dev` is the only integration branch; every layer targets the branch below it.
- Bun-native TypeScript. No Node-only APIs, no compile step.
- Touching OAuth account selection and credential resolution puts this unit inside
  the AGENTS.md security boundary, so each layer needs explicit security review and
  must not log tokens or account identifiers.
- `privacy:scan` must stay green.
- Existing Codex and Anthropic pool behavior must not regress; they migrate onto
  the shared layer rather than being rewritten in place.

## Work-phase map

Dependency order, not effort order. Each layer stands alone with its own tests.

| Phase | Doc | Thesis | Depends on |
|---|---|---|---|
| 0 | this unit | roadmap written to diff level | — |
| 1 | `010_phase1_manual_selection.md` | an operator pick beats the pool cursor | 0 |
| 2 | `020_phase2_shared_kernel.md` | the generic kind stops being inert | 1 |
| 3 | `030_phase3_cache_affinity.md` | cache affinity ranks ahead of quota | 2 |
| 4 | `040_phase4_key_pool_strategy.md` | API keys gain proactive selection | 2 |
| 5 | `050_phase5_surface_consolidation.md` | three contracts and two GUIs become one | 2 |

Phases 3, 4 and 5 all depend on 2 and are independent of each other, so they are
parallel branches off the phase-2 layer rather than a deeper chain.

## Delivery

A manual branch chain, each layer a PR based on the layer below
(`gh pr create --base`). GitHub native stacks are not used: per
DEV-STACK-OPT-IN-01 a generic request to stack is not native opt-in.

Stack depth is held at three for the first train (phases 1, 2, 3). Phases 4 and 5
open after phase 2 lands, because DEV-STACK-01 warns that chains past four layers
cost more in cascading than they return.

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

## Evidence

Audit conducted 2026-09-11 against `origin/dev`. Interview record:
`.codexclaw/interviews/01a08fce-634e-7531-b383-26f2251d9dae.jsonl`, tracker
`.codexclaw/sessions/01a08fce-634e-7531-b383-26f2251d9dae.json` (five scan rounds,
no unresolved contradictions).

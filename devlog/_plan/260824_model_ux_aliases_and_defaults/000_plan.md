# 000 — model_ux_aliases_and_defaults: Plan & Research

## Objective

Design — to issue-ready, near-implementation precision — three model/provider UX
improvements, file them as three templated GitHub issues on
`lidge-jun/opencodex`, and land this design unit on `dev` via a docs-only PR.
No implementation code in this unit.

Trigger: X feedback on the model picker
([@terryaidev](https://x.com/terryaidev/status/2091696002550083870)):
"Probably add customized model name, since some of the model names can be very
long and not good for user experience." Plus two operator-observed defaults
problems: live-catalog providers (OpenRouter) expose 400+ models all-on, and
catalog refresh introduces new models already enabled.

## Deliverables

| Doc | Design | Issue |
|-----|--------|-------|
| 010 | Provider & model aliases (pencil edit, defaults set, CLI space) | [#2463](https://github.com/lidge-jun/opencodex/issues/2463) |
| 020 | Newly discovered models arrive OFF by default | [#2464](https://github.com/lidge-jun/opencodex/issues/2464) |
| 030 | Latest-only default preset per provider | [#2465](https://github.com/lidge-jun/opencodex/issues/2465) |

## Current behavior (evidence base)

- Visibility is a two-filter system (`src/server/management/model-routes.ts`):
  - Per-provider allowlist `providers.<name>.selectedModels` — absent/empty
    means "expose everything" (`/api/selected-models` GET/PUT, line ~531).
  - Global blocklist `config.disabledModels` (`/api/disabled-models`, ~272).
  - `/api/model-visibility` (PUT, ~285) updates both atomically; scope
    `models` or `provider`; native rows use only the blocklist.
- GUI: `gui/src/model-visibility.ts` — `modelIncluded()` returns true when
  the allowlist is absent OR empty; `gui/src/pages/Models.tsx` renders per-
  provider toggle lists ("모두 켜기 / 모두 끄기", custom window).
- CLI: `ocx models` subcommands `live/edit/enable/disable/provider/selected/
  context/shadow` (`src/cli/models.ts:415`, `src/cli/models-runtime.ts`).
- `ModelConfig.displayName` already exists (`src/types/config.ts:190,626`)
  but only for custom models; there is no provider alias and no resolvable
  model alias.
- Live catalogs: `liveModels?: boolean` (`src/types/provider.ts:260`);
  `getProviderLiveModelCount` feeds the GUI. New live models are visible the
  moment they are discovered (allowlist absent = all-on).

## Loop-spec

- Loop archetype: verifier-defined (issues exist + PR merged = done).
- Write scope: `devlog/_plan/260824_model_ux_aliases_and_defaults/**` only.
  Out of scope: any `src/`, `gui/`, `docs-site/` change; implementation.
- External writes: 3 issues on lidge-jun/opencodex; 1 PR to `dev` + merge
  (explicitly user-authorized in the request).
- Budget: single PABCD work-phase; sol-medium subagent drafts, main verifies.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 000/010/020/030 | Research + three designs + 3 issues + docs PR merged to dev | — |

Implementation work-phases are intentionally NOT scheduled here; each issue
becomes its own future unit when picked up.

## Accept criteria

- c1: three issues created on lidge-jun/opencodex using the exact
  `feature_request.yml` form headings (survives enforce-issue-quality).
- c2: this unit contains 000/010/020/030 at design precision.
- c3: docs-only PR targeting `dev` merged; merge SHA recorded in 090.

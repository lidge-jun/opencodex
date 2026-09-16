# wp3 — Move every opencodex-owned default off the retired slugs

Every lane goes to `gpt-5.6-luna`, including the login provider default (owner
decision, 2026-09-12). Each site below dispatches a real request today and would 404
after retirement.

## MODIFY src/oauth/index.ts

Line 331, the `chatgpt` OAuth definition: `defaultModel: "gpt-5.4"` becomes
`defaultModel: "gpt-5.6-luna"`.

Be accurate about what this constant does, because the first draft of this plan was not:
`upsertOAuthProvider` returns at `src/oauth/index.ts:1476` for `chatgpt`, so the value is
never persisted onto a provider row, and `src/cli/models.ts:139`, `src/cli/provider.ts`
and `src/server/fast-row.ts:133` all read `config.providers[*].defaultModel` rather than
this constant. It is the ChatGPT login definition's declared default, not a live 404
dispatch path. It still moves: leaving a retired slug as the login surface's stated
default is wrong on its own terms, and any future consumer would inherit it.

## MODIFY src/oauth/token-guardian.ts

Line 55, `DEFAULTS.codexWarmupModel`: `"gpt-5.4-mini"` becomes `"gpt-5.6-luna"`.
Line 87 reads a stored override first, so a user who explicitly set
`tokenGuardian.codexWarmupModel: "gpt-5.4-mini"` keeps calling the retired model.
Extend the existing startup migration (below) to rewrite that stored value too.

## MODIFY src/codex/warmup.ts

Line 30: `const DEFAULT_MODEL = "gpt-5.4-mini"` becomes `"gpt-5.6-luna"`.
Line 31: `FALLBACK_MODELS = ["gpt-5.5", "gpt-5.6-luna"]` becomes `["gpt-5.5"]` — luna
is now the primary, and the loop already skips a fallback equal to the primary, so
leaving it would be dead weight that reads as a second chance.

## MODIFY src/vision/plan.ts

Line 14: `const DEFAULT_VISION_MODEL = "gpt-5.4-mini"` becomes `"gpt-5.6-luna"`.
Lines 71 and 87 consume it and need no edit. This is the one that the startup sidecar
migration cannot reach: an unset `visionSidecar.model` never equals the old string, so
today an untouched install still describes images with a retired model.

After this, `src/vision/eligibility.ts:51` and `src/vision/backends.ts:51` — both
already `gpt-5.6-luna` — agree with the runtime instead of contradicting it.

## MODIFY src/server/management/config-routes.ts

Lines 823-824, the vision effort-table normalization: both `"gpt-5.4-mini"` literals
become `"gpt-5.6-luna"`. Lines 724 and 963 are already luna and stay.

## MODIFY src/cli/config-command.ts

Line 148: `const model = vision.model || "gpt-5.4-mini"` becomes `"gpt-5.6-luna"`, and
the line 147 comment that names the old bounded default follows it.

## MODIFY src/server/index.ts

KEEP the sidecar migration block at 686-701 — it is the only thing that rewrites a
stored `gpt-5.4-mini` for existing users, and its destination is already luna. Two
changes:

1. Extend it to `config.tokenGuardian?.codexWarmupModel === "gpt-5.4-mini"`, which is
   currently not migrated and is a live dispatch path.
2. Correct the comment: it claims "explicit user choices are preserved", but the check
   is exact equality, so an explicitly chosen `gpt-5.4-mini` is rewritten too. After
   retirement that is the right behaviour; the comment should say so rather than
   describe a guarantee the code does not make.

The `SIDECAR_MIGRATION_CUTOFF` date gate stays as-is.

## MODIFY src/types/config.ts, src/types/tools.ts, src/types/request.ts

Doc comments only, but they are the published contract:

- `config.ts:1125` — "Default gpt-5.4-mini" for `codexWarmupModel` becomes luna.
- `config.ts:604` and `:614` — the shadow-intercept comments claim both slugs are
  defaults while the code ships luna only. Correct them to state the default is
  `gpt-5.6-luna` and `gpt-5.4-mini` is an opt-in `sourceModels` value for 0.144.x
  clients.
- `tools.ts:16` and `request.ts:103` — the synthetic web_search comments still name a
  "gpt-5.4-mini sidecar"; `src/web-search/index.ts:23` has been luna for a while.

## KEEP src/lib/shadow-call.ts

`DEFAULT_SHADOW_SOURCE_MODELS` stays `["gpt-5.6-luna"]` and the 0.144.x note stays.
This list is what the proxy *intercepts*, not what it sends: a 0.144.x client emitting
`gpt-5.4-mini` helper calls is exactly who benefits from an intercept, and an operator
can restore the prefix through `sourceModels`. Adding it back to the default would
change intercept behaviour for every install, which is a separate decision from
retiring the model.

## Tests

- `tests/codex-integration/warmup.test.ts` 97-141, `codex-warmup.test.ts` 38/55,
  `token-guardian.test.ts` 253, `codex-quota-auto-refresh-main-admission.test.ts` 290 —
  the warmup chain becomes `gpt-5.6-luna` then `gpt-5.5`.
- `tests/vision/**` — `sidecar-abort.test.ts` (21 fixtures), `vision-reasoning-contract.test.ts`
  (14, retune to luna's ladder), `sidecar-settings-vision-filter.test.ts` 137/189,
  `sidecar-settings-vision-controls.test.ts` 89, `vision-anthropic.test.ts` 419.
  KEEP `vision-eligibility.test.ts` 22-26 (OpenRouter `openai/gpt-5.4-mini` metadata).
- `tests/web-search/web-search.test.ts` — 26 settings fixtures move to luna.
- `tests/server/server-combo-failover-e2e.test.ts` — 10 live-forward model ids.
- A new regression for the widened migration: a stored
  `tokenGuardian.codexWarmupModel: "gpt-5.4-mini"` is rewritten to luna at startup.
- `tests/vision/vision-eligibility.test.ts:225` — the native eligibility subject moves to
  luna; 22-26 stay (OpenRouter `openai/gpt-5.4-mini` metadata).
- KEEP `tests/server/config.test.ts` 98 and `server-startup-reconcile-resilience.test.ts` 57
  (legacy roster inputs), `tests/server/api-debug.test.ts` (log-parser fixture),
  `tests/responses/**` (shadow restore hatch), `tests/usage/**` (historical pricing).

## Proof for this phase

`bun test tests/vision tests/web-search tests/server tests/codex-integration` green,
plus `bun run typecheck`.

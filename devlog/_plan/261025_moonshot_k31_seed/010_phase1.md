# 010 — Phase 1 (moonshot_k31_seed) — consolidated after audit rounds 1-2 and manager scope update

## MODIFY / NEW / DELETE map

### MODIFY src/providers/registry/model-seeds.ts (KIMI_API_* block, ~lines 772-809)

```ts
export const KIMI_LEGACY_API_MODELS = [...unchanged];
// 261025 Kimi K3.1 Pro on the Moonshot API (#7653): evidence comment (models.md, pricing/chat.md,
// kimi-k3-1-pro-quickstart.md, api/models-overview.md; China platform.kimi.com/docs/models.md), verified 2026-10-25.
export const KIMI_API_K31_MODELS = ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"];
export const KIMI_API_K3_SERIES_MODELS = ["kimi-k3", ...KIMI_API_K31_MODELS];
export const KIMI_API_MODELS = [...KIMI_API_K3_SERIES_MODELS, ...KIMI_LEGACY_API_MODELS];
// Frozen previous seed for the saved-roster repair (literal, not derived).
export const KIMI_API_MODELS_BEFORE_K31 = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
export const KIMI_API_NO_REASONING_MODELS = KIMI_API_MODELS.filter(id => !KIMI_API_K3_SERIES_MODELS.includes(id));
// none -> omit: thinking cannot be disabled; value mirrors REASONING_EFFORT_OMIT_SENTINEL (src/reasoning-effort.ts:30)
export const KIMI_API_K31_REASONING_EFFORT_MAP = { ...KIMI_CODING_K3_REASONING_EFFORT_MAP, none: "__omit__" };
export const KIMI_API_REASONING_EFFORTS = KIMI_API_MODELS -> K3.1: ["low","high","max"]; kimi-k3: ["max"] (unchanged); K2: [].
export const KIMI_API_DEFAULT_REASONING_EFFORTS = { "kimi-k3.1-pro": "max", "kimi-k3.1-pro-highspeed": "max" };
export const KIMI_API_REASONING_EFFORT_MAPS = { both K3.1 ids: KIMI_API_K31_REASONING_EFFORT_MAP };
export const KIMI_API_MODEL_CONTEXT_WINDOWS = K3 series 1_048_576, K2 262_144;
export const KIMI_API_MODEL_INPUT_MODALITIES = K3 series ["text","image"];
```

(The omit literal is used because model-seeds.ts imports nothing from src/reasoning-effort.ts and the
registry must not depend on the request-path module; a test asserts the literal equals the exported
constant.)

### MODIFY src/providers/registry/entries-extended.ts (moonshot entry)

Add `modelDefaultReasoningEfforts: KIMI_API_DEFAULT_REASONING_EFFORTS` and
`modelReasoningEffortMap: KIMI_API_REASONING_EFFORT_MAPS` (+ imports). defaultModel stays kimi-k2.7-code.

### MODIFY src/providers/stale-model-roster-migration.ts (STALE_MODEL_ROSTERS)

```ts
{
  provider: "moonshot", from: KIMI_API_MODELS_BEFORE_K31, to: KIMI_API_MODELS,
  contextWindows: KIMI_API_MODEL_CONTEXT_WINDOWS, defaultReasoningEfforts: KIMI_API_DEFAULT_REASONING_EFFORTS,
  destinationBaseUrls: [MOONSHOT_INTL_BASE_URL, MOONSHOT_CN_BASE_URL],
}
```

### MODIFY docs-site/src/content/docs/guides/providers.md (English canonical, after the Kimi Coding price paragraph)

One paragraph: moonshot seeds kimi-k3.1-pro / -highspeed next to kimi-k3 and the K2 ids; 1M context,
text+image, always-on thinking, low/high/max (default max; medium->high, xhigh->max, none omits the field);
sampling params omitted; untouched saved model lists on the International/China URLs gain both ids at
startup; default stays kimi-k2.7-code; link the official model list (K2 closes to new accounts 2026-10-31,
retirement planned end of December 2026).

### Structure docs: no edit

providers-and-adapters.md is owned by lane M5 (manager). Its line 87 (Kimi Coding seeds) and line 394
(generic stale-roster contract) remain accurate: this change adds a data row to an existing mechanism and
seeds; no contract changes. chat-compat.md (600/600) describes wire compat, not seeds. Per
structure/AGENTS.md ("a reviewed document whose content remains accurate does not need copied unchanged
prose") no structure edit is required. Recorded in the PR.

## TESTS (all in tests/providers/)

- provider-registry-parity.test.ts, moonshot section: exact models, defaultModel, exact context windows,
  per-K3.1 metadata (no-reasoning absent, ladder, default max, modalities, fixed-sampling + preserve lists,
  not auto-tool-choice-only, map == K3 map with none "__omit__"), kimi-k3 unchanged (["max"], no default/map),
  omit literal === REASONING_EFFORT_OMIT_SENTINEL; catalog entry default_reasoning_level "max".
  New test: persisted OLD moonshot row (old models list, old modelContextWindows/modelReasoningEfforts) routed
  via routeModel to moonshot/kimi-k3.1-pro[-highspeed]: configuredReasoningEfforts low/high/max; wire none -> no
  reasoning_effort, low->low, medium->high, high->high, xhigh->max, max->max, ultra->max; temperature/top_p/penalties stripped.
- model-roster-seed-repair.test.ts: untouched moonshot seed on intl URL, cn URL, and no URL -> refreshed, existing
  containers gain 1M windows + max defaults; custom URL and hand-edited list unchanged.

Red run first on base 0aeaf0cb6b with test edits only.

## Verification (C)

| Command | Expected |
|---|---|
| bun test tests/providers/provider-registry-parity.test.ts tests/providers/model-roster-seed-repair.test.ts tests/usage/usage-cost.test.ts tests/codex-integration/reasoning-effort.test.ts tests/codex-integration/codex-catalog.test.ts | exit 0 |
| bun run typecheck | exit 0 |
| OCX_TEST_RUNNER_BUN=<bun 1.4.3> bun run test:changed | exit 0 except known claude-desktop-remote-hub.test.ts:249 |
| bun run privacy:scan | exit 0 |
| bun run structure:check | exit 0 |
| cd docs-site && bun install --frozen-lockfile && bun run build | exit 0 |

## Audit history

- Round 1 FAIL: (1) none sent on wire for always-thinking K3.1 -> own map with omit; (2) saved rows keep old
  roster -> STALE_MODEL_ROSTERS entry. Both folded.
- Round 2 NEAR-PASS: chat-compat.md is 600/600 -> resolved by making no structure edit (rationale above);
  stale superseded sections -> this consolidated rewrite.

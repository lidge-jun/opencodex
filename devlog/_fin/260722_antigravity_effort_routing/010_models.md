# WP1 — Effort map in antigravity-models.ts + registry.ts

## Goal and dependency

Collapse effort-variant wire IDs into single picker entries and register the effort → wire model map. Depends on WP0 research lock.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/antigravity-models.ts` | `ANTIGRAVITY_WIRE_MODELS` contains all 8 wire IDs; `ANTIGRAVITY_MODELS` = wire + visible aliases | `ANTIGRAVITY_WIRE_MODELS` unchanged (still the full wire list for resolution); new `ANTIGRAVITY_EFFORT_WIRE_MAP` maps `(baseModel, effort)` → wire ID; `ANTIGRAVITY_MODELS` = collapsed picker list (base models only); suffix IDs move to `ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES` |
| MODIFY | `src/providers/antigravity-models.ts` | no effort map export | new `ANTIGRAVITY_MODEL_EFFORTS: Record<string, string[]>` — `{ "gemini-3.6-flash": ["low","medium","high"], "gemini-3.1-pro": ["low","high"] }` |
| MODIFY | `src/providers/antigravity-models.ts` | no Claude effort entry | extend `ANTIGRAVITY_MODEL_EFFORTS` with `"claude-opus-4-6-thinking": ["low","medium","high","max"]` (Anthropic API supports all four; CLIProxyAPI proves CCA wire accepts thinkingConfig for Claude) |
| MODIFY | `src/providers/antigravity-models.ts` | no effort-to-wire map | new `resolveAntigravityEffortWireModel(modelId: string, effort?: string): string` — see precedence rules below |
| MODIFY | `src/providers/antigravity-models.ts` | no base-ID context windows | add explicit entries for `gemini-3.6-flash: 1_048_576` and `gemini-3.1-pro: 1_048_576` in `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` (not via alias derivation — these are picker-visible base IDs) |
| MODIFY | `src/providers/registry.ts` | google-antigravity entry has no effort fields | add `modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS`, keep `defaultModel` pointing at the collapsed base ID |
| MODIFY | `src/usage/expected-prices.ts` | price entries keyed on `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.1-pro-preview` | keep existing entries (they key on wire IDs which survive as aliases); add entries for collapsed base IDs `gemini-3.6-flash`, `gemini-3.1-pro`; update `tests/usage-cost.test.ts` overlay count |

## `resolveAntigravityEffortWireModel` precedence rules

Explicit precedence, evaluated in order:

1. **Suffix wire ID or compat alias** (e.g. `gemini-3.6-flash-low`, `gemini-3.5-flash-high`): resolve through `resolveAntigravityWireModelId(modelId)`. The suffix IS the effort — return the resolved wire ID unchanged. The caller MUST NOT send `thinkingConfig` for these IDs (the suffix already encodes effort; sending both creates a contradictory request).
2. **Mapped base model** (e.g. `gemini-3.6-flash` with effort map entry): if `effort` is provided and in the model's effort map, return the corresponding wire ID (`gemini-3.6-flash-{effort}`). If `effort` is undefined, return the default effort's wire ID (`gemini-3.6-flash-medium`). If `effort` is provided but NOT in the model's map (e.g. `max` on flash), clamp to the highest supported effort and return that wire ID.
3. **All other IDs** (e.g. `claude-sonnet-4-6`, `gpt-oss-120b-medium`, unknown): return `resolveAntigravityWireModelId(modelId)` — identity for non-aliased IDs.

### Whether to send thinkingConfig

The resolver also determines whether `thinkingConfig` should be sent:

- **Suffix/compat IDs** (rule 1): NO — the suffix already encodes effort.
- **Mapped base with explicit effort** (rule 2, effort provided): YES — send `thinkingConfig: { thinkingLevel: effort }` as belt-and-suspenders (CLIProxyAPI pattern).
- **Mapped base with no effort** (rule 2, effort undefined): NO — the default wire ID already encodes the default effort.
- **Claude Opus with explicit effort** (rule 3, but model IS in effort map): YES — send `thinkingConfig: { thinkingLevel: effort }`. Claude has no suffix variants, so thinkingConfig is the only effort channel.
- **All other IDs**: NO.

Return type: `{ wireModelId: string; thinkingLevel?: string }` — the caller uses `wireModelId` for the envelope `model` field and, when `thinkingLevel` is present, writes `generationConfig.thinkingConfig = { thinkingLevel }`.

## Before model list (picker-visible)

```
gemini-3.6-flash-low
gemini-3.6-flash-medium
gemini-3.6-flash-high
gemini-3.1-pro-low
gemini-pro-agent
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
gemini-3.1-pro-high (visible alias → gemini-pro-agent)
gemini-3.1-pro-preview (visible alias → gemini-pro-agent)
```

## After model list (picker-visible)

```
gemini-3.6-flash        (efforts: low, medium, high)
gemini-3.1-pro          (efforts: low, high)
claude-sonnet-4-6
claude-opus-4-6-thinking (efforts: low, medium, high, max)
gpt-oss-120b-medium
```

## Compatibility aliases (inbound-only, never shown in picker)

All moved to `ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES`:
```
gemini-3.6-flash-low     → gemini-3.6-flash-low     (identity, already wire)
gemini-3.6-flash-medium  → gemini-3.6-flash-medium  (identity, already wire)
gemini-3.6-flash-high    → gemini-3.6-flash-high    (identity, already wire)
gemini-3.1-pro-low       → gemini-3.1-pro-low       (identity, already wire)
gemini-pro-agent         → gemini-pro-agent          (identity, already wire)
gemini-3.1-pro-high      → gemini-pro-agent          (existing)
gemini-3.1-pro-preview   → gemini-pro-agent          (existing)
gemini-3.5-flash-extra-low → gemini-3.6-flash-low   (existing)
gemini-3.5-flash-low     → gemini-3.6-flash-medium   (existing)
gemini-3.5-flash-mid     → gemini-3.6-flash-medium   (existing)
gemini-3.5-flash-high    → gemini-3.6-flash-high     (existing)
gemini-3-flash-agent     → gemini-3.6-flash-high     (existing)
```

## Activation scenarios

- Picker shows `gemini-3.6-flash` once with effort selector [low, medium, high].
- Saved config with `gemini-3.6-flash-low` still resolves and routes correctly.
- Saved config with `gemini-3.1-pro-high` still resolves to `gemini-pro-agent`.
- `ocx models` lists collapsed entries.

## Verification

```bash
bun run typecheck
bun test tests/provider-registry-parity.test.ts
```

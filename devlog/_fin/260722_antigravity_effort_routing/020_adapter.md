# WP2 — CCA buildRequest effort resolution in google.ts

## Goal and dependency

The CCA buildRequest path resolves the user's reasoning effort to the correct wire model ID before building the CCA envelope. Depends on WP1 (effort map exists in antigravity-models.ts).

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/adapters/google.ts` | `resolveAntigravityWireModelId(parsed.modelId)` resolves only aliases | imports `resolveAntigravityEffortWireModel` instead; resolves `parsed.modelId` + `parsed.options.reasoning` → wire model ID |
| MODIFY | `src/adapters/google.ts` | `antigravityModel` = `wireModelId` (alias-resolved only) | `antigravityModel` = effort-resolved wire model ID |
| MODIFY | `src/adapters/google.ts` | `directFlashThinking` excludes `cloud-code-assist` (line 229-230) | add CCA thinkingConfig path: when `googleMode === "cloud-code-assist"` and effort is mapped, write `generationConfig.thinkingConfig = { thinkingLevel: effort }` into the flat body (which becomes `request.generationConfig.thinkingConfig` in the CCA envelope) |

## Current code path (simplified)

```typescript
// google.ts ~line 254
const wireModelId = resolveAntigravityWireModelId(parsed.modelId);
antigravityModel = wireModelId;
```

## After code path

```typescript
// google.ts ~line 254
const mapped = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
const { wireModelId, thinkingLevel } = resolveAntigravityEffortWireModel(parsed.modelId, mapped);
antigravityModel = wireModelId;
if (thinkingLevel) {
  (body as Record<string, unknown>).generationConfig = {
    ...(body as Record<string, unknown>).generationConfig as Record<string, unknown> | undefined,
    thinkingConfig: { thinkingLevel },
  };
}
```

## Suffix-ID precedence (contradiction prevention)

When a saved config carries a suffix ID (e.g. `gemini-3.6-flash-low`) AND the user explicitly sets `reasoning: "high"`:

1. `mapReasoningEffort` may still return `"high"` for the suffix ID (the suffix ID is not in `modelReasoningEfforts`, so no clamping occurs).
2. `resolveAntigravityEffortWireModel` detects the suffix ID via rule 1 and returns `{ wireModelId: "gemini-3.6-flash-low", thinkingLevel: undefined }`.
3. No `thinkingConfig` is sent — the suffix already encodes the effort.

This prevents the contradictory `model: gemini-3.6-flash-low` + `thinkingLevel: high` envelope.

## Effort clamping on mapped base models

`mapReasoningEffort` clamps to the configured ladder before reaching the resolver:

| Model | Requested | Clamped | Wire ID |
|---|---|---|---|
| `gemini-3.6-flash` | `max` | `high` (highest in ladder) | `gemini-3.6-flash-high` |
| `gemini-3.6-flash` | `ultra` | `max` → `high` (ultra→max boundary, then clamp) | `gemini-3.6-flash-high` |
| `gemini-3.1-pro` | `medium` | `low` (nearest at-or-below in [low,high]) | `gemini-3.1-pro-low` |
| `gemini-3.1-pro` | `max` | `high` (highest in ladder) | `gemini-pro-agent` |
| `claude-opus-4-6-thinking` | `max` | `max` (in ladder) | `claude-opus-4-6-thinking` + thinkingConfig |
| `claude-opus-4-6-thinking` | `ultra` | `max` (ultra→max boundary) | `claude-opus-4-6-thinking` + thinkingConfig |

## Effort resolution logic

`resolveAntigravityEffortWireModel(modelId, effort)` in antigravity-models.ts:

1. If `modelId` is a compat alias (e.g. `gemini-3.6-flash-low`), resolve through `resolveAntigravityWireModelId` — effort is already encoded in the ID, ignore the `effort` parameter.
2. If `modelId` is a base model with an effort map entry (e.g. `gemini-3.6-flash`):
   - `effort` provided and mapped → return `gemini-3.6-flash-{effort}`
   - `effort` provided but unmapped → return identity (no suffix variant exists)
   - `effort` undefined → return the default effort's wire ID (medium for flash, high for pro)
3. If `modelId` has no effort map entry (e.g. `claude-sonnet-4-6`) → return identity or alias resolution.

## Default effort per model

| Base model | Default effort | Default wire ID |
|---|---|---|
| `gemini-3.6-flash` | medium | `gemini-3.6-flash-medium` |
| `gemini-3.1-pro` | high | `gemini-pro-agent` |

Rationale: medium matches the current `defaultModel: "gemini-3.6-flash-medium"` registry default; high for pro matches the current `gemini-3.1-pro-high` → `gemini-pro-agent` visible alias being the primary pro entry.

## Interaction with replay cache

The replay cache is keyed on `(antigravityModel, sessionId)`. Since `antigravityModel` is the resolved wire ID (e.g. `gemini-3.6-flash-high`), the replay cache correctly isolates signatures per effort level. A user switching from `medium` to `high` mid-conversation gets a fresh replay cache entry — this is correct because different effort levels produce different thought signatures.

## Activation scenarios

- Request with `model: "gemini-3.6-flash"`, `reasoning: "high"` → CCA envelope `model: "gemini-3.6-flash-high"` + `request.generationConfig.thinkingConfig.thinkingLevel: "high"`.
- Request with `model: "gemini-3.6-flash"`, no reasoning → CCA envelope `model: "gemini-3.6-flash-medium"`, no thinkingConfig.
- Request with `model: "gemini-3.6-flash-low"` (saved config), `reasoning: "high"` → CCA envelope `model: "gemini-3.6-flash-low"`, NO thinkingConfig (suffix wins, contradiction prevented).
- Request with `model: "gemini-3.6-flash-low"` (saved config), no reasoning → CCA envelope `model: "gemini-3.6-flash-low"`, no thinkingConfig.
- Request with `model: "claude-opus-4-6-thinking"`, `reasoning: "high"` → CCA envelope `model: "claude-opus-4-6-thinking"` + `request.generationConfig.thinkingConfig.thinkingLevel: "high"`.
- Request with `model: "claude-opus-4-6-thinking"`, `reasoning: "max"` → CCA envelope `model: "claude-opus-4-6-thinking"` + `request.generationConfig.thinkingConfig.thinkingLevel: "max"`.
- Request with `model: "claude-opus-4-6-thinking"`, `reasoning: "ultra"` → CCA envelope `model: "claude-opus-4-6-thinking"` + `request.generationConfig.thinkingConfig.thinkingLevel: "max"` (ultra→max boundary).
- Request with `model: "claude-sonnet-4-6"`, any reasoning → CCA envelope `model: "claude-sonnet-4-6"` (no effort map, no thinkingConfig).
- Request with `model: "gemini-3.1-pro"`, `reasoning: "low"` → CCA envelope `model: "gemini-3.1-pro-low"` + `thinkingConfig.thinkingLevel: "low"`.
- Request with `model: "gemini-3.1-pro"`, `reasoning: "high"` → CCA envelope `model: "gemini-pro-agent"` + `thinkingConfig.thinkingLevel: "high"`.
- Request with `model: "gemini-3.1-pro"`, `reasoning: "medium"` → CCA envelope `model: "gemini-3.1-pro-low"` + `thinkingConfig.thinkingLevel: "low"` (clamped to nearest at-or-below).
- Request with `model: "gemini-3.6-flash"`, `reasoning: "max"` → CCA envelope `model: "gemini-3.6-flash-high"` + `thinkingConfig.thinkingLevel: "high"` (clamped to highest supported).

## Verification

```bash
bun run typecheck
bun test tests/google-antigravity-wire.test.ts tests/reasoning-effort.test.ts tests/usage-cost.test.ts tests/google-models-listing.test.ts tests/google-antigravity-replay.test.ts tests/provider-registry-parity.test.ts
```

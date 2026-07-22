# Research — CCA effort routing and model ID encoding

> Sources: codebase analysis + cxc-search external verification (Bernoulli agent)

## 1. CCA model ID encoding (codebase evidence)

The CCA backend encodes thinking level in the model ID itself. Evidence:

- `src/adapters/google.ts:229-233`: `directFlashThinking` is explicitly gated to exclude `cloud-code-assist` mode. The `thinkingConfig` parameter is only sent for direct AI-Studio Gemini, never for CCA.
- `src/providers/antigravity-models.ts`: wire model IDs are `gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-high`, `gemini-3.1-pro-low`, `gemini-pro-agent` (Gemini 3.1 Pro High).
- The comment in antigravity-models.ts states: "Single source of truth: the Antigravity `:fetchAvailableModels` backend" — these IDs come from the upstream CCA model listing.

## 2. Existing alias infrastructure

- `resolveAntigravityWireModelId(modelId)` maps picker aliases to wire IDs.
- `ANTIGRAVITY_VISIBLE_MODEL_ALIASES` maps `gemini-3.1-pro-high` → `gemini-pro-agent` and `gemini-3.1-pro-preview` → `gemini-pro-agent`.
- `ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES` maps legacy `gemini-3.5-flash-*` IDs to their `gemini-3.6-flash-*` equivalents.
- Context windows are resolved through the alias chain (`ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` includes both wire IDs and aliases).

## 3. Existing effort map infrastructure

- `src/reasoning-effort.ts` provides `mapReasoningEffort(provider, modelId, requested)` which translates Codex reasoning labels through `modelReasoningEffortMap` / `reasoningEffortMap`.
- `configuredReasoningEfforts()` returns per-model effort ladders from `modelReasoningEfforts`.
- `healMappedTiers()` merges wire map values into persisted ladders.
- The registry already supports `modelReasoningEfforts`, `modelReasoningEffortMap`, `reasoningEffortMap` fields.
- grok-4.5 uses `modelReasoningEfforts: { "grok-4.5": ["low", "medium", "high"] }` as a working example.

## 4. Replay cache model keying

- `antigravityUsesReplayCache(model)` returns `!/claude/i.test(model)` — Gemini models use the replay cache, Claude models do not.
- `applyAntigravityReplay(wireModelId, sessionId, contents)` and `observeAntigravityReplay(wireModelId, sessionId, parts)` key on `(model, sessionId)`.
- The wire model ID is already resolved before these calls (`resolveAntigravityWireModelId(parsed.modelId)` at google.ts:254), so replay keying is already correct.

## 5. Claude on Antigravity

- `claude-sonnet-4-6`: no thinking suffix, standard model.
- `claude-opus-4-6-thinking`: always-thinking, no effort granularity. The "thinking" suffix is the model identity, not an effort level.
- Replay cache is disabled for Claude (signature sanitization is inline instead).
- Context windows: sonnet 200k, opus-thinking 1M.

## 6. External verification (pending Bernoulli agent)

Claims awaiting Tier-2 source proof:
- CCA does not accept `thinkingConfig` (pending)
- Claude Opus on Antigravity has no effort control (pending)
- CLIProxyAPI effort routing pattern (pending)

## 6. External verification (Bernoulli agent, 2026-07-22)

### CCA thinkingConfig support — CONFIRMED

- CLAIM: CLIProxyAPI's Antigravity implementation writes `request.generationConfig.thinkingConfig.thinkingLevel` or `thinkingBudget` on the wire.
- SOURCE: [CLIProxyAPI Antigravity provider](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/internal/thinking/provider/antigravity/apply.go) — TIER 2
- CLAIM: CLIProxyAPI reads existing settings from the same wire location, `thinkingLevel` taking precedence over `thinkingBudget`.
- SOURCE: [CLIProxyAPI unified thinking extraction](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/internal/thinking/apply.go) — TIER 2
- CLAIM: The official agy CLI presents effort as catalog model choices ("Gemini 3.5 Flash (Low/Medium/High)") — model-ID encoding and wire `thinkingConfig` are not mutually exclusive.
- SOURCE: [Google Codelab: Antigravity CLI](https://codelabs.developers.google.com/antigravity-cli-hands-on?hl=en) — TIER 2

### Claude Opus 4.6 effort support — CONFIRMED at Anthropic API level

- CLAIM: Anthropic's Opus 4.6 API supports adjustable effort (low/medium/high/max) via `output_config.effort` with adaptive thinking.
- SOURCE: [Anthropic Extended thinking docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) — TIER 2
- SOURCE: [Anthropic Opus 4.6 announcement](https://www.anthropic.com/news/claude-opus-4-6) — TIER 2
- CLAIM: The official agy CLI exposes only one `Claude Opus 4.6 (Thinking)` entry — no effort variants in the catalog. But CLIProxyAPI translates effort for Claude on Antigravity via `thinkingConfig`.
- SOURCE: [Google Codelab: Antigravity CLI](https://codelabs.developers.google.com/antigravity-cli-hands-on?hl=en) — TIER 2

### Claude Sonnet 4.6 effort support — CONFIRMED (added post-implementation)

- CLAIM: Sonnet 4.6 supports adaptive thinking with `low/medium/high/max` effort, same as Opus 4.6.
- SOURCE: [Anthropic Adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) — TIER 2
- CLAIM: The agy CLI exposes `Claude Sonnet 4.6 (Thinking)` as a catalog entry alongside the base entry.
- SOURCE: [Google Antigravity model catalog](https://antigravity.google/docs/models) — TIER 2
- CLAIM: CLIProxyAPI applies thinkingConfig to Claude models based on capability, not suffix — works for both Sonnet and Opus.
- SOURCE: [CLIProxyAPI Antigravity applier](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/thinking/provider/antigravity/apply.go) — TIER 2
- CLAIM: CCA validates thinking configuration on the base `claude-sonnet-4-6` ID (validation error proves the config reaches the backend).
- SOURCE: [opencode-antigravity-auth issue #461](https://github.com/NoeFabris/opencode-antigravity-auth/issues/461) — TIER 2
- Implementation: `claude-sonnet-4-6` added to `ANTIGRAVITY_MODEL_EFFORTS` with `[low, medium, high, max]`; resolver generalized from Opus-only to all Claude models via `/^claude-/` prefix check. Commit `03eecc4a`.

### CLIProxyAPI routing pattern

- CLAIM: `client suffix/body effort → canonical ThinkingConfig → Antigravity request.generationConfig.thinkingConfig.{thinkingLevel|thinkingBudget}`
- SOURCE: [CLIProxyAPI suffix parser](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/internal/thinking/suffix.go) — TIER 2
- SOURCE: [CLIProxyAPI unified thinking pipeline](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/internal/thinking/apply.go) — TIER 2
- CLAIM: Claude 4.6 effort handling is implemented and tested in CLIProxyAPI (issue #1540, closed 2026-03-05).
- SOURCE: [CLIProxyAPI issue #1540](https://github.com/router-for-me/CLIProxyAPI/issues/1540) — TIER 2

### Design impact

The initial assumption that CCA does not accept `thinkingConfig` was **wrong**. CLIProxyAPI proves it works. This enables a simpler and more powerful design:

1. **Gemini**: effort → wire model ID routing (matches official agy UI pattern) + `thinkingConfig` (belt-and-suspenders, matches CLIProxyAPI).
2. **Claude Opus**: effort → `thinkingConfig` in the CCA envelope (matches CLIProxyAPI's proven pattern; Anthropic API supports low/medium/high/max).
3. **Claude Sonnet / gpt-oss**: no effort control.

## Decisions locked

1. **Picker collapse**: `gemini-3.6-flash` and `gemini-3.1-pro` become single picker entries; suffix variants move to `ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES`.
2. **Gemini effort routing**: effort → wire model ID suffix (official agy pattern). `thinkingConfig` also sent on the wire (CLIProxyAPI pattern, belt-and-suspenders).
3. **Claude Opus effort routing**: effort → `thinkingConfig.thinkingLevel` in the CCA envelope. Anthropic supports low/medium/high/max; we expose [low, medium, high, max].
4. **Default effort**: `medium` for flash (matches current default), `high` for pro (matches current visible alias).
5. **Claude Sonnet / gpt-oss**: no effort control.

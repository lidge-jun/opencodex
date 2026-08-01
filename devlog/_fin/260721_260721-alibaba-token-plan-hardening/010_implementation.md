# 010 — Implementation: Alibaba Token Plan Hardening

Date: 2026-07-21

## Changes Made

### 1. International Token Plan — Model List Expansion (10 → 15 models)

Added 5 models to `ALIBABA_INTL_TOKEN_PLAN_MODELS`:

- `qwen3.8-max-preview` — Qwen's latest 2.4T parameter model, text+image
- `kimi-k2.6` — text+image capable
- `kimi-k2.5` — text+image capable
- `glm-5.1` — text only
- `glm-5` — text only

### 2. International Token Plan — qwen3.8-max-preview Configuration

- Added to `ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS` (thinking_budget routing)
- Input modalities: `["text", "image"]`
- Context window: 983,616 (from qwencloud.com/pricing/token-plan)
- Reasoning efforts: `["low", "high", "xhigh"]` (model-specific override, NOT full `THINKING_BUDGET_EFFORTS`)
- Default reasoning effort: `"xhigh"`
- Added to `preserveReasoningContentModels`

### 3. International Token Plan — Vision Metadata Fix

- `kimi-k2.7-code`: changed from `["text"]` to `["text", "image"]`, removed from `noVisionModels`
- `kimi-k2.6`, `kimi-k2.5`: added as `["text", "image"]`
- `glm-5.1`, `glm-5`: added as text-only, added to `noVisionModels`

### 4. International Token Plan — Context Windows (comprehensive)

Added context windows for ALL models:

| Model | Context Window |
|---|---|
| qwen3.8-max-preview | 983,616 |
| qwen3.7-max | 1,000,000 |
| qwen3.7-plus | 1,000,000 |
| qwen3.6-plus | 1,000,000 |
| qwen3.6-flash | 1,000,000 |
| deepseek-v4-pro | 1,000,000 |
| deepseek-v4-flash | 1,000,000 |
| kimi-k2.7-code | 262,144 |
| kimi-k2.6 | 262,144 |
| kimi-k2.5 | 262,144 |
| glm-5.2 | 1,000,000 |
| glm-5.1 | 1,000,000 |
| glm-5 | 1,000,000 |
| MiniMax-M2.5 | 204,800 |

### 5. International Token Plan — Reasoning Metadata

`noReasoningModels` expanded:

- Added kimi-k2.6, kimi-k2.5, glm-5.1, glm-5

`preserveReasoningContentModels` expanded:

- Added qwen3.8-max-preview, qwen3.7-plus, qwen3.6-plus, qwen3.6-flash

### 6. Beijing Token Plan — Hardening

- Added `modelContextWindows` (was completely missing):
  - qwen3.8-max-preview: 983,616
  - All others: 1,000,000
- Added `noVisionModels`: glm-5.2, deepseek-v4-pro
- Expanded `preserveReasoningContentModels`: added qwen3.7-max, qwen3.7-plus, qwen3.6-flash

## Deferred Issues

### C1: `minimal` reasoning sends `thinking_budget: 0`

Cross-cutting concern across all thinking-budget providers, not Alibaba-specific.
Separate task required.

### noReasoningModels reclassification for kimi/deepseek/minimax

These models may support reasoning via wire-specific thinking control parameters
rather than the standard `thinking_budget` mechanism. Needs per-model wire
investigation before reclassifying.

## Evidence Sources

- [qwencloud.com/pricing/token-plan](https://qwencloud.com/pricing/token-plan) — qwen3.8 metadata (context window, reasoning efforts)
- [alibabacloud.com/help/en/model-studio/token-plan-overview](https://alibabacloud.com/help/en/model-studio/token-plan-overview) — international model list
- [help.aliyun.com/en/model-studio/token-plan-personal-overview](https://help.aliyun.com/en/model-studio/token-plan-personal-overview) — Beijing model list
- Sol adversarial review findings (`001_research.md`)

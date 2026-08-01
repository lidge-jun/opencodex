# Alibaba Token Plan Provider Hardening — Sol Adversarial Review

**Date:** 2026-07-21
**Phase:** Research (001)
**Scope:** Sol adversarial review of Alibaba Token Plan provider entries (International + Beijing)

---

## Summary

Sol adversarial review surfaced two critical and six important findings across the International and Beijing Token Plan provider entries. The critical issues involve runtime failures (invalid zero thinking budget) and credential-model confusion (PAYG endpoint leaking into Token Plan). The important issues cover incomplete model coverage, wrong vision metadata, missing context windows, and reasoning-model misclassification.

---

## CRITICAL Findings

### C1 — Qwen `minimal` reasoning emits invalid zero thinking budget

`thinkingBudgetForEffort()` returns `0` when effort is `minimal`. The Alibaba API requires a positive integer for the thinking budget parameter — a zero value causes a `400 invalid_parameter_error` response.

This is a cross-cutting issue: every model entry that uses `thinking_budget` shares the same code path, so the fix belongs in the shared adapter layer rather than per-provider config.

**Impact:** Runtime 400 errors for any user selecting minimal reasoning effort on a Qwen thinking model.
**Status:** DEFERRED — cross-cutting change affecting all thinking_budget models.

### C2 — PAYG endpoint mixing in International entry

The Token Plan provider entry currently exposes the PAYG endpoint as a selectable option. Token Plan and PAYG credentials are not interchangeable — using a Token Plan API key against the PAYG endpoint (or vice versa) will fail authentication.

Additionally, `dashboardUrl` links to the general API management tab rather than the Token Plan-specific management page, which could lead users to the wrong billing/quota surface.

**Impact:** Users could inadvertently select an incompatible endpoint, causing auth failures that appear as credential problems rather than configuration errors.
**Status:** DOCUMENTED — this is an architectural decision in how endpoint options are surfaced. Noted here for future provider UX work.

---

## IMPORTANT Findings

### I1 — International model list incomplete (10 of 18 official models)

The International Token Plan entry lists 10 models, but Alibaba's official documentation enumerates 18 chat-compatible models. Missing chat models that should be added:

| Model | Capabilities |
|---|---|
| `kimi-k2.6` | text + image |
| `kimi-k2.5` | text + image |
| `glm-5.1` | text only |
| `glm-5` | text only |

Also absent but **out of scope** for this hardening pass (image-generation, not chat adapter):

- `qwen-image-2.0`
- `qwen-image-2.0-pro`
- `wan2.7-image`
- `wan2.7-image-pro`

### I2 — kimi-k2.7-code vision metadata wrong

`kimi-k2.7-code` is currently marked as text-only in both `inputModalities` and the `noVisionModels` list. Alibaba's documentation confirms it supports text, image, and video input.

**Fix:** Change `inputModalities` to `["text", "image"]` and remove `kimi-k2.7-code` from `noVisionModels`.

### I3 — preserveReasoningContentModels incomplete

The `preserveReasoningContentModels` lists are incomplete on both entries:

- **International** only includes `qwen3.7-max`. Should also include `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`.
- **Beijing** omits `qwen3.7-max` and `qwen3.7-plus` entirely.

Note: Alibaba defaults `preserve_thinking` to `false` for Qwen models, meaning the adapter never sends `preserve_thinking: true` unless explicitly configured. Without the correct list, reasoning content from these models is silently discarded.

### I4 — Context windows substantially incomplete

- **Beijing** has NO `modelContextWindows` defined at all.
- **International** is missing Qwen model context windows.

Official documentation supports these values:

| Model | Context Window |
|---|---|
| `qwen3.7-max` | 1,000,000 |
| `qwen3.7-plus` | 1,000,000 |
| `qwen3.6-flash` | 1,000,000 |
| `glm-5.2` | 1,000,000 |
| `deepseek-v4-pro` | 1,000,000 |

### I5 — qwen3.8-max-preview missing from International entry

User explicitly requires this model to be added. It is available in Team Edition per newer Alibaba documentation.

**Required additions:**

- Add to model list and qwen models sub-list
- Set input modalities to `["text", "image"]`
- Add to `preserveReasoningContentModels`

### I6 — noReasoningModels conflation

Three models are currently placed in `noReasoningModels` despite being reasoning-capable:

- `kimi-k2.7-code` — has its own thinking control wire format
- `deepseek-v3.2` — has its own thinking control wire format
- `MiniMax-M2.5` — has its own thinking control wire format

Each of these models requires wire-specific thinking parameter handling rather than a blanket "no reasoning" classification. Treating them as non-reasoning models suppresses their native chain-of-thought capabilities.

**Status:** DEFERRED — needs separate architectural work to support per-model thinking wire formats beyond the current Qwen-style `thinking_budget` path.

---

## Sources

- [Beijing Personal Edition — Token Plan Overview](https://help.aliyun.com/en/model-studio/token-plan-personal-overview)
- [International Token Plan Overview](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview)
- [Qwen API (OpenAI Chat Completions)](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
- [Kimi API](https://www.alibabacloud.com/help/en/model-studio/kimi-api)
- [DeepSeek API](https://www.alibabacloud.com/help/en/model-studio/deepseek-api)

---

## Priority Matrix

| ID | Severity | Status | Scope |
|---|---|---|---|
| C1 | CRITICAL | DEFERRED | Cross-cutting (shared adapter) |
| C2 | CRITICAL | DOCUMENTED | Architectural decision |
| I1 | IMPORTANT | ACTIONABLE | International entry |
| I2 | IMPORTANT | ACTIONABLE | International entry |
| I3 | IMPORTANT | ACTIONABLE | Both entries |
| I4 | IMPORTANT | ACTIONABLE | Both entries |
| I5 | IMPORTANT | ACTIONABLE | International entry |
| I6 | IMPORTANT | DEFERRED | Architectural (per-model wire formats) |

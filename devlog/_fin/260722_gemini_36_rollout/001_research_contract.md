# Gemini 3.6 research and contract evidence

- Archive status: verified and shipped with the Gemini 3.6 rollout.

## 1. Official Google evidence

All official pages below were browser-rendered and read on 2026-07-22 because the plain HTTP reader initially returned no content.

| Claim | Evidence |
|---|---|
| GA release date and public ID | Google Gemini API release notes, 2026-07-21: Gemini 3.6 Flash GA as `gemini-3.6-flash`. https://ai.google.dev/gemini-api/docs/changelog |
| Model shape | Inputs: text, image, video, audio, PDF; output: text. Input limit 1,048,576; output limit 65,536. Thinking, function calling, code execution, caching, structured output, URL context, search/maps grounding, file search, and Computer Use Preview are supported. https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash |
| Public price | Standard paid tier: input $1.50/M, output including thinking $7.50/M, cache read $0.15/M; storage $1.00/M tokens/hour. https://ai.google.dev/gemini-api/docs/pricing |
| Family request behavior | Gemini 3.x uses `thinking_level`; the direct GenerateContent form is `generationConfig.thinkingConfig.thinkingLevel`. The Codex-facing usable levels are low, medium, and high. https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5 and https://ai.google.dev/gemini-api/docs/gemini-3 |
| Sampling parameters | 2026-07-21 release notes mark `temperature`, `top_p`, and `top_k` deprecated. No evidence says existing requests are rejected, so suppression is outside this slice. |

## 2. Authenticated Antigravity evidence

The repository's runtime owner says `:fetchAvailableModels` is the Antigravity source of truth (`src/providers/antigravity-models.ts:3-6`). A read-only authenticated probe on 2026-07-22 printed only model IDs, display names, and `maxTokens`; credentials and project identity were not printed.

### Visible 3.6 rows

| Wire ID | Display name | `maxTokens` |
|---|---|---:|
| `gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | 1,048,576 |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | 1,048,576 |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | 1,048,576 |

### Hidden/raw row

`gemini-3.6-flash-tiered` is also returned with 1,048,576 `maxTokens`, but it has no display name. It is recorded as evidence, not exposed as a picker row.

### Existing 3.5 rows and semantic mismatch

| Current wire ID | Upstream display name | Migration target |
|---|---|---|
| `gemini-3.5-flash-extra-low` | Gemini 3.5 Flash (Low) | `gemini-3.6-flash-low` |
| `gemini-3.5-flash-low` | Gemini 3.5 Flash (Medium) | `gemini-3.6-flash-medium` |
| `gemini-3-flash-agent` | Gemini 3.5 Flash (High) | `gemini-3.6-flash-high` |

The static owner currently reconstructs Mid and High with aliases (`src/providers/antigravity-models.ts:18-23`). The new backend supplies all three tiers explicitly, so those user-facing aliases are no longer needed.

## 3. Repository baseline

- Antigravity wire list, aliases, context windows, and resolver: `src/providers/antigravity-models.ts:7-53`.
- Direct Google seed and Antigravity default: `src/providers/registry.ts:637-652`.
- Google adapter currently forwards max output, temperature, top-p, and stop sequences but not selected reasoning effort: `src/adapters/google.ts:215-228`.
- Antigravity aliases are applied immediately before the CCA envelope is built: `src/adapters/google.ts:235-270`.
- OAuth preset reconciliation replaces registry-managed `models` and model metadata and heals a default that disappears from the refreshed list: `src/oauth/index.ts:382-438`.
- Antigravity 3.5 price overlays: `src/usage/expected-prices.ts:56-67`.
- Generated jawcode metadata is explicitly generated and must not be hand-edited: `scripts/generate-jawcode-metadata.ts:22-25`, `src/generated/jawcode-model-metadata.ts:1-2`.

## 4. Adjacent provider checks

### Cursor

Fresh `ocx models --json` output on 2026-07-22 contained `cursor/gemini-3.5-flash` but no Cursor Gemini 3.6 row. `src/adapters/cursor/discovery.ts:136` and Cursor tests remain out of scope until Cursor itself advertises the new model.

### OrcaRouter

The registry statically seeds `google/gemini-3.5-flash` (`src/providers/registry.ts:603-635`). The exact candidate page `https://www.orcarouter.ai/models/google/gemini-3.6-flash` returned HTTP 404 on 2026-07-22. No speculative row is added.

### jawcode metadata source

`/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/models.json` contained multiple Gemini 3.5 rows and no `gemini-3.6-flash` row when checked on 2026-07-22. The OpenCodex generated snapshot therefore stays untouched in this unit.

## 5. Open questions converted to implementation gates

- Direct Google API credentials are not configured in the current daemon, so direct live inference is not a completion requirement unless a credential is available at C. Official contract proof plus request-shape tests are required regardless.
- Antigravity's `tiered` row remains hidden until it gains a display name or a separate user-visible contract. Its mere presence is not enough to invent picker semantics.
- Vertex remains frozen until Vertex-specific model availability is proven. Gemini Developer API GA does not establish Vertex publisher support.

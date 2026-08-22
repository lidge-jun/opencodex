# 001 — Catalog capability evidence never reaches routing

Research document. No diffs here; the fix design is `010_catalog_row_shape.md`.

## Symptom that started this

`lidge/qwen3.8-27b-nvfp4` was registered through the supported CLI:

```
$ ocx models add lidge qwen3.8-27b-nvfp4 --context-window 262144 --modalities text,image
Error: custom model "lidge/qwen3.8-27b-nvfp4" already exists
```

The row was already present and complete in `~/.opencodex/config.json`:

```json
{ "id": "83ca0b4c-06bb-475d-b585-6c47b9d6be71", "provider": "lidge",
  "modelId": "qwen3.8-27b-nvfp4", "displayName": "Qwen3.8 27B NVFP4 (lidge 5090)",
  "contextWindow": 262144, "inputModalities": ["text", "image"] }
```

It also reached the on-disk Codex catalog correctly, as
`/Users/jun/.codex/opencodex-catalog.json`:

```json
{ "slug": "lidge/qwen3.8-27b-nvfp4", "context_window": 262144,
  "input_modalities": ["text", "image"], "supports_parallel_tool_calls": true }
```

Yet routing evidence carried neither value. NOTE (audit round 1, B9): this
one-liner reproduces only with the provider's `modelContextWindows` and
`modelInputModalities` ABSENT. They were added by hand later while
diagnosing, so on today's live config the earlier branches win and the
symptom is masked. The 17-to-0 catalog proof below is independent of that
and still reproduces exactly. Use a catalog-only fixture to reproduce:

```
candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4")
=> { tools: true, serviceTier: "unsupported", encryptedCodexTasks: false }
```

No `image`. No `contextWindow`. A model registered through the documented
path is image-blind to the router.

## Root cause: reader and writer disagree on field shape

`src/routing/capability.ts` `cachedCatalogModels()` filters rows with:

```ts
typeof model.id === "string" && typeof model.provider === "string"
```

and then reads `model.contextWindow` / `model.inputModalities`.

The catalog file has none of those four fields. Its actual keys are
`slug` (a combined `provider/id`), `context_window`, and `input_modalities`.
Verified against the live file:

```
KEYS: slug,display_name,description,default_reasoning_level,
supported_reasoning_levels,...,input_modalities,...,context_window,
max_context_window,auto_compact_token_limit,...
provider? undefined   id? undefined   context_window? 262144
```

So the filter rejects every row:

```
TOTAL: 17 | SURVIVING capability.ts filter: 0
```

**This is not a local-model bug.** All 17 rows are discarded — native OpenAI
rows, `anthropic/claude-opus-5`, `xai/grok-4.6`, everything. The whole
`catalogRow` branch of the evidence chain is dead code in practice.

## Why nobody noticed

The catalog is the *fourth* fallback. For a provider with populated config
maps the earlier branches answer first:

```
provider.modelContextWindows[id] ?? provider.contextWindow
  ?? registryEntry.modelContextWindows[id] ?? catalogRow.contextWindow ?? ...
```

`kimi`, `anthropic`, `xai`, and `alibaba-token-plan-intl` all declare
`modelContextWindows` and `modelInputModalities` inline, so their evidence
looks correct and the dead branch stays invisible. Only a provider that
relies on the catalog — exactly what `ocx models add` produces — is exposed.

Confirmed by contrast on the same tree:

```
xai/grok-4.6              => contextWindow 500000, image true   (provider maps)
anthropic/claude-opus-5   => contextWindow 1000000, no image    (provider maps)
lidge/qwen3.8-27b-nvfp4   => nothing                            (catalog only)
```

`claude-opus-5` is itself a smaller instance of the same hole: the provider
block declares `modelContextWindows` but no `modelInputModalities`, and the
catalog that could have supplied `image` is discarded.

## Why the test suite is green

`tests/routing-profile.test.ts` and `tests/routing-compatibility.test.ts`
construct `capability` objects inline:

```ts
{ provider: "a", model: "m1", capability: { contextWindow: 200000, tools: true } }
```

They exercise the *policy evaluator* with pre-made evidence and never call
`candidateCapabilityEvidence`, so no test ever reads a real catalog file.
The assembly step between the catalog on disk and the evaluator is untested.
That is the coverage gap this unit closes, and it is why "all tests green"
said nothing about this defect.

## Field-chain note (PLAN-FIELD-CHAIN-01)

The chain for a custom model is:

| Stage | Path | State |
|-------|------|-------|
| creation | `src/cli/models.ts` `ocx models add` | works |
| serialization | `config.customModels[]` -> `src/codex/catalog/provider-fetch.ts:1758` | works |
| on-disk form | `~/.codex/opencodex-catalog.json` (`slug`, `context_window`, `input_modalities`) | works |
| consumer | `src/routing/capability.ts` `cachedCatalogModels()` | **broken — expects `provider`/`id`/`contextWindow`/`inputModalities`** |

Only the last stage is wrong, which is why the value is visible everywhere a
human looks (config, CLI, catalog file) and absent exactly where routing
decides.

## Post-audit correction (round 1)

The fix originally proposed here — read `context_window` and
`input_modalities` straight off the row — is WRONG and was rejected in
audit. `ensureStrictCatalogFields()` synthesizes both fields for Codex's
strict parser, so reading them would convert unknown into `image:false`
and a fabricated `128000`. See `003_audit_synthesis_round1.md` B2 and the
provenance design in `010_catalog_row_shape.md`.

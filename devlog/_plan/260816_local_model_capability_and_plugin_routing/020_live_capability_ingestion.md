# 020 — Phase 2: absorb llama.cpp capability metadata from live discovery

Diff-level implementation doc. Depends on Phase 1 (`010_catalog_row_shape.md`):
without it, anything this phase writes into the catalog is still discarded by
the reader.

## Goal

A local llama.cpp server that truthfully advertises multimodality and its
trained context length should produce correct routing evidence with no manual
config. Today it does not, because two upstream spellings are unrecognized.

## Observed payload (verbatim)

`GET http://100.100.125.116:8081/v1/models` on the `lidge` provider returns a
dual-shape body — an Ollama-style `models[]` plus an OpenAI-style `data[]`:

```json
{ "models": [ { "name": "qwen3.8-27b-nvfp4", "model": "qwen3.8-27b-nvfp4",
                "capabilities": ["completion", "multimodal"],
                "details": { "format": "gguf", "family": "" } } ],
  "object": "list",
  "data": [ { "id": "qwen3.8-27b-nvfp4", "object": "model", "owned_by": "llamacpp",
              "meta": { "n_ctx": 262144, "n_ctx_train": 262144,
                        "n_vocab": 248320, "n_embd": 5120,
                        "n_params": 27320698192, "size": 16367838528 } } ] }
```

## Why both signals are dropped today

`src/codex/catalog/provider-fetch.ts`:

1. `modelInputModalities()` recognizes explicit `input_modalities`/`modalities`
   lists, an `architecture.modality` arrow form, `capabilities.vision`, and
   the capability strings `vision` / `image-input` / `image_input`. The token
   `"multimodal"` is in none of those sets, so the row yields `undefined`.
2. `catalogHintsFromModelsApiItem()` reads context from
   `limits.max_context_length`, `metadata.context_length`, `context_length`,
   `context_size`, `max_model_len`, and `max_context_length`. llama.cpp's
   `meta.n_ctx` is in none of those, so context stays unknown.

## Scope boundary

IN: `src/codex/catalog/provider-fetch.ts` (the two readers above), one focused
test using the verbatim payload.
OUT: the closed `text|image|audio` enum (must not widen — Codex rejects the
whole catalog file on an unknown modality), the dual `models[]`/`data[]`
merge behavior, and any other provider's parsing.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/codex/catalog/provider-fetch.ts` | MODIFY | Accept `multimodal` as an image signal; read `meta.n_ctx` as a context source |
| `tests/catalog-llamacpp-capabilities.test.ts` | NEW | Drives the verbatim payload above |

## MODIFY 1 — `modelInputModalities()`

Before:

```ts
  if (capabilityRecord?.vision === true || capabilities?.some(value => (
    value === "vision" || value === "image-input" || value === "image_input"
  ))) {
    return ["text", "image"];
  }
```

After:

```ts
  if (capabilityRecord?.vision === true || capabilities?.some(value => (
    value === "vision" || value === "image-input" || value === "image_input"
    // llama.cpp / Ollama-compatible servers report vision as "multimodal" in
    // their capability list; it is the only image signal those servers emit.
    || value === "multimodal"
  ))) {
    return ["text", "image"];
  }
```

The returned value stays `["text", "image"]` — inside the closed enum, so the
catalog-rejection hazard noted in the existing comment is untouched.

Ordering note: the explicit-list branch and the `vision === false` branch both
run BEFORE this one, so a server that says `vision: false` or lists exact
modalities still wins. `multimodal` is a last-resort inference, consistent
with how the existing capability strings are treated.

## MODIFY 2 — `catalogHintsFromModelsApiItem()` context source

Before:

```ts
  const limits = plainRecord(metadata?.limits);
  const contextWindow =
    positiveSafeInteger(
      limits?.max_context_length,
      metadata?.context_length,
      item.context_length,
      item.context_size,
      item.max_model_len,
      item.max_context_length,
    );
```

After:

```ts
  const limits = plainRecord(metadata?.limits);
  // llama.cpp reports the served context under `meta`: `n_ctx` is the context
  // the server was actually started with, `n_ctx_train` the model's trained
  // maximum. Prefer the served value — routing must not promise a window the
  // running server will refuse.
  const meta = plainRecord(item.meta);
  const contextWindow =
    positiveSafeInteger(
      limits?.max_context_length,
      metadata?.context_length,
      item.context_length,
      item.context_size,
      item.max_model_len,
      item.max_context_length,
      meta?.n_ctx,
      meta?.n_ctx_train,
    );
```

`meta` entries are appended LAST so no existing provider's precedence changes:
a server that already supplies a recognized field keeps winning.

### Type surface

`ProviderModelsApiItem` needs a `meta?: unknown` member (read through
`plainRecord`, so no structural typing of llama.cpp internals leaks in). B
confirms the exact declaration site and amends this doc if the type is
expressed as an index signature that already permits it.

## NEW `tests/catalog-llamacpp-capabilities.test.ts`

```ts
test("absorbs multimodal capability and meta.n_ctx from a llama.cpp models item", () => {
  const hints = catalogHintsFromModelsApiItem("lidge", {
    id: "qwen3.8-27b-nvfp4",
    object: "model",
    owned_by: "llamacpp",
    capabilities: ["completion", "multimodal"],
    meta: { n_ctx: 262144, n_ctx_train: 262144 },
  });
  expect(hints.inputModalities).toEqual(["text", "image"]);
  expect(hints.contextWindow).toBe(262144);
});

test("an explicit vision:false still beats the multimodal inference", () => {
  const hints = catalogHintsFromModelsApiItem("lidge", {
    id: "text-only",
    capabilities: { vision: false },
  });
  expect(hints.inputModalities).toEqual(["text"]);
});

test("prefers the served n_ctx over the trained maximum", () => {
  const hints = catalogHintsFromModelsApiItem("lidge", {
    id: "short-ctx",
    meta: { n_ctx: 8192, n_ctx_train: 262144 },
  });
  expect(hints.contextWindow).toBe(8192);
});
```

The third case is the activation scenario for the precedence comment — without
it the ordering claim is untested prose.

## Accept criteria

1. All three tests fail before the change and pass after (activation grounding).
2. `bun x tsc --noEmit` clean.
3. No existing catalog test regresses — this file is shared by every provider,
   so the full suite runs via `ssh lidge`.
4. The modality enum stays closed to `text|image|audio`.

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `bun test tests/catalog-llamacpp-capabilities.test.ts` | YES — direct argument | New file |
| `bun test` (via `ssh lidge`) | YES — `provider-fetch.ts` is exercised by the existing catalog suites | Required: shared surface |
| `bun x tsc --noEmit` | YES — `src/**` in `tsconfig.json` include | |

## Bypass record (PLAN-BYPASS-NAMED-01)

No enforcement added. Tier: N/A. Executing surface: none. Known bypass: a
provider that reports neither a recognized modality token nor a recognized
context field still yields unknown evidence — by design, per "unknown is not
zero". Residual risk: `multimodal` is a heuristic; a server using it to mean
"audio + text" would be mislabeled as image-capable. Wording downgrade: this
is called an inference, not detection. Final enforcement layer: none.

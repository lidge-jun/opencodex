# 160.02 — Grok Image/Video Models & the Registry Gap

> Request: "grok에는 이미지랑 비디오 모델까지 지금 레지스트리에 on으로 되어있잖아 이거에 대해서".
> This doc records **what the code actually contains today** so we don't build on a false premise.
> Fail-fast: the request and the current code do **not** line up — that mismatch is the point.

## What the registry actually has for Grok (`xai`)

`src/providers/registry.ts:41-54`:

```ts
{
  id: "xai", label: "xAI Grok", adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1", authKind: "oauth", oauthId: "xai",
  models: ["grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
           "grok-build-0.1", "grok-composer-2.5-fast"],
  defaultModel: "grok-4.3",
  noReasoningModels: ["grok-build-0.1", "grok-composer-2.5-fast"],
  noVisionModels:    ["grok-build-0.1", "grok-composer-2.5-fast"],
}
```

These are all **text chat** models (some vision-capable as **input**). There is **no
image-generation and no video-generation model** here. The only modality concept is
`noVisionModels` — i.e. "can this chat model accept image **input**", not "does it generate
image/video **output**".

## What the metadata schema supports (`src/generated/jawcode-model-metadata.ts`)

```ts
export interface JawcodeModelMetadata {
  provider: string; id: string;
  contextWindow?: number; maxTokens?: number;
  input?: ("text" | "image")[];   // <-- the ONLY modality field; INPUT only
  reasoning?: boolean; wireModelId?: string;
}
```

- `input` is the only modality field, and its type is literally `("text" | "image")[]`.
- There is **no `video`** in the union, and **no `output` modality** at all.
- xai rows (generated, line 35) confirm this: `grok-2-vision` → `text,image`; `grok-4.3`,
  `grok-4-fast`, `grok-build-0.1` → `text,image`; older `grok-3` → `text`. These flag
  **vision input**, not image/video generation.
- `grep -rn "video" src` → **0 matches**. "Video" does not exist anywhere in the codebase.

## The gap (request vs reality)

| The request implies | The code today |
|---------------------|----------------|
| Grok has **image** models on | Only image **input** (vision) on some chat models; no image-gen model |
| Grok has **video** models on | No `video` modality exists anywhere; no video-gen model |
| It's "on **in the registry**" | `registry.ts` has only text/vision chat models for xai |
| The dashboard should show it | `/api/models` returns no modality at all (`src/server.ts:419-426`); GUI shows id only |

So nothing surfaces "image/video models" today because (1) those models aren't in the
registry, (2) the schema has no output-modality / video concept, and (3) even the vision
input that *is* known is never sent to the GUI.

## Interpretation options (pick one — Open Q1 in 00)

- **(A) Surfacing only — vision/capability badges.** Take the modality/context/reasoning that
  metadata *already* has, expose it through `/api/models`, and render capability badges in the
  redesigned Models/Dashboard rows. No new models, no schema change beyond plumbing.
  → Smallest, safe, C2–C3. Matches what the code actually supports.
- **(B) Add real image/video generation models.** Introduce an `output`/generation modality
  (and a `video` value), add the Grok image/video gen models + endpoints to the registry,
  teach an adapter to call them, regenerate metadata, then surface in the GUI.
  → Largest. Touches a **generated metadata contract + adapters + server + GUI** = C3 leaning
  C4 on the schema/contract slice (dev §0.0 DEV-ESCALATE-01: public/generated contract change).
  Needs its own phase doc and verification; **confirm the actual Grok model ids/endpoints first.**
- **(C) "Registry" means something else.** The user may mean an upstream/jawcode bundle or the
  `xai` metadata list, not `registry.ts`. If so, point us at the exact source and we reconcile.

## If (B): where changes would land (for planning only — not yet approved)

- `src/generated/jawcode-model-metadata.ts` — schema: add `video` to modality union and/or an
  `output`/`kind` field. **Generated file** → change the generator
  `scripts/generate-jawcode-metadata.ts`, not the output by hand (`:1-2` says "Do not edit").
- `src/providers/registry.ts` — add the image/video gen model ids (and possibly a separate
  adapter/baseUrl if endpoints differ from `/v1` chat).
- `src/server.ts` `/api/models` (`:419-426`) — include modality/kind in the response.
- `gui/src/pages/{Models,Dashboard}.tsx` + `ModelRow`/`ModelInfo` types — render capability.
- Tests: `tests/codex-catalog.test.ts`, `tests/codex-inject.test.ts` cover catalog/metadata; add
  cases for the new modality so routing/catalog stay correct.

## Verification anchors (current behavior, for regression awareness)

- `tests/codex-inject.test.ts` builds the provider table block from the catalog — any new
  modality must not break the existing injected table.
- `Models.tsx` `ModelRow = { provider, id, namespaced, disabled }` (`:5`) — extend, don't break.

## Recommendation

Default to **(A)** unless the user confirms (B): (A) is honest to the current code, ships with
the redesign, and is the prerequisite UI even if (B) follows later. Treat (B) as a separate
`20_*` phase gated on confirmed Grok image/video model ids + endpoints. **Confirm Q1 before
writing either phase doc.**

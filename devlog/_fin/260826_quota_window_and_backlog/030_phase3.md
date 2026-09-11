# 030 — wp3: #2406 CommandCode image capabilities

## The gap

CommandCode's registry entries declare `modelInputModalities` for exactly two ids —
`stealth/ox-alpha` and the DeepSeek vision preview — in BOTH the OAuth preset
([registry.ts:1183](../../../src/providers/registry.ts)) and the API-key preset
([registry.ts:1925](../../../src/providers/registry.ts)). Every other CommandCode model is
therefore text-only in the generated Codex catalog.

This is not cosmetic. Combo capability intersection treats an absent declaration as text-only,
so a single unmarked target disables image input for the entire combo.

## What the reporter proved, and what they disproved

The issue carries end-to-end image probes, and it is careful in both directions. Image input
**succeeded** for:

`gpt-5.6-luna`, `gpt-5.6-sol`, `MiniMaxAI/MiniMax-M3`, `moonshotai/Kimi-K3`,
`meta/muse-spark-1.2`, `meta/muse-spark-1.2-contributor`, `openai/ox-alpha`,
`deepseek/deepseek-v4-flash-vision-exp`

Image input did **not** deliver for `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`,
`zai-org/GLM-5.2`, `zai-org/GLM-5.3`, `xai/grok-4.6`.

**The negative list is as load-bearing as the positive one.** Marking a route image-capable
that silently drops the image is worse than leaving it text-only: the request succeeds, the
model answers about an image it never received, and nothing surfaces an error. This phase adds
only the verified-positive ids.

Note `openai/ox-alpha` versus the already-present `stealth/ox-alpha` — the catalog serves the
same model under two ids and only one carries the declaration.

## MODIFY map

### `src/providers/registry.ts` — both presets, identical content

Extract the shared map to a named constant rather than duplicating a growing literal twice.
The current two-entry duplication is already a drift hazard; at ten entries it is a certainty.

```ts
/**
 * CommandCode routes verified to accept image input end-to-end (#2406).
 *
 * Verified-negative and therefore deliberately ABSENT: deepseek-v4-flash, deepseek-v4-pro,
 * GLM-5.2, GLM-5.3, grok-4.6. Those routes accept the request and drop the image, which is
 * worse than declining it — the model answers about an image it never saw. Do not add an id
 * here on family resemblance; capability intersection trusts this map.
 */
const COMMAND_CODE_IMAGE_MODELS = [
  "stealth/ox-alpha",
  "openai/ox-alpha",
  `deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`,
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "MiniMaxAI/MiniMax-M3",
  "moonshotai/Kimi-K3",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
] as const;

const COMMAND_CODE_MODEL_INPUT_MODALITIES: Record<string, ["text", "image"]> =
  Object.fromEntries(COMMAND_CODE_IMAGE_MODELS.map(id => [id, ["text", "image"]]));
```

Both presets then reference `COMMAND_CODE_MODEL_INPUT_MODALITIES`, replacing their inline
literals. Placement: next to `COMMAND_CODE_MODEL_REASONING_EFFORTS`, which solves the same
shared-facts problem the same way.

## TESTS — `tests/command-code-provider.test.ts`

| Case | Assertion |
|---|---|
| Every verified id is image-capable | each id in the positive list resolves to `["text","image"]` in BOTH presets |
| Verified-negative ids stay text-only | full upstream ids only (audit B5): `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `zai-org/GLM-5.2`, `zai-org/GLM-5.3`, `xai/grok-4.6` carry no image modality |
| Preset parity | OAuth and API-key modality maps are deeply equal |

The parity assertion is what makes the shared constant enforceable rather than merely tidy.

## Verification (C)

```bash
bun test tests/command-code-provider.test.ts
bun x tsc --noEmit
```

Registry facts are static data, so the focused suite plus typecheck is proportionate; a
repo-wide run is not required for a data-only change (AGENTS.md scoped-check rule).

Closes #2406.


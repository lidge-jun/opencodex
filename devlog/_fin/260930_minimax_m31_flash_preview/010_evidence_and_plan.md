# 010 Evidence and diff-level plan

## Sources (read 2026-09-30)

- `platform.minimax.io/docs/guides/text-generation` and the CN mirror `platform.minimaxi.com/docs/guides/text-generation`: model id `MiniMax-M3.1-Flash-Preview`, context window 1,000,000, multimodal chat input, "available only through Token Plan and MiniMax Code for now". Thinking is always on; `effort` accepts `low | medium | high | xhigh | max`; an omitted effort defaults to `max`. `thinking: {"type":"disabled"}` or `effort: "none"` returns 400 `requires adaptive thinking`. On the OpenAI-compatible protocol thinking is always returned in `reasoning_content`.
- `agent.minimax.io/tools/m3-1-flash-preview`: text, image and video input, text output; prompt caching supported.
- Pricing: `platform.minimax.io/docs/guides/pricing-paygo` and the enterprise tab of `/subscribe/token-plan` list only MiniMax-M3 and M2.7 rows. `/docs/guides/pricing-token-plan`: Plus $22, Max $55, Ultra $132 per month (the `/subscribe/token-plan` comparison table shows $20/$50/$120, the annual-billing rate); Credits 1,000 = $1 charged at the resource's pay-as-you-go list price. No per-token list price exists for M3.1-Flash-Preview. OrcaRouter's 2026-09-27 write-up reaches the same conclusion. The public guide links the pricing page instead of restating plan prices (CodeRabbit on #6304).

## Live probe (jun-macbookpro, configured `minimax` key, `https://api.minimax.io/v1`)

| Request | Result |
|---|---|
| `GET /v1/models` | 200; lists M3/M2.7/M2.5/M2.1/M2 only (the preview is not enumerated) |
| chat, no effort | 200, `reasoning_content` present |
| chat, `reasoning_effort` low / medium / high / xhigh / max | 200 each |
| chat, `reasoning_effort: "none"` | 400, code 2013, "reasoning effort none is not allowed" |
| chat, `thinking: {"type":"disabled"}` | 400, code 2013 |
| `reasoning_split: true`, stream and non-stream | 200; deltas carry `reasoning_content`; no `reasoning_details` at all |
| tool round with `reasoning_content` replay | 200 |
| tool round with `reasoning_details` replay | 200 |
| low-effort tool call | 200 with no reasoning; the next round without replayed reasoning is accepted |

## Decisions

1. Add the id to `MINIMAX_MODELS` (both presets share it) with a 1,000,000 window. Keep `MiniMax-M3` as the default model: the preview only answers to Token Plan keys, and the presets also accept pay-as-you-go keys.
2. Efforts `low..max`, default `max` (the vendor default when the field is omitted). No effort map and no `thinkingToggleModels` entry: identity labels go out as `reasoning_effort`, `minimal` clamps to `low`, `ultra` becomes `max`, and `none` omits the field, so the wire can never carry a disabled-thinking value.
3. Keep it on `preserveReasoningContentModels` (replay as `reasoning_content`, probed OK) but off `reasoningSplitModels` and `reasoningDetailsModels`: it ignores `reasoning_split` and never emits `reasoning_details`. `requiresReasoningPlaceholderModels` stays `[]` because low-effort tool rounds legitimately carry no reasoning.
4. Pricing: add metadata rows (context, modalities, reasoning) for `minimax` and `minimax-cn` with no cost. The expected-price overlay only registers verified list prices, and none is published, so usage for this model reports unpriced instead of a guessed number. The providers guide states the Token Plan-only availability and the absent list price.

## Diff

- `src/providers/registry/model-seeds.ts`: `MINIMAX_M31_FLASH_PREVIEW`, extend `MINIMAX_MODELS` and the window map, `MINIMAX_REASONING_SPLIT_MODELS` (all but the preview).
- `src/providers/registry/entries-extended.ts`: both presets get the efforts/default for the preview and use the split list for `reasoningSplitModels` / `reasoningDetailsModels`.
- `scripts/model-metadata.source.json` + regenerated `src/generated/model-metadata.ts`.
- `tests/providers/provider-registry-parity.test.ts`: registry contract for both presets.
- `tests/providers/minimax-reasoning-split.test.ts`: wire test for the preview (effort passthrough, none/minimal never disable thinking, no `reasoning_split`, replay as `reasoning_content`).
- `docs-site/src/content/docs/guides/providers.md`: availability and pricing note.

## Verification

`bun run typecheck`; the two test files above plus `tests/codex-integration/model-metadata-sync.test.ts`, `tests/codex-integration/codex-catalog.test.ts`, `tests/codex-integration/reasoning-metadata.test.ts`, `tests/usage/usage-cost.test.ts`; `bun run test:changed`; `bun run privacy:scan`; `bun run structure:check`. Then exact-head CI on the PR and merge.


## Audit round 1 fold (reviewer FAIL, one blocker)

Blocker: `GET /v1/models` omits the preview, and `mergeConfiguredModelsIntoLiveCatalog` (`src/codex/catalog/model-visibility.ts`) drops a configured id the live roster omits unless `shouldRetainConfiguredProviderModel` keeps it. Separately, saved configs carry a full copy of the old `models` list (confirmed on jun-macbookpro: exactly the eight pre-change ids), and `enrichProviderFromRegistry` never rewrites a present list, so the id never reaches existing installs.

Fold:

5. `src/codex/catalog/model-hints.ts`: add `minimax` and `minimax-cn` entries holding `MiniMax-M3.1-Flash-Preview` to `CALLABLE_CONFIGURED_COMPATIBILITY_MODELS` (the Kimi/xAI/CodeBuddy pattern).
6. New `src/providers/stale-model-roster-migration.ts`, wired into `projectStartupConfigRepairs` in `src/providers/model-rename-startup.ts` beside the context-window and vision repairs. Same restraint: on a provider that still carries the registry adapter, replace a saved `models` list only when it is byte-for-byte the previous registry seed (the eight ids, same order); a hand-edited list is left alone. When the list is refreshed, fill `modelContextWindows` and `modelDefaultReasoningEfforts` for the added id only when that key is absent. Test in `tests/providers/model-roster-seed-repair.test.ts` (registered in `layout.json` and `test-layout-expected.json`), plus a catalog test that mocks a `/models` roster omitting the preview and asserts the row survives. `structure/providers-and-adapters.md` gets the paragraph beside the vision/context repair text.
7. Parity test: exclude the preview from the 204,800 loop, update the exact list assertions.

Verification adds the two new tests and `tests/providers/context-window-seed-repair.test.ts`, `tests/providers/vision-classification-seed-repair.test.ts`.

# wp2 — V2.6 catalog facts (diff-level)

Loop-spec: C3 (registry data, vendored metadata snapshot, one registry field on two presets; no runtime logic).
Write scope: files below. Budget: one cycle.

## Changes

1. `scripts/model-metadata.source.json`: add V2.6 rows only to bundles the generator reads
   (`allowedProviders` = derived aliases ∪ `COST_VENDOR_BUNDLES`, `scripts/generate-model-metadata.ts:42-53`), copied
   from models.dev (2026-09-23) in the neighbouring V2.5 row shape, `input` limited to `text`/`image`:
   - `xiaomi` (vendor price bundle): `mimo-v2.6-pro` 1,048,576/131,072 image 0.435/0.87/0.0036;
     `mimo-v2.6-pro-ultraspeed` 4.35/8.7/0.036; `mimo-v2.6-flash` 0.14/0.28/0.0028.
   - `openrouter`: `xiaomi/mimo-v2.6-{pro,pro-ultraspeed,flash}` (same prices).
   - `opencode-go`: `mimo-v2.6-pro` (cacheRead 0.003625), `mimo-v2.6-flash`; `input: ["text"]` until the route is probed.
   Not added: kilo/nano-gpt/vercel/opencode(Zen) — unmapped bundles, rows would be inert.
   Regenerate `src/generated/model-metadata.ts` (`bun scripts/generate-model-metadata.ts`).
2. `src/providers/registry/entries-extended.ts`:
   - `xiaomi` and `xiaomi-mimo`: `jawcodeBundle: "xiaomi"` so first-party presets read context/output/modalities/price
     from the vendor bundle. Chain: `deriveJawcodeAliases` (`src/providers/derive.ts:629`) → generator alias map (regenerated)
     → `resolveMetadataProvider` → `model-hints.ts` and `cost.ts`. Token plan (`mimo`) stays unmapped: no plan-specific facts are
     claimed, and its estimates keep coming from the model-level vendor fallback (pay-as-you-go equivalent), as for V2.5.
   - `xiaomi`: `defaultModel: "mimo-v2.6-pro"`.
   - `xiaomi-mimo`: `defaultModel: "mimo-v2.6-flash"`,
     `models: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5"]`.
   - `mimo` (token plan, roster per models.dev `xiaomi-token-plan-*`): `defaultModel: "mimo-v2.6-pro"`,
     `models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]`; `noVisionModels` unchanged.
   - Comments record the 2026-10-21 V2.5 deprecation.
3. `src/providers/registry/model-seeds.ts`:
   - `OPENCODE_GO_THINKING_TOGGLE_MODELS` += `mimo-v2.6-pro`, `mimo-v2.6-flash` (vendor toggle family; preemptive, commented).
   - `CLINE_PASS_MODELS` += `cline-pass/mimo-v2.6-pro`, `cline-pass/mimo-v2.6-flash` ahead of V2.5; context 1,048,576;
     image support unverified on the route → not in `CLINE_PASS_IMAGE_MODELS`.
4. Saved configs: registry seeds change only defaults for new providers; a persisted `defaultModel`/`models` is not rewritten.

## Tests

- `tests/codex-integration/model-metadata-sync.test.ts` (regeneration byte-equal).
- `tests/usage/usage-cost.test.ts`: priced estimates for `xiaomi-mimo`/`mimo-v2.6-flash`, `openrouter`/`xiaomi/mimo-v2.6-pro`,
  `command-code`/`xiaomi/mimo-v2.6-pro` (vendor-prefix fallback) — null before.
- Catalog hint test: `xiaomi-mimo`/`mimo-v2.6-flash` resolves 1,048,576 context and image input; `xiaomi`/`mimo-v2.5-pro` text-only.
- `tests/providers/mimo-token-plan-provider.test.ts`: defaults/rosters for the three presets; a saved `defaultModel: "mimo-v2.5"` survives.
- Existing Cline Pass / Go / alias / preset-count tests found by rg; update counts by derivation, not by restating numbers.

## Reflection (B auditor, MISALIGNED → folded)

Unmapped bundles, models.dev key names, Go cacheRead 0.003625, zero-price rows returning null, Zen image evidence,
and the missing Chat ultraspeed id were folded above. B-CAT-04 rejection confirmed sound.

## Audit fold (gpt-6-sol 01a0cca0, NEAR-PASS)

- OpenCode Go V2.6 image capability is unverified on that route: its metadata rows carry `input: ["text"]` and both ids join
  the Go `noVisionModels` list (`entries-core.ts:876`) so images go through the sidecar; a route probe is a follow-up.
- The exact alias map in `tests/providers/provider-registry-parity.test.ts` gains `xiaomi` and `xiaomi-mimo` → `xiaomi`.
- New catalog-hint cases go to a sibling test file registered in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json` (`codex-catalog.test.ts` is ~11 lines under its cap).
- Saved `defaultModel`/`models` survive enrichment (`src/providers/derive.ts:523`); no MiMo rename rule exists.

## Re-audit (gpt-6-sol 01a0cca0: 010 NEAR-PASS, 020 PASS)

Residual accepted for Go vision: a persisted Go `noVisionModels` list is filled all-or-nothing (`src/providers/derive.ts:551`), so
an existing config does not learn the V2.6 entries. With V2.6 metadata text-only, the catalog advertises text-only for those
rows and the app blocks image attachment instead of sending an image the route may reject; new configs get the sidecar.
A guarded list repair would apply to every provider's all-or-nothing lists and is a separate unit. No opencode-go key is
configured locally, so the route probe that would settle native image support stays a follow-up.

# Anthropic output caps by model id

The Anthropic adapter decides an omitted `max_tokens` (Codex never sends `max_output_tokens`) from the
routed row's `modelMaxOutputTokens` entry for the model, then its `defaultMaxOutputTokens`, then its own
8192 fallback (`src/adapters/anthropic.ts`). Registry rows seed those fields by name, so before #8525 a
custom-named `adapter: "anthropic"` row, or a registry row that seeds no cap, fell back to 8192 even for a
Claude model documented at 64K-128K.

`src/providers/anthropic-output-caps.ts` fills the routed copy in both branches of `routedProviderConfig`
(`src/providers/routed-config.ts`) by Claude model id instead of row name. Precedence, highest first: an
operator per-model entry; any provider default, operator-set or registry-seeded — a row carrying one gets
nothing filled, so `anthropic`, `anthropic2` and `anthropic-apikey` resolve exactly as before; the registry
cap of a seeded Claude id (`ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS`, else `ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS`),
matched case-insensitively; the 64000 Anthropic default when the destination host is `api.anthropic.com`;
the adapter's 8192. A gateway id the registry does not list (a vendor namespace, a dated suffix, a
non-Claude model) keeps 8192.

The fill is runtime-only and never persisted, so it cannot follow a row that is later retargeted. A row that
reaches the Anthropic wire only through a per-model `modelAdapters` switch is not filled, because the routed
row's adapter differs. The routed values also feed Lab behavior reports and the declared-output ceiling.
`tests/adapters/anthropic/anthropic-output-cap-by-model.test.ts` pins the precedence, the seeded rows and
the unknown-id fallback.

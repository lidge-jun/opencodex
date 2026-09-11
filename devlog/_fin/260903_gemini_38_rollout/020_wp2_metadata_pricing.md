# 020 — wp2: metadata, pricing, and config migration

Depends on wp1: every key below is the picker id or the wire ids wp1 introduces.

## The trap this phase exists to avoid

`resolveMatchedPriceExact()` (`src/usage/cost.ts:247-258`) returns bundled generated metadata
with `status: "verified"` **before** it consults the expected-price overlay. So if the new
`scripts/model-metadata.source.json` row copies its 3.6 neighbour and includes a `cost` block,
the `google-antigravity` `verified-derived` row below becomes unreachable and CCA cost is
reported as `verified` — asserting exactly the billing equivalence `001` says is NOT PROVEN.

**The generated `google/gemini-3.8-flash` record must omit `cost`.** The 3.7 row at
`scripts/model-metadata.source.json:12046` already does this; copy that one, not the 3.6 one
at L12021 which carries a `cost` block.

## MODIFY `scripts/model-metadata.source.json`

Insert next to the existing `gemini-3.7-flash` record (L12046), under the `google` provider:

```json
"gemini-3.8-flash": {
  "id": "gemini-3.8-flash",
  "name": "Gemini 3.8 Flash",
  "api": "google-generative-ai",
  "provider": "google",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 1048576,
  "maxTokens": 65536,
  "thinking": { "mode": "google-level", "minLevel": "low", "maxLevel": "high" }
}
```

`minLevel: "low"` (not `minimal`) because `001` proves `minimal` errors on this generation —
the same value the 3.7 record uses and the 3.6 record does not.

`input` is `["text","image"]` for the transport reason in `010` section 9, even though the
vendor also accepts video/audio/PDF.

Antigravity resolves generated metadata through the `google` bundle
(`src/generated/model-metadata.ts:27` maps `google-antigravity` to `google`), so this single
`google` record serves both surfaces.

## Regenerate, never hand-edit

```bash
bun run generate:model-metadata
```

`src/generated/model-metadata.ts` is byte-compared by `tests/model-metadata-sync.test.ts`, so
the regen must land in the same commit as the source edit.

## MODIFY `src/usage/expected-prices.ts`

### New price constant (beside `GEMINI_37_FLASH`, L60)

```ts
// Gemini 3.8 Flash carries the same published promotional rate as 3.7 through 2026-12-31,
// rising to 1.50/7.50 on 2027-01-01 (ai.google.dev/gemini-api/docs/pricing, read 2026-09-03).
const GEMINI_38_FLASH: Cost4 = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
```

Equal values to 3.7 today, but a SEPARATE constant: aliasing them would silently move 3.8 if
3.7's promotional rate is ever re-verified to a different number.

### New source string (beside `GEMINI_37_PRICING`, L83)

```ts
const GEMINI_38_PRICING = "https://ai.google.dev/gemini-api/docs/pricing (2026-09-03); promotional rate through 2026-12-31, rises to 1.50/7.50 on 2027-01-01; cacheWrite=0: storage is billed per-hour, not per-token";
```

### New rows

```ts
// CCA billing equivalence is unproven (see devlog 001), so the Antigravity rows are
// verified-derived: the NUMBER is proven, the claim that Antigravity charges it is inferred.
{ provider: "google-antigravity", modelId: "gemini-3.8-flash", cost4: GEMINI_38_FLASH, source: `derived: Gemini 3.8 Flash promotional rate through 2026-12-31 ${GEMINI_38_PRICING}`, verifiedAt: "2026-09-03", status: "verified-derived" },
{ provider: "google-antigravity", modelId: "gemini-3.8-flash-low", cost4: GEMINI_38_FLASH, source: `derived: gemini-3.8-flash ${GEMINI_38_PRICING}`, verifiedAt: "2026-09-03", status: "verified-derived" },
{ provider: "google-antigravity", modelId: "gemini-3.8-flash-medium", cost4: GEMINI_38_FLASH, source: `derived: gemini-3.8-flash ${GEMINI_38_PRICING}`, verifiedAt: "2026-09-03", status: "verified-derived" },
{ provider: "google-antigravity", modelId: "gemini-3.8-flash-high", cost4: GEMINI_38_FLASH, source: `derived: gemini-3.8-flash ${GEMINI_38_PRICING}`, verifiedAt: "2026-09-03", status: "verified-derived" },
// Developer API row: the price IS published for this surface, so `verified`.
{ provider: "google", modelId: "gemini-3.8-flash", cost4: GEMINI_38_FLASH, source: GEMINI_38_PRICING, verifiedAt: "2026-09-03", status: "verified" },
```

The three suffix rows matter because usage rows can carry a wire id directly; the 3.6 block
(L151-153) is the precedent.

### What must NOT be removed

Every existing 3.5/3.6/3.7 row stays. Historical `usage.jsonl` rows still carry those ids, and
deleting a row silently zeroes the cost of requests the user already made. This rollout adds a
model; it retires nothing.

## `src/providers/model-rename-migration.ts` — NO CHANGE, and why

The migration exists for ids the vendor **took offline**. `001` proves 3.7 remains fully
supported and `002` proves CCA still serves it, so a `gemini-3.7-flash -> gemini-3.8-flash`
entry would rewrite a working saved selection out from under the user. The existing
3.6/3.5 to 3.7 entries stay untouched and keep working.

`selectedModels` needs no migration for the same reason: a user who allowlisted
`gemini-3.7-flash` still gets a live model.

## `src/oauth/index.ts` — NO CHANGE

`OAUTH_RECONCILE_FIELDS` already refreshes `models`, `modelContextWindows`,
`modelInputModalities` and `modelReasoningEfforts` from the registry preset, so existing configs
pick up 3.8 on the next start. The `defaultModel` heal branch only fires when the stored default
is absent from the refreshed list; since 3.7 remains listed, an existing user's explicit 3.7
default is preserved — which is the correct outcome.

`isLegacyAntigravityStaticCatalog` (L1209) is a FROZEN v1 fingerprint that must keep naming
`gemini-3.6-flash`. Updating it would break the migration it exists to perform.

## Tests

- `tests/oauth-provider-reconcile.test.ts:82`: default becomes `gemini-3.8-flash`; L142's
  `toHaveLength(6)` becomes 7 (audit blocker 3).
- **New case (audit blocker 4):** a config whose `defaultModel` is explicitly
  `gemini-3.7-flash` must come OUT of `reconcileOAuthProviders` still holding that default,
  while its capability maps refresh. The existing case starts from a retired 3.5 id and
  therefore only exercises the stale-default HEALING branch; asserting 3.7 is still in `models`
  does not prove the default survived. This is the activation scenario for the additive claim
  in this doc — without it, "an existing 3.7 user keeps 3.7" is an untested assertion.
- New assertions near the existing price tests: an Antigravity 3.8 request resolves to the
  `verified-derived` overlay rather than a `verified` bundled price (the activation scenario
  for the omitted `cost` block).
- `tests/model-metadata-sync.test.ts` proves the regen is byte-synced.

```bash
bun test tests/oauth-provider-reconcile.test.ts tests/model-metadata-sync.test.ts \
  tests/usage-summary.test.ts tests/usage-cost.test.ts
```

`tests/usage-cost.test.ts` is the owner of price resolution and was missing from the first
draft (audit blocker 3); it is where the `verified-derived`-wins assertion belongs.

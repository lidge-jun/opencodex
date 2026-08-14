# 020 — Gemini 3.7 Flash: proven facts and repository change map

Research snapshot 2026-08-14 (KST). All values Tier-2 proven by opening the official
Google pages in the source column, and independently re-verified by the A-gate
auditor against the same pages. Unprovable fields are marked NOT PROVEN.

## Claim ledger

| Claim | Value | Source | Page date |
|-------|-------|--------|-----------|
| Canonical API id | `gemini-3.7-flash` (GA, no preview suffix) | ai.google.dev/gemini-api/docs/models/gemini-3.7-flash | 2026-08-13 |
| Aliases | none published (`-preview`/dated/`-latest` NOT PROVEN) | same | 2026-08-13 |
| Announcement | 2026-08-13 | blog.google …/introducing-gemini-3-7-flash/ | 2026-08-13 |
| Availability | GA; exposed in Google Antigravity, AI Studio, Android Studio | ai.google.dev/gemini-api/docs/latest-model | 2026-08-13 |
| Context window | 1,048,576 input tokens | model page | 2026-08-13 |
| Max output | 65,536 tokens | model page | 2026-08-13 |
| Input price | \$0.75 / 1M through 2026-12-31, \$1.50 / 1M from 2027-01-01 | pricing | 2026-08-13 |
| Output price (incl. thinking) | \$3.75 / 1M through 2026-12-31, \$7.50 / 1M from 2027-01-01 | pricing | 2026-08-13 |
| Separate thinking price | none — thinking billed as output | pricing | 2026-08-13 |
| Cache read | \$0.075 / 1M through 2026-12-31, then \$0.15 | pricing | 2026-08-13 |
| Cache storage | \$0.50 / 1M tokens/hour through 2026-12-31, then \$1.00 | pricing | 2026-08-13 |
| Batch / Flex | half of standard input and output | pricing | 2026-08-13 |
| Priority | \$1.35 in / \$6.75 out per 1M through 2026-12-31 | pricing | 2026-08-13 |
| Long-context split | NOT PROVEN — no prompt-length tier published | pricing | 2026-08-13 |
| Thinking parameter | `generation_config.thinking_level` | latest-model | 2026-08-13 |
| Thinking values | `low` / `medium` / `high`, default `medium`; `minimal` errors | model page | 2026-08-13 |
| Legacy control | `thinking_budget` is legacy; sending both is HTTP 400 | latest-model | 2026-08-13 |
| Inputs | text, image, video, audio, PDF | model page | 2026-08-13 |
| Outputs | text only (no image/audio generation, no Live API) | model page | 2026-08-13 |
| Knowledge cutoff | January 2025 (Gemini 3 family) | latest-model | 2026-08-13 |
| REST surface | `POST /v1beta/interactions` with `x-goog-api-key` | latest-model | 2026-08-13 |
| Antigravity | 3.7 Flash is the new default model for the Antigravity agent | latest-model | 2026-08-13 |
| Vertex model id | NOT PROVEN — no openable Vertex page names a 3.7 endpoint | cloud.google.com/vertex-ai/…/release-notes | 2026-08-01 |
| Rate limits | project-scoped, not published per model | ai.google.dev/gemini-api/docs/rate-limits | 2026-08-13 |

### Pricing provenance caveat (audit finding)

The prices above are **Gemini Developer API** list prices. OpenCodex routes this
model through Antigravity (CCA), and CCA billing equivalence is not proven. Any
`google-antigravity` cost row must therefore be recorded as **derived**, matching
how the existing 3.6 Flash Antigravity rows are already marked
`verified-derived` in `src/usage/expected-prices.ts`. Only the `google`
provider row may claim `verified` against the Google pricing page.

## What the repository already has

`src/providers/antigravity-models.ts` splits model knowledge across **five**
separate exports, and adding a model to only the first leaves the rest wrong:

1. `ANTIGRAVITY_WIRE_MODELS` — what discovery may return.
2. `ANTIGRAVITY_MODELS` — picker-visible collapsed base ids.
3. `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` — per-model context, no fallback.
4. `ANTIGRAVITY_MODEL_INPUT_MODALITIES` — per-model modality list.
5. `ANTIGRAVITY_MODEL_EFFORTS` — per-model reasoning-effort ladder, consumed as
   `modelReasoningEfforts` by the provider registry (`src/providers/registry.ts:1400`).

PR #1640 touches only (1) and (2). That is the audit's "incomplete delivery path"
finding, and it is why the model surface cannot ship on that PR alone.

### The reasoning fallback trap (round-2 audit finding)

`resolveAntigravityEffortWireModel()` evaluates five precedence rules
(`src/providers/antigravity-models.ts:250-283`). A bare model id that is absent
from `ANTIGRAVITY_EFFORT_WIRE_MAP` and does not match `/^claude-/` falls through
to **Rule 5**, which returns the wire id with **no `thinkingConfig` at all**.

So merely listing `gemini-3.7-flash` in the picker produces a model that silently
ignores reasoning effort. The two existing Gemini entries avoid this only because
they have suffix wire maps, which 3.7 Flash must not have — its efforts are carried
by `thinking_level` on a single wire id, exactly like the Claude branch.

The correct shape is therefore **Rule 4's pattern, not Rule 2's**: one wire id plus
a `thinkingLevel`, with `low|medium|high` exposed and `medium` as the default.
`resolveAntigravityThinkingLevel()` already clamps `xhigh|max|ultra` to `high`
and rejects unknown values, which matches Google's documented enum — except that
its `ANTIGRAVITY_THINKING_LEVELS` set still includes `minimal`, which the 3.7
model page says is unsupported and returns an error.

Also relevant: `scripts/model-metadata.source.json` holds the vendored snapshot,
`src/generated/model-metadata.ts` is generated from it and byte-compared by
`tests/model-metadata-sync.test.ts`, and `src/usage/expected-prices.ts` pins cost
rows for accounting parity.

## Change map (amended after audit)

1. **Antigravity exposure** — add `gemini-3.7-flash` to all four exports. The bare
   wire id is correct: unlike 3.6 Flash, the model has no effort-suffixed tier
   variants, so a synthetic `-low/-medium/-high` triple would be fabrication.
1a. **Reasoning ladder** — add a `["low","medium","high"]` entry to
   `ANTIGRAVITY_MODEL_EFFORTS` and give the resolver an explicit branch that
   returns `{ wireModelId: "gemini-3.7-flash", thinkingLevel }` with a
   `medium` default, so the model never reaches the Rule 5 no-thinking fallback.
   Cover it with a focused request test asserting the serialized CCA body.
2. **Context window** — `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` needs an explicit
   1,048,576 entry; the map has no default.
3. **Modalities — advertise only what the proxy can actually transport.**
   Google lists text, image, video, audio, and PDF as *vendor* capabilities. What
   OpenCodex can carry end-to-end is narrower, and publishing the vendor list would
   advertise transport that does not exist:

   - `src/types.ts:143` defines only `OcxTextContent` and `OcxImageContent`
     request parts.
   - `src/adapters/google.ts:149` serializes only those two forms.
   - `src/codex/catalog/parsing.ts:313` normalizes `input_modalities` against a
     closed enum and deliberately strips `video`, because one out-of-enum value
     makes Codex reject the **entire** catalog — taking down plugins, apps, and MCP
     servers, not just that model.

   Therefore `ANTIGRAVITY_MODEL_INPUT_MODALITIES["gemini-3.7-flash"]` is
   `["text", "image"]`, matching every other Gemini row. The vendor's wider list
   is recorded in the claim ledger above as a fact about Google, not as a claim
   about this proxy. Google's model page proves vendor support; it proves nothing
   about Cloud Code Assist transport.

   Widening the transport is a separate, testable piece of work — not a line in a
   release-day metadata patch.
4. **Pricing** — add the `google-antigravity` cost row with status
   `verified-derived`, which is the existing enum member for exactly this case
   (`src/usage/expected-prices.ts:30`); do not invent a `derived` status. Use the
   promotional \$0.75 / \$3.75 rates and record that they step up on 2027-01-01.
   Only a `google`-provider row may claim `verified`.

4a. **Source metadata is required, not conditional — and must carry no `cost`.**
   Antigravity resolves generated metadata through the `google` provider bundle
   (`src/generated/model-metadata.ts:27` maps `google-antigravity` → `google`),
   so a `google/gemini-3.7-flash` record must be added to
   `scripts/model-metadata.source.json` alongside the existing 3.6 Flash entry at
   L11973, carrying the context window, max output tokens, and the
   **representable** `["text","image"]` inputs.

   It must **omit `cost`**. Price precedence in
   `resolveMatchedPriceExact()` (`src/usage/cost.ts:247-258`) returns bundled
   generated metadata with `status: "verified"` *before* it ever consults the
   expected-price overlay. If the new source row copies the adjacent 3.6 Flash
   pattern and includes Google's list price, the `google-antigravity`
   `verified-derived` row from step 4 becomes unreachable and CCA cost is
   reported as `verified` — asserting a billing equivalence that step 4's
   provenance caveat exists precisely to avoid.

   Then run `bun run generate:model-metadata` in the same commit, assert alias
   resolution, and add a test proving an Antigravity 3.7 request resolves to the
   `verified-derived` overlay rather than a `verified` bundled price.
5. **Reasoning controls** — `thinking_level` with three values, default `medium`.
   It must not inherit a `thinking_budget` code path; sending both is a hard 400.
6. **Docs** — the provider/model tables in `docs-site/` need the new row with the
   same numbers, and translated locales must not contradict the English source.
7. **Regeneration** — the snapshot *does* change (step 4a), so
   `bun run generate:model-metadata` runs in the same commit and
   `tests/model-metadata-sync.test.ts` proves byte-sync. Never hand-edit
   `src/generated/model-metadata.ts`.

8. **Tests** — beyond the sync and parity gates, two focused assertions are
   required by the audit: an unset effort serializes as `medium`, and `minimal`
   never reaches CCA for this model.

## Deliberately out of scope

Vertex routing. The Vertex-side model id could not be proven from an official page,
and inventing one would put an unverifiable string into the registry.

## 3.6 Flash deprecation (maintainer requirement, 2026-08-14)

**Operational fact from the maintainer:** when Google ships a new Antigravity Flash
model, the previous one is pulled from CCA almost immediately. So this is not an
additive model release — it is a **replacement**. Shipping 3.7 while leaving
`defaultModel: "gemini-3.6-flash"` in place would point every Antigravity user at
a model the backend no longer serves.

### Precedent

The repository already encodes this exact migration once. When 3.5 Flash was
retired, its ids were not deleted — they were moved into
`ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES` pointing at the 3.6 wire ids
(`gemini-3.5-flash-extra-low → gemini-3.6-flash-low` and siblings). Saved user
configs kept resolving instead of hard-failing. 3.6 → 3.7 follows the same shape.

### Required changes

1. **Wire list** — remove the three `gemini-3.6-flash-{low,medium,high}` entries
   from `ANTIGRAVITY_WIRE_MODELS`; CCA will no longer return them.
2. **Picker** — remove `gemini-3.6-flash` from `ANTIGRAVITY_MODELS`, leaving
   `gemini-3.7-flash` as the Flash entry.
3. **Aliases — must preserve tier semantics, not just the id.**
   The naive re-point is wrong. `resolveAntigravityEffortWireModel()` Rule 1
   treats any suffix/compat alias as "the suffix IS the effort" and returns the
   wire id with **no `thinkingConfig`**
   (`src/providers/antigravity-models.ts:257`). So aliasing
   `gemini-3.6-flash-high → gemini-3.7-flash` would silently drop the user's
   `high` tier, and the bare `gemini-3.6-flash` alias would lose its `medium`
   default.

   Retired ids therefore need a **tier-carrying** compatibility map — id →
   `{ wireModelId: "gemini-3.7-flash", thinkingLevel }` — consulted before Rule 1:

   | Retired id | thinkingLevel |
   |---|---|
   | `gemini-3.6-flash-low`, `gemini-3.5-flash-extra-low` | `low` |
   | `gemini-3.6-flash-medium`, `gemini-3.5-flash-low`, `gemini-3.5-flash-mid` | `medium` |
   | `gemini-3.6-flash-high`, `gemini-3.5-flash-high`, `gemini-3-flash-agent` | `high` |
   | `gemini-3.6-flash` (bare base) | `medium` (the 3.6 default) |

   The 3.5 ids matter as much as the 3.6 ones: they currently resolve to 3.6 wire
   ids that are about to disappear, so leaving them alone strands them on a dead
   target. Every id in this table needs a test.

   **The tier map must not replace the alias entry — both are needed.**
   `parseAntigravityAvailableModels()` hides compatibility ids during live
   discovery by consulting `ANTIGRAVITY_MODEL_ALIASES` only
   (`src/providers/antigravity-models.ts:210`). A tier map read solely by the
   request resolver would leave the discovery exclusion blind, so a stale CCA
   payload still listing `gemini-3.6-flash-*` would republish dead models into
   the picker. Keep every retired id in the alias map for the discovery predicate,
   and have the resolver consult the tier map first for routing. Add a
   stale-discovery fixture asserting no retired id becomes picker-visible.

3a. **Discovery/derivation maps** — remove the 3.6 entries from
   `ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID` and the private
   `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS`
   (`src/providers/antigravity-models.ts:25`), or stale 3.6 discovery and
   capability derivation survives the deprecation.

3b. **Migrate `selectedModels`.** OAuth reconciliation refreshes `models` and
   the capability maps but does **not** include `selectedModels` in
   `OAUTH_RECONCILE_FIELDS` (`src/oauth/index.ts:846`), while catalog filtering
   requires an exact id match (`src/codex/catalog/provider-fetch.ts:1475`). A user
   who allowlisted only `gemini-3.6-flash` would get **no Flash model at all** in
   their catalog. Rewrite retired selections to `gemini-3.7-flash` as a config
   migration, in the same shape as the existing model-rename migration.
4. **Default model** — `src/providers/registry.ts:1400` `defaultModel` becomes
   `gemini-3.7-flash`.
5. **Per-model maps** — drop the 3.6 entries from
   `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS`, `ANTIGRAVITY_MODEL_INPUT_MODALITIES`,
   `ANTIGRAVITY_MODEL_EFFORTS`, and `ANTIGRAVITY_EFFORT_WIRE_MAP`/
   `ANTIGRAVITY_DEFAULT_EFFORT`, since alias derivation now resolves them through
   the 3.7 entry.

### What must NOT be removed

**The 3.6 rows in `src/usage/expected-prices.ts` stay.** Historical
`usage.jsonl` rows still carry 3.6 model ids, and cost accounting for past usage
resolves against those rows. Deleting them would silently zero out the cost of
every request a user already made. Deprecation removes a model from *selection*,
not from *accounting*.

**Historical usage attribution must not be rewritten either.**
`ANTIGRAVITY_USAGE_BASE_BY_ID` (`src/providers/antigravity-models.ts:291`) is
derived from `ANTIGRAVITY_MODEL_ALIASES`, so re-pointing 3.6 aliases at 3.7 would
relabel every historical 3.6 usage row as 3.7 in summaries — the user's past
spend would appear under a model they never called, while its price row correctly
stayed 3.6. Keep an immutable historical canonicalization map so retired ids still
collapse to their own base for usage aggregation, separate from the routing alias
that sends *new* calls to 3.7.

Likewise the generated `google/gemini-3.6-flash` metadata row stays: it is the
Gemini Developer API model, which is a separate surface from Antigravity's CCA
catalog and is not necessarily retired on the same schedule.

### Regression shape

Tests must prove:

- every id in the tier table routes to `gemini-3.7-flash` **with its recorded
  `thinkingLevel`**, not a bare wire id;
- no retired id remains picker-visible;
- a `selectedModels: ["gemini-3.6-flash"]` config still yields a Flash entry in
  the catalog after migration;
- a historical usage row carrying `gemini-3.6-flash-high` still aggregates under
  3.6, not 3.7.

# 010 — wp-cyber-model: register the Daybreak alias slugs on `openai-apikey`

## What goes in

Two alias ids, and no snapshot ids:

| Registry id | Context | Max input | Modalities | Effort ladder |
|-------------|--------:|----------:|------------|---------------|
| `daybreak-red-latest` | 400,000 | 272,000 | text, image | none published |
| `daybreak-blue-latest` | 1,050,000 | 922,000 | text, image | none published |

Rationale for aliases over snapshots is in `000_plan.md` §Objective: OpenAI
repoints these names, so the alias is the stable contract and the snapshot is the
thing that goes stale.

## Why `openai-apikey` and nowhere else

Both endpoint tables mark `v1/chat/completions` **Not supported** and
`v1/responses` **Supported**. `openai-apikey` is the only provider here that is
both OpenAI-first-party and built on `adapter: "openai-responses"`
(`src/providers/registry.ts:1102-1122`). A chat-completions provider would
produce a selectable model that fails on first call.

The Codex-login `openai` provider is also `openai-responses`, but its lineup is
the pinned upstream ChatGPT snapshot (`src/codex/catalog/native-models.ts:2-5`,
`src/codex/data/upstream-models.json`). Daybreak is separately provisioned and
absent from that snapshot, so a row there would advertise something the login
path cannot route. It stays out.

Azure is deployment-named and chat-shaped — not a target.

## MODIFY `src/providers/registry.ts`

### 1. Constants, after the GPT-5.6 block (~line 322)

```ts
/**
 * Daybreak program aliases. These `-latest` ids are the stable contract: OpenAI
 * repoints them at newer snapshots over time (red -> gpt-5.6-cyber, blue ->
 * gpt-5.6-sol as of 2026-08-11), so registering the ALIAS inherits future model
 * swaps while a pinned snapshot id would silently go stale. Snapshot ids are
 * deliberately absent from this registry.
 * Responses-only per both published endpoint tables — never add these to a
 * chat-completions provider. Access needs separate Daybreak approval and
 * provisioning, so neither is ever a default.
 * Verified 2026-08-11: developers.openai.com/api/docs/models/daybreak-red-latest.md
 * and .../daybreak-blue-latest.md
 */
const OPENAI_DAYBREAK_MODELS = ["daybreak-red-latest", "daybreak-blue-latest"];
const OPENAI_DAYBREAK_CONTEXT_WINDOWS: Record<string, number> = {
  "daybreak-red-latest": 400_000,
  "daybreak-blue-latest": 1_050_000,
};
const OPENAI_DAYBREAK_MAX_INPUT_TOKENS: Record<string, number> = {
  "daybreak-red-latest": 272_000,
  "daybreak-blue-latest": 922_000,
};
```

Explicit `Record<string, number>` annotations rather than `Object.fromEntries`:
the two aliases carry different numbers, so a literal map is both clearer and
better-typed (round-1 audit note 2).

### 2. The `openai-apikey` entry (lines 1110-1121)

`defaultModel` stays `gpt-5.5` — a provisioned-only model must never be a default.

```ts
models: ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS],
liveModels: true,
modelContextWindows: { ...OPENAI_API_GPT56_CONTEXT_WINDOWS, ...OPENAI_DAYBREAK_CONTEXT_WINDOWS },
modelMaxInputTokens: { ...OPENAI_API_GPT56_MAX_INPUT_TOKENS, ...OPENAI_DAYBREAK_MAX_INPUT_TOKENS },
modelInputModalities: Object.fromEntries(
  ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS]
    .map(id => [id, ["text", "image"]]),
),
modelReasoningEfforts: {
  ...Object.fromEntries(
    [...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, OPENAI_API_GPT56_REASONING_EFFORTS]),
  ),
  ...Object.fromEntries(OPENAI_DAYBREAK_MODELS.map(id => [id, [] as string[]])),
},
virtualModels: OPENAI_API_GPT56_VIRTUAL_MODELS,
```

### 3. Why `[]` and not omission

Neither page publishes an effort ladder, and advertising an effort the model
rejects is a runtime 400. But **omitting** the key is not "no ladder" — it is the
opposite:

- `configuredReasoningEfforts` returns `undefined` when neither the model nor the
  provider supplies one, and its docstring states `undefined` means "no
  override" while an empty array means "intentionally expose no effort control
  for this model" (`src/reasoning-effort.ts:76-85`).
- `applyReasoningLevels` then falls back to the FULL routed ladder:
  `sanitizeCodexReasoningEfforts(effortsOverride) ?? ROUTED_REASONING_LEVELS.map(l => l.effort)`
  (`src/codex/catalog/effort.ts:143-149`).

So omission would advertise `low|medium|high|xhigh|max`. Explicit `[]` is the
correct encoding.

`noReasoningModels` is the wrong tool: both pages document reasoning-token
support, so these are not non-reasoning models — they publish no *selectable*
ladder.

## MODIFY `src/usage/expected-prices.ts`

### 1. Cost tuples (~line 44)

From the grouped pricing table (`pricing.md`, Cyber models). Cache write is
1.25× uncached input, matching the table's own cache-write column.

```ts
/** Daybreak Red (currently gpt-5.6-cyber). Alias pricing tracks its snapshot. */
const DAYBREAK_RED: Cost4 = { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 };
/** Daybreak Blue (currently gpt-5.6-sol) — same published rates as that snapshot. */
const DAYBREAK_BLUE: Cost4 = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };
```

### 2. Expected-price rows

```ts
{ provider: "openai-apikey", modelId: "daybreak-red-latest", cost4: DAYBREAK_RED, source: `alias of gpt-5.6-cyber ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-11", status: "verified-derived" },
{ provider: "openai-apikey", modelId: "daybreak-blue-latest", cost4: DAYBREAK_BLUE, source: `alias of gpt-5.6-sol ${OPENAI_GPT56_PRICING}`, verifiedAt: "2026-08-11", status: "verified-derived" },
```

`verified-derived`, not `verified`. The file's own status semantics reserve
`verified` for "official page opened directly; the 4-tuple is the published API
price" and define `verified-derived` as "mapped from a verified base-model price"
(`src/usage/expected-prices.ts:6-9`). An alias price *is* its snapshot's price —
the pricing table has no `daybreak-*` rows at all, only `gpt-5.6-cyber` and
`gpt-5.6-sol`. The existing OpenAI `-pro` alias rows already use
`verified-derived` for exactly this reason (`expected-prices.ts:103-105`).

This is not bookkeeping. `isEstimated` treats `verified-derived` as estimated
(`src/usage/cost.ts:314-315`), so marking these `verified` would silently drop
the `estimated` marker from the Logs cost column — and these rows are *more*
likely to drift than a normal row, since the alias can be repointed at a
differently-priced model at any time. Tests pin the status explicitly.

### 3. Long-context tier — Blue only

This corrects an earlier draft that gave the cyber model a long-context tier.
The grouped table is explicit: `gpt-5.6-cyber`'s four long-context cells are all
`-`, while `gpt-5.6-sol` publishes `$10.00 / $1.00 / $12.50 / $45.00`.

`daybreak-blue-latest` therefore needs the 272,000-exclusive
`OPENAI_LONG_CONTEXT` rule, and `daybreak-red-latest` needs **no** tier row.

It must NOT go into `OPENAI_GPT56_CONTEXT_MODELS`. That list is expanded across
both providers — `["openai", "openai-apikey"].flatMap(...)`
(`expected-prices.ts:246-256`) — so appending the alias would also mint
`openai/daybreak-blue-latest`, a Codex-login row for a model that path cannot
route. The file states the invariant plainly: "No model-level fallback: routed
resellers share model slugs but price independently"
(`expected-prices.ts:206-208`). Inventing a tier for a provider/model pair that
does not exist violates it.

Instead add one explicit entry to `CONTEXT_TIERS`, scoped to `openai-apikey`:

```ts
{
  // Alias of gpt-5.6-sol, which publishes the full long-context row
  // ($10 / $1 / $12.50 / $45). Scoped to openai-apikey deliberately: Daybreak is
  // not routable on the Codex-login `openai` provider, so no tier exists there.
  // daybreak-red-latest has NO tier — the cyber row's long columns are all "-".
  provider: "openai-apikey",
  modelId: "daybreak-blue-latest",
  thresholdInputTokens: 272_000,
  inclusive: false,
  multiplier: OPENAI_LONG_CONTEXT,
  source: OPENAI_PRICING_DOC,
  verifiedAt: "2026-08-11",
},
```

`PRIORITY_MULTIPLIERS` gets no entry for either alias: the Fast-mode table lists
no Daybreak row and the resolver already falls back to 1×.

## MODIFY tests

Three suites assert exact lineups/counts and must move with the change:

1. `tests/provider-registry-parity.test.ts:86` — the exact eight-id
   `openai-apikey` seed. Append both alias ids.
2. `tests/provider-registry-parity.test.ts:95` — `toHaveLength(8)` becomes `10`.
3. `tests/codex-catalog.test.ts:4436` — `exactIds`. Append both.
4. `tests/codex-catalog.test.ts:4482` — the loop
   `apiRows.filter(row => row.id.startsWith("gpt-5.6"))` asserts 1,050,000 /
   922,000 / the full ladder. The alias ids do **not** start with `gpt-5.6`, so
   they fall outside it naturally — no narrowing needed. Assert both alias rows
   separately with their own values, including `reasoningEfforts: []`.
   (Choosing aliases over the snapshot id removed the round-3 collision here.)
5. `tests/usage-cost.test.ts:269` — `EXPECTED_PRICE_OVERLAYS.length` 51 → 53,
   plus both ids in the membership assertion.
6. Value-level pricing assertions, since count+membership would pass with a
   wrong tuple:
   - exact tuples for both aliases, per the pattern at `usage-cost.test.ts:113-118`;
   - `status: "verified-derived"` pinned for both rows, so a later edit to
     `verified` cannot silently drop the `estimated` marker;
   - Blue's exclusive 272,000 boundary (272,000 standard, 272,001 long) per `L1`
     at `usage-cost.test.ts:573-577`;
   - Red has **no** tier: assert 272,001 still bills at the standard rate;
   - provider scoping: assert the Blue tier resolves for `openai-apikey` and is
     `undefined` for `openai`, so the row cannot drift back into the shared
     two-provider list.

## Entitlement gating (out of scope, deliberate)

Registry rows are reconstructed into the catalog even when live `/models` omits
them (`src/codex/catalog/provider-fetch.ts:1792`). All ten `openai-apikey` ids
behave this way, including the already-shipped tier-gated `-pro` ids, so these
rows inherit an existing property rather than introducing a leak, and they are
inert without a provisioned key. Entitlement-aware catalog admission is a real
improvement to the provider surface and its own unit; folding it into a
two-file model addition would turn this into a catalog-architecture change.

## Verification

1. `bun run typecheck` — clean.
2. `bun run test` — full suite green, including the three updated suites.
3. `rg -n "gpt-5\.6-cyber" src/` — must return nothing (aliases only).
4. `rg -n "grok-4\.6" src/ gui/src/ scripts/ tests/` — must return nothing.
   Scoped to code on purpose: `devlog/` contains the string while documenting why
   that model was rejected, so an unscoped grep could never pass.

## Then

Commit and push to `origin/dev` with `--no-verify`, per the user's explicit
instruction this cycle (no PR).

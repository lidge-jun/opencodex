# 020 — #1100: reasoning effort never reaches routed DeepSeek and GLM

## Defect

A user picks a reasoning effort in Codex Desktop for a routed DeepSeek or GLM
model. The proxy forwards the turn without it, so the provider runs at its
default and the picker appears inert.

The contradiction is inside catalog generation:

1. `src/codex/catalog/effort.ts:144-180` — `applyReasoningLevels` advertises the
   effort ladder on routed rows.
2. `src/codex/catalog/parsing.ts:341-353` — `normalizeRoutedCatalogEntry` then
   deletes `supports_reasoning_summaries`.
3. `src/codex/catalog/parsing.ts:262-267` — strict normalization defaults it to
   `false`.

Codex reads a row that offers effort levels but declares no reasoning-summary
support, and omits the entire inbound reasoning object. The adapter would
serialize `reasoning_effort` correctly if it ever arrived
(`src/adapters/openai-chat.ts:759-806`) — nothing is broken downstream.

The `delete` is not careless. Routed rows are cloned from native templates, and
inheriting OpenAI-only summary delivery would be wrong. The comment at
`parsing.ts:351-352` says exactly that and anticipates per-model opt-in.

## Constraint from PR #1119

PR #1119 is tests-only and does not fix this, but it pins the contract any fix
must satisfy: an explicit `modelSupportsReasoningSummaries: true` survives
template normalization, and a ladder without that opt-in stays `false`.

So the fix must not infer `true` from a non-empty ladder. That would flip every
routed model including providers that reject summary fields, and would break
#1119's second assertion.

## Change

Supply the opt-in as registry metadata for providers we have evidence for.

The config-level field **already exists** at `src/types.ts:1235-1239` as
`modelSupportsReasoningSummaries?: Record<string, boolean>`, documented as the
per-model escape hatch for backends that reject summary fields. So this phase
does not invent a field — it supplies registry-side defaults for a field users
currently have to set by hand.

1. `src/providers/registry.ts` — add the same
   `Record<string, boolean>` shape to `ProviderRegistryEntry`.
2. Populate it for the canonical DeepSeek V4 models and the GLM models with
   confirmed support: entries `deepseek`, `opencode-go`, `zai`, and only the
   Zhipu models with evidence. No speculative entries.
3. `src/providers/derive.ts:279-282` — backfill in `enrichProviderFromRegistry`.

### The merge must be per-key, not per-Record

Every backfill at `derive.ts:279-282` today is scalar and uses
`if (prov.X === undefined && entry.X !== undefined)`. Copying that shape for a
Record would be a real bug: a user who sets one model's flag creates a defined
Record, and the whole-object `undefined` check then suppresses **every**
registry default for that provider. One hand-edit would silently disable the
fix.

So the merge is per-key — start from the registry map, then let explicit user
keys win:

```ts
// registry defaults first, explicit user keys override — including explicit false
if (entry.modelSupportsReasoningSummaries) {
  prov.modelSupportsReasoningSummaries = {
    ...entry.modelSupportsReasoningSummaries,
    ...(prov.modelSupportsReasoningSummaries ?? {}),
  };
}
```

Explicit `false` must survive. A user who disabled summaries for one model
because their backend 400s on it has to keep that, and a spread-based merge
preserves it while `undefined`-checking would not.

Deep-clone the registry side so saved config never aliases the registry
constant — the same precaution `responsesItemIdRepair` already takes at
`derive.ts:286`.

Arbitrary custom providers stay conservative and keep the existing per-model
configuration workaround. This is a deliberate asymmetry: we ship the opt-in
where we have proof and leave it manual where we do not.

## Tests

`tests/codex-catalog.test.ts`:

- `built-in DeepSeek and GLM effort models opt into Codex reasoning propagation (#1100)`
  — gather registry-enriched models, build with `nativeTemplate()`, assert each
  row carries both the expected effort levels and
  `supports_reasoning_summaries === true`.
- Keep #1119's no-opt-in assertion in the same file so a future global flip
  fails here rather than in production.
- `explicit per-model overrides survive registry backfill` — a provider with a
  user-set `{modelA: false}` keeps `modelA` false and still receives the
  registry's `modelB: true`. This fails under a whole-Record fill-if-undefined
  merge, which is the specific mistake this test exists to catch.

## Blast radius

Provider derivation, generated Codex catalogs, and Responses summary
sanitization. An over-broad opt-in would forward summary fields to providers
that reject them, which is why the metadata is model-scoped rather than
provider-scoped or ladder-inferred.

`tests/codex-catalog.test.ts` is also touched by PR #1119. If that PR lands
first, rebase onto it rather than duplicating its cases.

## What audit changed after implementation

The first implementation fixed the canonical provider ids and passed its tests,
and was still wrong about the reported case. Recording why, because the failure
mode generalizes.

`enrichProviderFromRegistry` matches on the provider NAME. The reporter's row is
a hand-added provider literally called `GLM`. Routing worked, so nothing looked
broken — but no registry id is called `GLM`, so the metadata never arrived. The
tests substituted canonical ids (`zai`, `zhipu-bigmodel`) and were green against
a configuration no user had.

Fix: on the name-lookup miss, fall back to
`registryEntryForProviderDestination`, which matches by vendor endpoint and is
already restricted to fixed key destinations.

Two further corrections from the same audit:

- The fallback originally bailed whenever the user had any map, recreating the
  whole-record bug the per-key merge was written to prevent.
- `enrichProviderFromCatalog` persists what it enriches, so registry defaults
  were being frozen into saved config as user overrides.

## Deferred: the reporter's exact endpoint

`https://open.bigmodel.cn/api/coding/paas/v4` appears in no registry entry —
only `/api/paas/v4` does, as `zhipu-bigmodel`. The coding path exists solely in
`FREE_PROVIDER_DIRECTORY` as `glm-cn`.

Closing that route needs a new registry entry, and the audit confirmed it would
be safe with a distinct id (`glm` and `glm-cn` are both already bound, and
reusing either would retarget an existing config's endpoint — the warning at
`registry.ts:1668-1676`). It also needs `preserveCustomDestination: true`, its
own evidence-backed model set rather than the pay-as-you-go GLM 4.6–5.1
metadata, and updates to `EXPECTED_KEY_PROVIDER_IDS` in
`tests/provider-registry-parity.test.ts`.

That is a provider addition, not a bug fix. It stays out of this stack
deliberately: the destination fallback already fixes every custom-named row on
an endpoint we know, and mixing a new vendor entry into a bug-fix chain would
expand the review surface past what a reviewer can check in one pass.

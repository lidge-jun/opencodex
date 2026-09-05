# 010 — Declare the reasoning-effort ladder on the native Anthropic providers

Work phase: wp2. Consumes 000.

Scope was one production file in the first draft. The audit disproved that:
declaring the ladder is necessary but not sufficient, because enrichment can
drop it and routing evidence can contradict it. Three production files.

## Phase 1 — `src/providers/registry.ts` (the advertisement)

Add one shared constant beside the existing Anthropic constants (after
`ANTHROPIC_MODEL_CONTEXT_WINDOWS`, line ~351):

```ts
/**
 * Every model in ANTHROPIC_MODELS accepts the same five rungs, because both wire
 * shapes the adapter emits cover the same range: adaptive families take
 * output_config.effort (low|medium|high|xhigh|max) and older families take a
 * thinking budget, which reasoningBudget() sizes distinctly for each of those
 * five. Deliberately excluded: minimal (adaptive 400s on it and the adapter
 * rewrites it to low, so it is not a distinct setting), none (only sonnet>=5
 * accepts an explicit thinking disable; Fable rejects one outright), and ultra
 * (not an Anthropic concept; reasoningBudget has no case for it).
 */
const ANTHROPIC_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  ANTHROPIC_MODELS.map(id => [id, [...ANTHROPIC_REASONING_EFFORTS]]),
);
```

Then add `modelReasoningEfforts` to BOTH provider entries, next to the existing
`modelContextWindows` line so the metadata stays visually grouped:

- `anthropic` (line ~1341): `modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },`
- `anthropic-apikey` (line ~1356): the same spread.

Both entries get it. They share `ANTHROPIC_MODELS` and the same adapter, so a
ladder on only one would make the effort control depend on whether the user
signed in with OAuth or an API key — the exact class of inconsistency this unit
is fixing. `tests/provider-registry-parity.test.ts:450-451` already asserts the
two entries agree on `models` and `modelContextWindows`; extend it to the ladder.

### What the ladder means

It is an OPENCODEX ladder, not a claim that every model takes
`output_config.effort`. Fable 5/5.1, Sonnet 5, Opus 5 and Opus 4.7/4.8 send the
five values directly; Opus 4.6, Sonnet 4.6 and Haiku 4.5 take the legacy budget
path where the adapter TRANSLATES each rung into `thinking.budget_tokens`. Per
Anthropic's effort documentation the 4.6 models expose `low|medium|high|max`
natively and Haiku 4.5 has no effort parameter at all — the adapter's budget
translation is what makes five rungs meaningful there. That is why the ladder is
uniform: the proxy, not the vendor, defines it, and the adapter honors all five
for every family without a 400 (budgets are clamped below `max_tokens` at
`src/adapters/anthropic.ts:947-956`).

## Phase 2 — `src/providers/derive.ts` (make enrichment per-model)

Line 493 today:

```ts
if (!prov.modelReasoningEfforts && seed.modelReasoningEfforts) prov.modelReasoningEfforts = cloneRecordOfArrays(seed.modelReasoningEfforts);
```

becomes the per-key fill already used one line above it for modalities:

```ts
if (seed.modelReasoningEfforts) {
  prov.modelReasoningEfforts = fillRecordOfArrays(seed.modelReasoningEfforts, prov.modelReasoningEfforts);
}
```

`fillRecordOfArrays` (line 111) spreads the seed first and the user's map second,
so per-model user entries stay authoritative while untouched models inherit the
registry. Without this, any user who customized ONE Anthropic model keeps the bug
for the other eight, and in a particularly confusing shape: routing merges these
maps per key already (`src/router.ts:181-189`), so the wire would honor the
effort while `/v1/models` and Aside still showed no control.

Precisely: authoritative for the SAME EXACT KEY. A differently-cased user key can
coexist with the canonical registry key, and `modelRecordValue`
(`src/reasoning-effort.ts:115-126`) resolves an exact match before its
case-folded fallback, so the canonical entry wins the lookup. The direct-contract
pass (`derive.ts:130-147,158-205,562`) then removes folded duplicates and
restores the explicit spelling, which is why
`tests/alibaba-intl-token-plan.test.ts:102-121` stays green.

This is a general fix, not an Anthropic one — it repairs the same latent bug for
every provider with a registry ladder. Its comment at line 100-107 documents the
identical reasoning for `modelInputModalities`; that precedent is why this rides
in the same PR rather than becoming a separate unit.

## Phase 3 — `src/routing/capability.ts` (do not contradict `noReasoningModels`)

Two edits in one file: the guard, and the line-239 spread that would otherwise
discard its result.

`candidateCapabilityEvidence` (line 216) reads the registry map directly and
never consults `noReasoningModels`, unlike `configuredReasoningEfforts`
(`src/reasoning-effort.ts:148`), `supportedLadderFor`
(`src/server/effort-policy.ts:119-127`) and the compatibility fingerprint
(`src/routing/compatibility/behavior.ts:194-196`). Add the same guard first:

```ts
const reasoningEfforts = modelInList(provider?.noReasoningModels, modelId)
  ? []
  : modelRecordValue(provider?.modelReasoningEfforts, modelId)
    ?? modelRecordValue(registryEntry?.modelReasoningEfforts, modelId)
    ?? (isNative ? nativeReasoningEfforts(modelId) : undefined);
```

The `[]` must SURVIVE into the returned evidence, which the current line 239
prevents:

```ts
...(reasoningEfforts !== undefined && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
```

An empty ladder is dropped, the property is absent, and
`src/routing/evaluator.ts:141-150` and `:218-227` take their
`Array.isArray(ladder)` false branch and record `unknown`. Unknown is
permissive — it is "we could not tell", not "this model has no effort control".
So returning `[]` alone would leave the original defect intact behind a
different code path.

Change line 239 to preserve a DEFINED ladder, empty or not:

```ts
...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
```

Blast radius of that widening, since it affects every provider and not just
Anthropic: a defined-but-empty ladder today comes from an explicit per-model
`[]` in config or registry, which `src/types/provider.ts:465-467` documents as
"intentionally expose no effort control". Every other consumer already reads
`[]` as a known negative — `configuredReasoningEfforts`
(`reasoning-effort.ts:148`) returns `[]` for `noReasoningModels`,
`supportedLadderFor` (`effort-policy.ts:119-127`) does the same, and
`behavior.ts:194-196` reports `reasoning.supported: false`. Routing evidence is
the one surface that silently downgraded that to unknown. Making it agree is the
intent, and the evaluator change is the observable effect: a candidate with an
explicit empty ladder now returns `unsatisfied` for a reasoning-effort
requirement instead of `unknown`.

Today this cannot misfire for Anthropic because there is no ladder to report.
Phase 1 is exactly what makes it reachable, which is why it belongs in this PR.

The spread (rather than sharing one object reference) matches how
`modelContextWindows` is already written on these two entries and keeps a
later mutation of one provider from reaching the other.

## Why no `modelDefaultReasoningEfforts`

Considered and rejected. Setting a default would change what the proxy SENDS for
callers who specify nothing, which is a behavior change for existing users beyond
the reported bug. The reported bug is that the control is absent, not that its
default is wrong. Anthropic's own defaults stay in force: adaptive models decide
for themselves, and `defaultReasoningEffort()` returns undefined so the adapter
omits the field exactly as it does today.

Consequence to keep in mind while reading the export: `buildPiClientConfig`
emits no per-model default either (config-export.ts line ~823 documents that the
proxy owns the default), so the client shows a ladder with no preselected rung.
That is the same shape every other routed provider already has.

## Scope boundary

IN: the two registry entries plus constants, the `derive.ts` per-model fill, and
the `capability.ts` `noReasoningModels` guard.

OUT: `src/adapters/anthropic.ts` (already correct — see 000), the exporters in
`src/clients/config-export.ts` (they key off the ladder and need no edit),
`effort-policy.ts` (already correct), and the unrelated empty-ladder providers
in 030 — that investigation ships in its own change, never in this PR.

## Accept criteria

1. `GET /v1/models` returns `supports_reasoning_effort: true` and
   `reasoning_efforts` of low..max for every `anthropic/claude-*` row, and the
   same for `anthropic-apikey` when configured.
2. The Aside export document emits `reasoning: true` and a `thinkingLevelMap`
   for those rows, with `off` and `minimal` mapped to `null` (the ladder
   declares neither) and `max` mapped to `max`.
3. A provider carrying a PARTIAL persisted `modelReasoningEfforts` still
   receives the registry ladder for its untouched models, and the customized
   model keeps the user's value.
4. A model listed in `noReasoningModels` reports no effort evidence to routing
   even though the registry now declares a ladder.
5. `bun run typecheck` passes.

The earlier `ultra` criterion is deleted, not weakened: `parser.ts:814-820`
already degrades `ultra` to `max`, so that assertion passes before the change
and proves nothing.

### Activation scenarios (C-ACTIVATION-GROUNDING-01)

Both new conditional paths must be shown to fire:

- Phase 2's per-key fill activates when the persisted provider has a non-empty
  `modelReasoningEfforts` missing some registry keys. C constructs exactly that
  config; the observable effect is the untouched model's ladder in the enriched
  provider. Under the old line the map is returned unchanged, so this assertion
  is red before the change.
- Phase 3's guard activates when `noReasoningModels` names a model the registry
  gives a ladder. The observable effect is `reasoningEfforts: []` in the
  capability evidence AND an `unsatisfied` (not `unknown`) evaluator outcome for
  a reasoning-effort requirement. Asserting mere ABSENCE would be a green
  no-op — absence is exactly the buggy state — so the assertion is on the
  present-and-empty value and the downstream outcome. This is red after phase 1
  alone, which is the point: phase 1 is what makes it reachable.

## Test plan

Rewritten after audit. The first draft built an `ExportModel` that already
carried the ladder, which tests the serializer and skips every hop where the bug
actually lives. Tests attach to the subsystem they cover:

1. `tests/provider-registry-parity.test.ts` — extend the existing anthropic
   parity block (line ~440-451): both entries declare a ladder for every id in
   `ANTHROPIC_MODELS`, the two agree, and the ladder excludes `minimal`,
   `none` and `ultra`. Asserting the exclusions is the point: a future widening
   to `minimal` would be collapsed to `low` by `adaptiveEffort`.
2. `tests/aside-client.test.ts` — the anthropic fixture at line 38 currently
   carries no ladder and asserts nothing about it. Give it the ladder and assert
   `buildClientConfig("aside", ctx)` emits `reasoning: true` with `off` and
   `minimal` null. Use the PUBLIC `buildClientConfig` entry point
   (`config-export.ts:1963`) — `buildPiClientConfig` and
   `buildAsideContribution` are private. Keep a no-ladder row in the same
   document asserting neither field appears, so the test fails if someone makes
   `reasoning: true` unconditional.
3. Enrichment: a focused test over `enrichProviderFromRegistry` with a partial
   persisted `modelReasoningEfforts`, asserting registry fill for untouched
   models and user precedence for the customized one.
4. `tests/routing-capability-model-matching.test.ts` — a `noReasoningModels`
   case asserting `evidence.reasoningEfforts` EQUALS `[]` (not merely absent),
   fed through the evaluator to assert `outcome: "unsatisfied"`, plus a control
   case that still reports the five-rung ladder and `satisfied`.
5. `tests/management-client-config-route.test.ts` — the INTEGRATION regression,
   and the only test here that covers the seam the bug actually lives in. Items
   1-4 and the aside-client serializer contract all start from hand-built
   fixtures, so every one of them would stay green if enrichment,
   `CatalogModel`, `ManagementModelRow` or `toExportModel` dropped the field
   tomorrow. This case starts from a canonical minimal Anthropic PROVIDER
   CONFIG and asserts the resulting Aside document, exercising
   `registry -> enrichProviderFromRegistry -> CatalogModel -> ManagementModelRow
   -> toExportModel -> buildClientConfig("aside")` end to end. That route file
   already drives model loading through the public client-config boundary, so
   the fixture cost is small. It is red before phase 1 and green after.

Run each touched file with `bun test tests/<file>.test.ts`, plus
`bun test tests/anthropic-reasoning.test.ts` to show the wire path is
unaffected, plus `bun run typecheck`. AGENTS.md also recommends
`bun run test:changed` for a change with this many consumers; it selects by
import graph and is NOT the repository-wide suite the user forbade, so it is
included. A bare `bun test` or `bun run test` is not run under any circumstance.

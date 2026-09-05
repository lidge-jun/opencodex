# 000 — Research: native Anthropic models advertise no reasoning-effort ladder

## Reported symptom

Connecting opencodex to Aside shows a reasoning-effort control for every routed
model EXCEPT the Claude ones. The user's phrasing — "claude 모델들만 추론강도
조절이 나타나지 않는다" — is precise but the word "Claude" is a red herring, and
that matters for the fix: Claude models routed through OTHER providers are fine.

## Evidence

`~/.aside/u/0/models.json`, the file Aside actually reads, on 2026-09-04:

```
anthropic/claude-fable-5-1                    reasoning=None  thinkingLevelMap=-
anthropic/claude-opus-4-6                     reasoning=None  thinkingLevelMap=-
anthropic/claude-opus-5                       reasoning=None  thinkingLevelMap=-
cursor/claude-fable-5-1                       reasoning=True  thinkingLevelMap=yes
google-antigravity/claude-opus-4-6-thinking   reasoning=True  thinkingLevelMap=yes
```

`cursor/claude-fable-5-1` and `anthropic/claude-fable-5-1` are the SAME model.
One has an effort control and the other does not, so nothing about Claude itself
can explain it. The discriminator is the provider entry.

`GET http://127.0.0.1:10100/v1/models` on the live proxy agrees, which locates
the defect upstream of Aside and upstream of the exporter:

```
anthropic/claude-fable-5-1                   supports_reasoning_effort=absent  reasoning_efforts=[]
cursor/claude-fable-5-1                      supports_reasoning_effort=True    reasoning_efforts=[low,medium,high,xhigh,max]
google-antigravity/claude-opus-4-6-thinking  supports_reasoning_effort=True    reasoning_efforts=[low,medium,high,max]
```

## Causal chain

Corrected after audit. An earlier draft of this document routed the export
through `src/routing/capability.ts:216`; that function
(`candidateCapabilityEvidence`) feeds POLICY ROUTING and never reaches the
catalog or `ExportModel`. Naming the wrong hop would have produced a test that
guards a seam the bug does not live in, so the real chain is recorded here:

1. `src/providers/registry.ts` — the `anthropic` entry (line ~1330) and
   `anthropic-apikey` entry (line ~1346) declare `models`,
   `modelContextWindows` and `defaultModel`, but no `modelReasoningEfforts`.
   Every peer provider that shows effort declares one: `cursor` line 1162,
   `google-antigravity` line 1861, `xai` line 1281, `kimi` line 1384.
2. `captureProviderGather` clones the configured provider and calls
   `enrichProviderFromRegistry` — `src/codex/catalog/provider-fetch.ts:411-420`.
   This is where a registry ladder would be merged into the live provider.
3. `configuredReasoningEfforts(prov, model.id)` —
   `src/reasoning-effort.ts:148-153`. It returns `[]` for a
   `noReasoningModels` member, the per-model map when present, the
   provider-wide ladder next, and `undefined` when nothing is declared.
   Anthropic hits the last arm.
4. `src/codex/catalog/provider-fetch.ts:749-772` spreads
   `reasoningEfforts` onto the `CatalogModel` only when it is not
   `undefined`, so the catalog row carries no ladder.
5. `src/server/management/model-rows.ts:150-165` builds the
   `ManagementModelRow` from that catalog row, and `toExportModel`
   (`model-rows.ts:170-182`) copies `reasoningEfforts` only when present.
6. `normalizeExportModels` (`src/clients/config-export.ts:934-942`) preserves
   the object as-is.
7. `buildPiClientConfig` (`config-export.ts:1229-1258`) emits `reasoning: true`
   plus `thinkingLevelMap` ONLY when
   `Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0`.
   Aside reuses that builder through `buildAsideContribution`
   (`config-export.ts:1778-1780`), so the Claude rows are written with no
   effort control.

Every step is behaving as designed. The only missing fact is the ladder itself,
which was never declared for the native Anthropic providers.

`candidateCapabilityEvidence` still matters, but as BLAST RADIUS rather than as
the defect path — see 010.

## The adapter already supports effort

This is the fact that makes the fix a one-place change rather than a feature.
`src/adapters/anthropic.ts` has honored effort for a long time (line ~922):

- Adaptive families send `thinking: {type:"adaptive"}` plus
  `output_config: {effort}`. `adaptiveEffort()` (line 553) maps `minimal` to
  `low` because the wire rejects `minimal` with a 400, and accepts
  `low|medium|high|xhigh|max`.
- Older families send `thinking: {type:"enabled", budget_tokens}` sized by
  `reasoningBudget()` (line 463), which has a distinct budget for every rung:
  minimal 1024, low 4096, medium 8192, high 16384, xhigh 24576, max 32000.

So the proxy has always been willing to send effort for these models; it simply
never told any client the knob existed. A user could reach it by hand-editing
`thinkingLevelMap`, which is exactly the workaround shape that indicates a
missing advertisement rather than a missing capability.

## Which ladder is correct per family

`ADAPTIVE_THINKING_FAMILY_MINIMUMS` (line 483) splits the wire shapes, and its
comment records vendor verification against api.anthropic.com: sonnet>=5,
fable (any), opus>=4.7 require adaptive; haiku-4-5 and sonnet-4-5 reject it;
opus-4-6 and sonnet-4-6 accept both.

`ANTHROPIC_MODELS` (registry line 350) is: claude-fable-5-1, claude-fable-5,
claude-sonnet-5, claude-opus-5, claude-opus-4-8, claude-opus-4-7,
claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5.

Both wire shapes cover the same five rungs, so the honest ladder is the same for
every model in the list: `low, medium, high, xhigh, max`.

- `minimal` is deliberately EXCLUDED. Adaptive models 400 on it, and the
  adapter only survives it by silently rewriting it to `low`. Advertising a rung
  that collapses into another rung invites a user to pick a setting that does
  nothing.
- `none` is deliberately EXCLUDED. `supportsExplicitThinkingDisable` is seeded
  with sonnet>=5 ONLY, and its comment warns that a wrong entry turns a silent
  truncation into a 400. Fable in particular always thinks and rejects an
  explicit disable. A ladder-wide `none` would advertise an off switch that does
  not exist for most of the list.
- `ultra` is not an Anthropic concept; `reasoningBudget` has no case for it and
  it would fall through to the medium default.

## Blast radius of adding the ladder

`modelReasoningEfforts` is read by more than the catalog, so the change is
checked against each consumer. Two of these turned into required correctness
work rather than mere acknowledgement (010 phases 2 and 3).

- `src/clients/config-export.ts` — every exporter with an effort concept (pi,
  aside, prime, omp, dsh, hermes, openclaw, kimi, zcode) starts emitting the
  control. This is the user-visible fix.
- `src/providers/derive.ts:493` — enrichment copies the registry map only when
  the persisted provider has NO map
  (`if (!prov.modelReasoningEfforts && seed.modelReasoningEfforts)`). One
  customized Anthropic model would therefore suppress the registry ladder for
  all eight others. The neighbouring `modelInputModalities` line already uses
  the per-key `fillRecordOfArrays` for exactly this reason, and its comment
  documents the same class of bug. Requests are unaffected because
  `routedProviderConfig` merges per key (`src/router.ts:181-189`), so the
  symptom would be split-brain: correct on the wire, missing in the catalog.
- `src/routing/capability.ts:216-239` — `candidateCapabilityEvidence` reads the
  registry map directly and, unlike `configuredReasoningEfforts`
  (`reasoning-effort.ts:148`) and `supportedLadderFor`
  (`effort-policy.ts:119-127`), never consults `noReasoningModels`. Today that
  is harmless for Anthropic because there is no ladder to report; once one
  exists, a model the user explicitly disabled reasoning for would still present
  five supported rungs to `src/routing/evaluator.ts:141,218`.
- `src/server/effort-policy.ts:122` — supplies the ladder to the effort CAP.
  Note this is not a general per-request clamp: `effortCapAppliesTo` gates it
  (`src/server/responses/core.ts:2159-2163`), so it only engages when the user
  configured `effortCap`/`subagentEffortCap`.
- `src/routing/compatibility/behavior.ts:194-200` — `reasoning.supported` flips
  false to true and `reasoning.efforts` gains five rungs, which changes the
  Compatibility Lab behavior fingerprint for Anthropic. That invalidation is
  intended: the previous fingerprint recorded a capability the proxy really has.

### What does NOT change

`ultra` handling. `src/responses/parser.ts:814-820` already degrades `ultra` to
`max` at parse time, and `mapReasoningEffort` applies the same boundary
(`src/reasoning-effort.ts:209-225`). An earlier draft claimed the new ladder
would newly clamp `ultra`; that assertion is already green today and cannot
demonstrate activation.

The Codex catalog surface also already synthesizes `max`/`ultra` rungs for any
reasoning-capable routed row (`src/codex/catalog/effort.ts:225-237`), so this
change does not introduce `ultra` there either.

## Related defects found in the same evidence chain

Two more rows in the live catalog advertise no ladder. Recorded here and
investigated in 030 rather than silently bundled into this fix:

- `lidge/qwen3.8-27b-nvfp4` — the provider block has no `models` key at all and
  no `modelReasoningEfforts`.
- `opencode-free/muse-spark-1.2-contributor-free` — the provider declares
  `modelReasoningEfforts` for `deepseek-v4-flash-free` only, so the muse row
  falls through.

Neither is the reported bug, and each needs its own capability evidence before a
ladder can be asserted honestly.

# S19 L3 — Combo quota evidence and neutral contracts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**, C3, docs-only bounded delegation. The parent owns implementation, orchestration, loop and goal state.
- Goal: bring `gui/src/combo-workspace-data.ts` (650 lines) below 400 using quota/attention and neutral-type leaves; preserve all original named exports, native-catalog identity and the target-key sequence.
- Non-goals: quota policy changes, draft validation changes, new network requests, backend changes, normalizer fixes, alias-policy changes, new caching, or serialization rewrites.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. No tests, code edits or Git mutations executed during this draft.
- Stop: pure-move diff, every export still available, single state ownership, size/cycle evidence, focused and remote exact-tip full-suite/CI proof; no merge.
- Escalation: source drift, unlisted readers/callers, >400-line outputs, changed policy/signatures or cycles. **The 284-line extraction alone is about 568 raw add/delete lines, before plumbing. This exceeds a literal 500-line raw diff cap. Parent must approve an explicit pure-move size exception or expand 002 with an additional part before execution; this delegated plan cannot change the four-layer map.**
- Basis: docs `4cc219549`; code `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`, identical to this source in the working tree. Read train `000_plan.md`, `001_stale_check.md`, S19/gate in `002_layer_map.md` and `260905_modular_debt_ledger/015_lane_gui.md` (quota seam at original lines 295–490, key ownership at 97).

## Symbol inventory

Top-level declarations from `rg` were reconciled against `sg run --kind <function_declaration|lexical_declaration|interface_declaration|type_alias_declaration> --json=compact gui/src/combo-workspace-data.ts`. Inclusive line spans refer to origin/dev. Import statements are dependency edges; the extra native-catalog re-export row is included to preserve the complete public surface.

Consumers = distinct external importer files: `rg -l 'from ["\x27][^"\x27]*/combo-workspace-data(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts`, then `rg -l -w '<symbol>'` within that set. Private symbols have zero external consumers. Thirteen files import this path, enumerated below. T = `gui/src/combo-workspace-contracts.ts`; Q = `gui/src/combo-workspace-quota.ts`; R = residual original.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| SUPPORTED_NATIVE_OPENAI_SLUGS | imported binding re-export | 9–9 | yes | 0 | R; canonical owner remains native-models.ts |
| ComboStrategy | type | 11–11 | yes | 1 | T |
| ComboEffort | type | 12–12 | yes | 1 | T |
| COMBO_EFFORTS | const array | 14–14 | yes | 2 | R |
| COMBO_STRATEGIES | const array | 16–22 | yes | 1 | R |
| COMBO_STRATEGY_LABEL_KEYS | const record | 24–30 | yes | 1 | R |
| COMBO_STRATEGY_HINT_KEYS | const record | 32–38 | yes | 2 | R |
| COMBO_TARGETS_HINT_KEYS | const record | 40–46 | yes | 2 | R |
| COMBO_STRATEGY_SET | const Set | 48–48 | no | 0 | R |
| intersectComboEfforts | function | 54–81 | yes | 3 | R |
| ComboTarget | interface | 83–89 | yes | 2 | T |
| ComboQuotaState | type | 91–91 | yes | 0 | T |
| ProviderQuotaStates | type | 92–92 | yes | 5 | T |
| COMBO_QUOTA_MAX_AGE_MS | const | 95–95 | yes | 0 | Q |
| comboTargetKeySeq | let counter | 97–97 | no | 0 | R |
| newComboTarget | function | 99–106 | yes | 1 | R |
| normalizeImageInput | function | 109–111 | no | 0 | R |
| normalizeReasoningEffortMode | function | 113–115 | no | 0 | R |
| ComboItem | interface | 117–137 | yes | 9 | T |
| ComboSections | interface | 139–143 | yes | 0 | T |
| ComboAttentionItem | interface | 145–149 | yes | 0 | T |
| COMBO_ID_RE | const RegExp | 151–151 | yes | 0 | R |
| COMBO_ALIAS_RE | const RegExp | 153–153 | yes | 0 | R |
| NATIVE_OPENAI_FAMILY_RE | const RegExp | 154–154 | no | 0 | R |
| isValidComboId | function | 156–158 | yes | 1 | R |
| comboModelId | function | 160–162 | yes | 3 | R |
| comboPublicModelId | function | 165–168 | yes | 3 | R |
| updateComboAliasDraft | function | 171–181 | yes | 2 | R |
| normalizeAlias | function | 183–185 | no | 0 | R |
| normalizeStrategy | function | 187–191 | yes | 0 | R |
| normalizeStickyLimit | function | 193–197 | yes | 0 | R |
| normalizeDefaultEffort | function | 199–203 | yes | 0 | R |
| normalizeWeight | function | 205–209 | yes | 0 | R |
| parseComboList | function | 211–249 | yes | 3 | R |
| groupCombos | function | 251–261 | yes | 4 | R |
| filterCombos | function | 263–273 | yes | 2 | R |
| recordFromUnknown | function | 275–279 | no | 0 | Q |
| finiteNumber | function | 281–283 | no | 0 | Q |
| quotaTimestampIsFresh | function | 285–288 | no | 0 | Q |
| nonNegativeInteger | function | 290–293 | no | 0 | Q |
| aggregateWindowIsComplete | function | 295–306 | no | 0 | Q |
| aggregateEvidenceIsComplete | function | 308–359 | no | 0 | Q |
| quotaStateFromReport | function | 361–412 | no | 0 | Q |
| providerQuotaStatesFromReports | function | 415–431 | yes | 2 | Q |
| comboQuotaState | function | 437–457 | yes | 3 | Q |
| buildComboAttention | function | 459–490 | yes | 2 | Q |
| draftEquals | function | 492–509 | yes | 2 | R |
| toPutBody | function | 511–544 | yes | 3 | R |
| ComboDraftError | type | 546–565 | yes | 0 | T |
| validateComboDraft | function | 567–634 | yes | 3 | R |
| emptyDraft | function | 636–650 | yes | 4 | R |

## Leaf partition

Structural decision: extract quota parsing and attention together, sharing neutral contracts with the residual. Current callers → data facade → native model catalog + i18n types. Intended callers → same facade → Q → T, with facade → T; only the facade retains native-model runtime imports and target creation. Functional/type coupling only. Local combo-feature blast radius, no new backend dependency or endpoint.

Rejected alternatives: move only the 216-line quota block and leave a >400-line residual; import `ComboItem` back from the facade inside Q (type cycle); put domain DTOs in `components/combo-workspace-types.ts` (presentation owner already imports the facade, creating an upward dependency); move draft normalizers/key creation as well (unnecessary state churn). Do nothing, deletion and configuration do not discharge this modular debt. Keep existing exported constants/aliases instead of duplicating them.

Convention/search evidence: inspected `gui/src/combo-capabilities.ts:1`, `components/combo-workspace-types.ts:1`, `components/combo-workspace-controls.tsx:2`, the original public importers and existing hyphenated `combo-workspace-*` siblings. The existing component types are UI option/props types, not an alternative owner for the DTOs. Both new modules are siblings under `gui/src/`; no generic utils or barrel folder.

NEW files:

1. `gui/src/combo-workspace-contracts.ts`: every T row (nine types/interfaces). Move original spans 11–12, 83–93, 117–149 and 546–565 = **66 lines** including associated blanks. Expected **70 lines** with separators. Imports: **none**; `ComboItem`, `ComboSections` and quota/attention types resolve their dependencies locally. All definitions and optional-field comments remain verbatim.
2. `gui/src/combo-workspace-quota.ts`: every Q row. Move original 94–95 and 275–490 = **218 lines**. Expected **225 lines** including type import and separation. Its only import is:

```ts
import type { ComboAttentionItem, ComboItem, ComboQuotaState, ComboTarget, ProviderQuotaStates } from "./combo-workspace-contracts";
```

Residual `gui/src/combo-workspace-data.ts`: **expected 388 lines**, using a conservative 22-line plumbing reserve: 650 − 66 − 218 = 366 retained source lines. Keep all R declarations, original top comment, `SUPPORTED_NATIVE_OPENAI_SLUGS` import/re-export and `TKey` import. Exactly one target-key sequence owner remains here. No #b is required for residual size after the full proposed L3 move. Expected raw source diff about 600, not a claim of ≤500: require the parent's budget decision from Loop spec. If a new part is mandated, the parent must allocate its branch/doc and update successors before implementation; do not leave an unrecorded >400 residual or invent #b in this scope.

## Re-export block

Exact new named compatibility exports at the original path:

```ts
export type { ComboStrategy, ComboEffort, ComboTarget, ComboQuotaState, ProviderQuotaStates, ComboItem, ComboSections, ComboAttentionItem, ComboDraftError } from "./combo-workspace-contracts";
export { COMBO_QUOTA_MAX_AGE_MS, providerQuotaStatesFromReports, comboQuotaState, buildComboAttention } from "./combo-workspace-quota";
```

The residual uses six moved types and must import them explicitly:

```ts
import type { ComboStrategy, ComboEffort, ComboTarget, ComboItem, ComboSections, ComboDraftError } from "./combo-workspace-contracts";
```

No residual runtime call requires a quota function: `buildComboAttention` and its local call to `comboQuotaState` move together. Therefore no unused quota import is added. All remaining original exports stay declarations, including the exact original `export { SUPPORTED_NATIVE_OPENAI_SLUGS };` backed by its original import from `../../src/codex/catalog/native-models`. Do not replace that exported Set with a copy.

## Module-level state and cycles

- `COMBO_STRATEGY_SET` at `gui/src/combo-workspace-data.ts:48`: one Set, owned by R and used by `normalizeStrategy:187`. Do not rebuild it per call or move/copy it to T/Q.
- `comboTargetKeySeq:97`: one mutable counter in R, incremented only by `newComboTarget:99`. `parseComboList:211` and `emptyDraft:636` still call that same function. No initialization in a leaf or extra sequence per import path.
- `COMBO_EFFORTS:14`, `COMBO_STRATEGIES:16`, three label/hint records at 24/32/40 and regexes at 151/153/154 retain R ownership and identity. No new freezes or changed mutability contracts. `COMBO_QUOTA_MAX_AGE_MS:95` moves to Q once.
- Imported `SUPPORTED_NATIVE_OPENAI_SLUGS` is owned by `src/codex/catalog/native-models.ts`, not a new S19 Set. Keep its identity across the facade.
- Other Sets/Maps in this source (`effortSet:61`, `memberSet:74`, `commonSet:79`, `targets:611`) are function-local and stay so. There are no top-level WeakMaps, locks, timer or cache owners.
- Critical hypothetical cycle R → Q → R is avoided even for type edges: Q imports types only from T, and T imports nothing. Neither new leaf imports `components/combo-workspace-types.ts`, `combo-capabilities.ts` or the facade. Existing component → facade edges remain inward, not a route back into presentation.
- Quota parsing remains at the untrusted report boundary, preserving fail-unknown behavior. No new validation is added between typed internal calls. Existing >50-line functions are copied intact; this layer claims file-size relief, not a validator rewrite.

## Tests

Complete direct test-import `rg -l` list, all **unchanged** with old facade paths:

```text
tests/gui/combo-workspace-data.test.ts
gui/tests/combo-strategy-roundtrip.test.ts
gui/tests/combo-native-alias-editor.test.tsx
gui/tests/combo-workspace-dirty.test.tsx
gui/tests/combos-detail-tabs-dom.test.tsx
```

Import line anchors: 19, 9, 5, 5, 16 respectively. The other eight importer files are `gui/src/combo-capabilities.ts`, `gui/src/pages/Combos.tsx`, and `gui/src/components/{ComboWorkspace.tsx,combo-workspace-add-modal.tsx,combo-workspace-controls.tsx,combo-workspace-detail-panel.tsx,combo-workspace-overview-panel.tsx,combo-workspace-types.ts}`. Counts are by file, not the multiple import declarations in some components.

Text-oracle search: `rg -n 'combo-workspace-data(\.ts)?' tests gui/tests` and inspection of source-read sites found **no text reader of this file**. No retarget-to-leaf or add-leaf-to-scan-list action. `combos-detail-tabs-dom.test.tsx:139` reads the CSS, not this data module; unchanged.

Guards to drive red once during implementation: make the Q aggregate completeness predicate accept an incomplete aggregate and observe the existing fail-unknown quota cases in `tests/gui/combo-workspace-data.test.ts` fail; restore it. Add a public-API identity/uniqueness assertion in that existing test if its current coverage does not distinguish a split counter: calls to `newComboTarget`, `emptyDraft`, and `parseComboList` must allocate distinct keys through the original facade. Drive that guard red by resetting the one counter for each allocation, then restore. Do not export the private sequence for tests. No new test file or test-layout registration is needed. Existing strategy, native-alias and dirty/quota-save behavior tests keep their assertions.

## Verification

Future implementation gate in the L3 worktree; domains `tests/gui` combo view-model and `gui/tests` combo forms/strategy:

```sh
bun run typecheck
bun test tests/gui/combo-workspace-data.test.ts
bun test gui/tests/combo-strategy-roundtrip.test.ts gui/tests/combo-native-alias-editor.test.tsx gui/tests/combo-workspace-dirty.test.tsx gui/tests/combos-detail-tabs-dom.test.tsx
bun run privacy:scan
(cd gui && bun run lint && bun run build)
wc -l gui/src/combo-workspace-data.ts gui/src/combo-workspace-contracts.ts gui/src/combo-workspace-quota.ts
rg -l 'from ["\x27][^"\x27]*/combo-workspace-data(\.tsx?)?["\x27]' src gui/src gui/tests tests scripts
sg run --kind import_statement --json=compact gui/src/combo-workspace-contracts.ts gui/src/combo-workspace-quota.ts
rg -n 'comboTargetKeySeq|COMBO_STRATEGY_SET' gui/src
git diff --check
git diff --numstat origin/dev...HEAD
```

Zero failures/exit 0; each source output ≤400. Original importer set remains thirteen until L4 deliberately introduces the controlled-content consumer; adding a public-API assertion changes no importing file count. The single definition sites of counter/Set and no-backlink import graph must be shown, including type edges. Conditional core-Lab test does not apply: no protected backend source touched. Record raw-diff budget exception or expanded map approval **before** implementation proceeds beyond this bounded plan.

Full suites remotely only, on a parent-reserved, non-concurrent checkout:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-combo-workspace-data && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test && (cd gui && bun install --frozen-lockfile && bun test tests)'
```

Record remote SHA matching the pushed PR head, actual full-suite exit status/log, exact-head CI rollup, and unchanged combo GUI screenshot for the PR template. No local full suite, service restart or deployment. This section is not a claim that any test ran during drafting.

## Accept criteria

1. Every one of 50 declarations plus the native-catalog re-export is assigned once; only T/Q are new files.
2. The facade preserves all current value/type exports, including zero-consumer exports and imported Set identity; nine moved types and four moved values use the exact named re-export block.
3. R ≤400, T ≤400, Q ≤400; movement totals reconcile to 650 − 284 = 366 before plumbing. Parent-approved disposition exists for the >500 raw diff; no unauthorized part or branch is added.
4. Exactly one `comboTargetKeySeq` and `COMBO_STRATEGY_SET` definition remains in R; target-key lifetime and all normalizer/serializer bodies are unchanged.
5. Q has only its T type import; T has no imports. No runtime or type-only cycles are introduced.
6. Thirteen original consumer files keep their paths; all five direct-import tests, the negative probes, typecheck/privacy/GUI lint/build, remote suites and exact-head CI have successful fresh evidence.
7. No report validation, quota TTL/exhaustion precedence, native-alias policy, UI copy, CSS, backend or API behavior changes; PR base is L2 and no merge occurs.

## PR

Title: `refactor(gui): isolate combo quota evidence and contracts (split S19 L3/4)`

Branch: `codex/split-combo-workspace-data`. Base: `dev`. Closes: none.

Fill every repository PR-template Summary / Verification / Checklist section; include unchanged-GUI screenshot and explicit raw-diff budget disposition. DEV-STACK-03 map:

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 1 | #TBD-S19-L1 | codex/split-pages-compatibility-matrix-api | dev | pagination/error owner |
| 2 | #TBD-S19-L2 | codex/split-pages-CompatibilityMatrix | codex/split-pages-compatibility-matrix-api | matrix presentation leaves |
| 3 | #TBD-S19-L3 | codex/split-combo-workspace-data | dev | quota evidence and combo contracts; this layer |
| 4 | #TBD-S19-L4 | codex/split-components-combo-workspace-detail-panel | codex/split-combo-workspace-data | controlled Config contents |

Base: dev — no dependency on lower layers; this layer is the parent of 660 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02).

Review this layer only. Merge only with separate user authorization; no auto-merge.

## Loop spec

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

- Archetype: **pure-move**. Work class: **C3**, bounded docs-only subagent; parent owns orchestration, loop, goal, and execution worktrees. No cxc state commands here.
- Non-goals: no behavior fixes, parser changes, hash framing changes, new cache/state, durability rewrite, function-body refactor, public rename/removal, test weakening, caller import migration, or operational writes.
- Goal: consume L1's pure leaves, separate read snapshot/probe/transaction/adoption owners, and bring the original file and every new leaf to ≤400 lines.
- Verifier: **002 “Per-layer gate”**, instantiated below; current delegation verifies the two documents only, without test runs.
- Stop: six additional leaves, acyclic ownership, 44 preserved facade exports, and final size gates are independently verifiable; implementation remains gated on S10-SIZE-01.
- Escalation: stale source coordinates, behavior change, missing export, required edits outside S10, source-oracle uncertainty, cycle requiring a redesign, or the unsatisfied ≤500-line limit go to the parent. Do not edit 000/001/002 or add layers yourself.

Source/audit basis: docs HEAD `4cc219549`; pinned code `1362b1a38`; `000_plan.md`, `001_stale_check.md`, `002_layer_map.md` S10 rows 300/310; lane evidence `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:143–155`. The opening tip recorded in 000/001 is historical; this document's source coordinates use the pinned code above.

Structural decision (cxc-dev-architecture): a 1,652-line feature currently combines inventory, byte codecs, TOML edits, read projections, probe admission, and writes. Reject leaving it intact (misses the size goal), deleting/configuring behavior (not a pure move), widening `features.ts` (explicit boundary at source lines 4–8), or routing leaves through a new internal barrel (creates back-edges). Choose cohesive leaves in `src/codex/prompt-layers/` with a stable original-path compatibility facade. Reuse existing `prompt-journal.ts` and `prompt-lock.ts`, without moving or duplicating their durability/lock implementation.

Convention evidence: `src/config.ts:129` re-exports `./config/paths`; `src/config.ts:162` re-exports `./config/rebase-provenance`; `src/types/*.ts` and `src/codex/log-guard/*.ts` use focused sibling/subfolder leaves. This is the existing compatibility-boundary convention, not a new convenience `index.ts`.

Current map: `src/server/management/codex-prompt-routes.ts:26–49`, `src/server/management/context.ts:9`, and 6 tests → `prompt-layers.ts` → config/home/path helpers, marker, journal, lock, Node fs/path/crypto. Intended map: same external imports → original facade → read/transform/transaction leaves → those same dependencies. Blast radius: local Codex prompt feature; no HTTP route, DTO, CLI, auth, persistence format, or public signature change. Tests keep importing the facade.

Ordering is dependency-first among low-fan-in seams. L1 takes `toml-edit` (0 external importers), `revision` (1), and `paths`/`encoding`/`toml-read` (2 each), installing their prerequisite leaves together. L2 takes higher-fan-in `inventory` (3), `store` (3), `snapshot` (6), then `transaction` (1), `fingerprint` (1), and `adoption` (2). Those last low-fan-in operations cannot move earlier without also moving their snapshot/store dependencies or creating facade return edges. Original callers are not retargeted, so low consumer count is not used to justify export removal.

**S10-SIZE-01 — unresolved execution gate:** 002 says every layer stays ≤500 changed source lines, but two pure-move layers must remove at least `1652 - 400 = 1252` original lines, before adding leaves/imports. Even counting a moved line only once, `2 × 500 < 1252`; normal added+deleted diff accounting is larger. This concrete partition moves 518 original lines in L1 and 913 in L2. The parent must approve a documented pure-move size exception or revise 002's layer count before implementation. This delegated task does not grant that exception, add a third layer, or edit 002. The two documents remain the requested feasible **file partition**, not a claim that the current per-PR size budget is satisfiable.

## Symbol inventory

Ranges are inclusive declaration spans at `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`, not line numbers after L1. Read with `git show origin/dev:src/codex/prompt-layers.ts | nl -ba`; `git diff origin/dev -- src/codex/prompt-layers.ts` was empty. The installed TypeScript package exposes version metadata rather than the compiler AST API, so declaration endpoints were obtained with installed ast-grep, cross-checked against `rg -n '^(export )?(function|const|let|interface|type|class|enum) '`.

There are **89 declarations plus the existing export-alias statement at line 505**, all inventoried below. Imports at 29–46 are dependency bindings, listed in Leaf partition rather than counted as locally owned declarations. Consumer counts are **distinct external files importing this binding from the original facade**, not textual hits of homonyms such as `Paths` or `commit`. Method: `rg -l 'from.*prompt-layers"' src gui/src scripts tests` finds 8 files (2 runtime, 6 tests); ast-grep `import_statement` selects their facade imports, and `rg -w <symbol>` counts matching import blocks. The alias is counted under `readFileBytes`. Private declarations have 0 external consumers; zero is not a deletion license. Comments mentioning `WriteError`, `adoptDeveloperInstructions`, and `salvageProjection` in the route test are excluded.

In the table, leaf names expand to `src/codex/prompt-layers/<name>.ts`; `residual` means `src/codex/prompt-layers.ts`. L2 targets remain in the original file through L1.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `LayerClass` | type | 53–58 | yes | 0 | `inventory.ts` (L2) |
| `ToggleId` | type | 60–65 | yes | 0 | `inventory.ts` (L2) |
| `LayerDescriptor` | interface | 67–76 | yes | 0 | `inventory.ts` (L2) |
| `LAYER_INVENTORY` | const | 88–122 | yes | 3 | `inventory.ts` (L2) |
| `TOGGLE_KEYS` | const | 130–136 | no | 0 | `inventory.ts` (L2) |
| `TOGGLE_IDS` | const | 138–138 | yes | 1 | `inventory.ts` (L2) |
| `isToggleId` | function | 140–142 | yes | 1 | `inventory.ts` (L2) |
| `Paths` | interface | 148–152 | yes | 2 | `paths.ts` (L1) |
| `activeCodexHome` | function | 154–163 | no | 0 | `paths.ts` (L1) |
| `activeConfigPath` | function | 165–167 | yes | 0 | `paths.ts` (L1) |
| `activeStorePath` | function | 169–171 | yes | 0 | `paths.ts` (L1) |
| `activeBaseVariantDir` | function | 181–183 | yes | 0 | `paths.ts` (L1) |
| `PROBE_INSTRUCTION_FILES` | const | 191–191 | no | 0 | `fingerprint.ts` (L2) |
| `probeInstructionFilenames` | function | 203–213 | no | 0 | `fingerprint.ts` (L2) |
| `rootArrayEntries` | function | 237–242 | no | 0 | `toml-read.ts` (L1) |
| `PARSE_FAILED` | const | 249–249 | no | 0 | `toml-read.ts` (L1) |
| `rootValue` | function | 252–262 | no | 0 | `toml-read.ts` (L1) |
| `scanRootArrayEntries` | function | 272–296 | no | 0 | `toml-read.ts` (L1) |
| `probeProjectDocDirs` | function | 313–337 | no | 0 | `fingerprint.ts` (L2) |
| `projectRootMarkers` | function | 340–345 | no | 0 | `fingerprint.ts` (L2) |
| `hasRootKey` | function | 354–358 | no | 0 | `toml-read.ts` (L1) |
| `scanHasRootKey` | function | 361–364 | no | 0 | `toml-read.ts` (L1) |
| `updateFingerprintField` | function | 384–388 | no | 0 | `revision.ts` (L1) |
| `journalPathFor` | function | 390–392 | no | 0 | `paths.ts` (L1) |
| `lockPathFor` | function | 394–396 | no | 0 | `paths.ts` (L1) |
| `CharacterFinding` | interface | 404–409 | yes | 0 | `encoding.ts` (L1) |
| `normalizeBody` | function | 412–414 | yes | 2 | `encoding.ts` (L1) |
| `findInvalidCharacter` | function | 417–440 | yes | 2 | `encoding.ts` (L1) |
| `encodeBasicString` | function | 448–450 | yes | 1 | `encoding.ts` (L1) |
| `decodeBasicString` | function | 458–477 | yes | 1 | `encoding.ts` (L1) |
| `readFileOrNull` | function | 484–491 | alias readFileBytes (505) | 0 | `revision.ts` (L1) |
| `computeRevision` | function | 493–503 | yes | 1 | `revision.ts` (L1) |
| `TABLE_HEADER` | const | 513–513 | no | 0 | `toml-read.ts` (L1) |
| `rootLines` | function | 516–520 | no | 0 | `toml-read.ts` (L1) |
| `tableLines` | function | 523–531 | no | 0 | `toml-read.ts` (L1) |
| `boolInLines` | function | 533–541 | no | 0 | `toml-read.ts` (L1) |
| `DEV_INSTRUCTIONS_KEY` | const | 555–555 | no | 0 | `toml-read.ts` (L1) |
| `CANONICAL_LINE` | const | 556–556 | no | 0 | `toml-read.ts` (L1) |
| `ANY_DEV_INSTRUCTIONS` | const | 557–557 | no | 0 | `toml-read.ts` (L1) |
| `Ownership` | type | 559–567 | yes | 0 | `toml-read.ts` (L1) |
| `inspectOwnership` | function | 569–582 | yes | 2 | `toml-read.ts` (L1) |
| `CustomLayer` | interface | 588–594 | yes | 2 | `store.ts` (L2) |
| `LAYER_ID` | const | 596–596 | no | 0 | `store.ts` (L2) |
| `isCustomLayer` | function | 598–605 | no | 0 | `store.ts` (L2) |
| `parseStore` | function | 608–622 | yes | 1 | `store.ts` (L2) |
| `composeProjection` | function | 625–627 | yes | 2 | `store.ts` (L2) |
| `ToggleState` | interface | 633–645 | yes | 0 | `snapshot.ts` (L2) |
| `Drift` | type | 647–652 | yes | 0 | `snapshot.ts` (L2) |
| `BaseVariant` | interface | 655–660 | yes | 0 | `snapshot.ts` (L2) |
| `BaseSelection` | type | 678–678 | yes | 1 | `snapshot.ts` (L2) |
| `PromptLayerSnapshot` | interface | 680–694 | yes | 1 | `snapshot.ts` (L2) |
| `readToggle` | function | 696–713 | no | 0 | `snapshot.ts` (L2) |
| `readModelInstructionsFile` | function | 715–733 | no | 0 | `snapshot.ts` (L2) |
| `BASE_VARIANT_ID` | const | 736–736 | no | 0 | `snapshot.ts` (L2) |
| `readBaseVariants` | function | 746–776 | yes | 1 | `snapshot.ts` (L2) |
| `resolveBaseSelection` | function | 785–805 | yes | 0 | `snapshot.ts` (L2) |
| `readPromptLayers` | function | 811–855 | yes | 6 | `snapshot.ts` (L2) |
| `computePromptProbeStateFingerprint` | function | 887–942 | yes | 1 | `fingerprint.ts` (L2) |
| `probeSkillManifests` | function | 960–974 | no | 0 | `fingerprint.ts` (L2) |
| `WriteError` | type | 980–993 | yes | 1 | `transaction.ts` (L2) |
| `WriteResult` | type | 995–997 | yes | 1 | `transaction.ts` (L2) |
| `dominantEol` | function | 1000–1005 | no | 0 | `toml-edit.ts` (L1) |
| `splitLines` | function | 1007–1009 | no | 0 | `toml-edit.ts` (L1) |
| `splitBom` | function | 1023–1027 | no | 0 | `toml-edit.ts` (L1) |
| `joinLines` | function | 1029–1032 | no | 0 | `toml-edit.ts` (L1) |
| `firstTableIndex` | function | 1034–1037 | no | 0 | `toml-edit.ts` (L1) |
| `setRootBool` | function | 1040–1056 | no | 0 | `toml-edit.ts` (L1) |
| `setRootString` | function | 1065–1081 | no | 0 | `toml-edit.ts` (L1) |
| `setTableBool` | function | 1084–1108 | no | 0 | `toml-edit.ts` (L1) |
| `setProjection` | function | 1115–1142 | no | 0 | `toml-edit.ts` (L1) |
| `serializeStore` | function | 1144–1146 | no | 0 | `store.ts` (L2) |
| `Mutation` | interface | 1148–1151 | no | 0 | `transaction.ts` (L2) |
| `commit` | function | 1158–1272 | no | 0 | `transaction.ts` (L2) |
| `rollback` | function | 1275–1294 | no | 0 | `transaction.ts` (L2) |
| `setToggle` | function | 1297–1306 | yes | 2 | residual |
| `selectBaseVariant` | function | 1316–1335 | yes | 2 | residual |
| `MAX_BASE_VARIANTS` | const | 1338–1338 | yes | 2 | residual |
| `writeBaseVariant` | function | 1351–1434 | yes | 2 | residual |
| `newBaseVariantId` | function | 1436–1442 | no | 0 | residual |
| `writeCustomLayers` | function | 1445–1466 | yes | 2 | residual |
| `AdoptPreview` | interface | 1476–1484 | yes | 0 | `adoption.ts` (L2) |
| `newLayerId` | function | 1486–1492 | no | 0 | `store.ts` (L2) |
| `previewAdopt` | function | 1498–1536 | yes | 2 | `adoption.ts` (L2) |
| `adoptDeveloperInstructions` | function | 1539–1565 | yes | 2 | `adoption.ts` (L2) |
| `removeUnownedProjection` | function | 1568–1579 | no | 0 | `toml-edit.ts` (L1) |
| `SalvagePreview` | interface | 1589–1595 | yes | 0 | `adoption.ts` (L2) |
| `UNRECOVERABLE` | const | 1597–1604 | no | 0 | `adoption.ts` (L2) |
| `previewSalvage` | function | 1606–1620 | yes | 2 | `adoption.ts` (L2) |
| `salvageProjection` | function | 1627–1652 | yes | 2 | `adoption.ts` (L2) |
| `readFileBytes` | export alias of `readFileOrNull` | 505–505 | yes | 0 | `revision.ts` (L1); preserve alias exactly |

## Leaf partition

Prerequisite: all five L1 leaves in 300 exist unchanged. This layer creates the six files below; it does not move L1 bodies again.

### src/codex/prompt-layers/inventory.ts

- Move original ranges `src/codex/prompt-layers.ts:48–143` including comments and blank lines: 96 lines.
- Symbols: `LayerClass`, `ToggleId`, `LayerDescriptor`, `LAYER_INVENTORY`, `TOGGLE_KEYS`, `TOGGLE_IDS`, `isToggleId`.
- Expected length: **96 lines**, including 0 one-line imports; limit 400.
- Own imports: none; do not add a facade import.

### src/codex/prompt-layers/store.ts

- Move original ranges `src/codex/prompt-layers.ts:584–628`, `src/codex/prompt-layers.ts:1144–1147`, `src/codex/prompt-layers.ts:1486–1493` including comments and blank lines: 57 lines.
- Symbols: `CustomLayer`, `LAYER_ID`, `isCustomLayer`, `parseStore`, `composeProjection`, `serializeStore`, `newLayerId`.
- Expected length: **59 lines**, including 1 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { randomBytes } from "node:crypto";
```

### src/codex/prompt-layers/snapshot.ts

- Move original ranges `src/codex/prompt-layers.ts:629–856` including comments and blank lines: 228 lines.
- Symbols: `ToggleState`, `Drift`, `BaseVariant`, `BaseSelection`, `PromptLayerSnapshot`, `readToggle`, `readModelInstructionsFile`, `BASE_VARIANT_ID`, `readBaseVariants`, `resolveBaseSelection`, `readPromptLayers`.
- Expected length: **238 lines**, including 9 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandUserPath } from "../../config";
import { activeConfigPath, activeStorePath, activeBaseVariantDir, type Paths } from "./paths";
import { LAYER_INVENTORY, TOGGLE_KEYS, TOGGLE_IDS, type ToggleId } from "./inventory";
import { readFileOrNull, computeRevision } from "./revision";
import { decodeBasicString } from "./encoding";
import { rootLines, tableLines, boolInLines, inspectOwnership } from "./toml-read";
import { parseStore, composeProjection, type CustomLayer } from "./store";
```

### src/codex/prompt-layers/fingerprint.ts

- Move original ranges `src/codex/prompt-layers.ts:185–214`, `src/codex/prompt-layers.ts:298–346`, `src/codex/prompt-layers.ts:857–975` including comments and blank lines: 198 lines.
- Symbols: `PROBE_INSTRUCTION_FILES`, `probeInstructionFilenames`, `probeProjectDocDirs`, `projectRootMarkers`, `computePromptProbeStateFingerprint`, `probeSkillManifests`.
- Expected length: **208 lines**, including 9 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expandUserPath } from "../../config";
import { resolveCodexHomeDir } from "../home";
import { activeConfigPath, activeStorePath, activeBaseVariantDir, type Paths } from "./paths";
import { readFileOrNull, computeRevision, updateFingerprintField } from "./revision";
import { readBaseVariants, resolveBaseSelection } from "./snapshot";
import { rootArrayEntries, hasRootKey } from "./toml-read";
```

### src/codex/prompt-layers/transaction.ts

- Move original ranges `src/codex/prompt-layers.ts:976–998`, `src/codex/prompt-layers.ts:1148–1295` including comments and blank lines: 171 lines.
- Symbols: `WriteError`, `WriteResult`, `Mutation`, `commit`, `rollback`.
- Expected length: **178 lines**, including 6 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { existsSync } from "node:fs";
import { activeConfigPath, activeStorePath, journalPathFor, lockPathFor, type Paths } from "./paths";
import { readFileOrNull, computeRevision } from "./revision";
import { readPromptLayers, type PromptLayerSnapshot } from "./snapshot";
import { durableWrite, durableDelete, encodeJournal, ensureDir, hashBytes, recoverIfNeeded as recoverJournal, type JournalRecord } from "../prompt-journal";
import { release, stillHeld, tryAcquire } from "../prompt-lock";
```

### src/codex/prompt-layers/adoption.ts

- Move original ranges `src/codex/prompt-layers.ts:1468–1485`, `src/codex/prompt-layers.ts:1494–1566`, `src/codex/prompt-layers.ts:1581–1652` including comments and blank lines: 163 lines.
- Symbols: `AdoptPreview`, `previewAdopt`, `adoptDeveloperInstructions`, `SalvagePreview`, `UNRECOVERABLE`, `previewSalvage`, `salvageProjection`.
- Expected length: **174 lines**, including 10 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { activeConfigPath, activeStorePath, type Paths } from "./paths";
import { readFileOrNull } from "./revision";
import { decodeBasicString, normalizeBody, findInvalidCharacter } from "./encoding";
import { inspectOwnership } from "./toml-read";
import { composeProjection, serializeStore, newLayerId, type CustomLayer } from "./store";
import { removeUnownedProjection, setProjection } from "./toml-edit";
import { commit, type WriteResult } from "./transaction";
import { durableWriteExclusive } from "../prompt-journal";
```

Inherited L1 leaf sizes: `encoding.ts` 81, `revision.ts` 55, `paths.ts` 54, `toml-read.ts` 180, `toml-edit.ts` 163. Final residual keeps `setToggle`, `selectBaseVariant`, `MAX_BASE_VARIANTS`, `writeBaseVariant`, `newBaseVariantId`, and `writeCustomLayers` (original 1296–1467). All other declarations have exactly one leaf owner. No #c layer is presumed.

| Stage | Original lines extracted this layer | New leaves this layer (expected total) | Original residual |
|---|---:|---:|---:|
| Basis | 0 | 0 | 1652 |
| L1 / 300 #a | 518 | 533 across 5 files | 1146 |
| L2 / 310 #b | 913 | 953 across 6 files | 234 |

Accounting uses inclusive source chunks (comments retained), one-line import/export statements as shown, and one blank line after each non-empty leaf import block. L1: `1652 - 518 - 2 + 14 = 1146`: remove the two obsolete facade imports at old 33/35, add five local imports + seven re-exports + two separator lines. L2: `1146 - 913 - 13 + 4 + 10 = 234`: reduce the remaining sixteen old import lines to three; grow five leaf-local import lines to nine; add ten named re-export lines. Original retained content is lines 1–47, 297, 365, and 1296–1467 with imports rewritten; the final implementation body chunk is 172 lines. Total completed source estimate: `533 + 953 + 234 = 1720`; the +68 lines over 1652 are import/re-export/spacing overhead, not duplicated bodies. Expected counts are formatting estimates, but the ≤400 final cap is mechanical.

Only cross-leaf production dependencies gain named leaf exports: paths → `journalPathFor, lockPathFor`; revision → `readFileOrNull, updateFingerprintField`; toml-read → `rootArrayEntries, hasRootKey, rootLines, tableLines, boolInLines, TABLE_HEADER, DEV_INSTRUCTIONS_KEY, ANY_DEV_INSTRUCTIONS`; toml-edit → `setRootBool, setRootString, setTableBool, setProjection, removeUnownedProjection`; inventory → `TOGGLE_KEYS`; store → `serializeStore, newLayerId`; snapshot → `BASE_VARIANT_ID`; transaction → `commit`. Keep all other original private declarations private. `readFileOrNull` keeps its declaration name and the existing leaf alias `export { readFileOrNull as readFileBytes };`. None of these extra internal names is added to the original facade's public surface.

## Re-export block

The complete final block is below, including all seven L1 lines. The five direct exported mutation/limit declarations remain unchanged in the residual; `newBaseVariantId` remains private.

```ts
export { activeConfigPath, activeStorePath, activeBaseVariantDir } from "./prompt-layers/paths";
export type { Paths } from "./prompt-layers/paths";
export { computeRevision, readFileBytes } from "./prompt-layers/revision";
export { normalizeBody, findInvalidCharacter, encodeBasicString, decodeBasicString } from "./prompt-layers/encoding";
export type { CharacterFinding } from "./prompt-layers/encoding";
export { inspectOwnership } from "./prompt-layers/toml-read";
export type { Ownership } from "./prompt-layers/toml-read";
export { LAYER_INVENTORY, TOGGLE_IDS, isToggleId } from "./prompt-layers/inventory";
export type { LayerClass, ToggleId, LayerDescriptor } from "./prompt-layers/inventory";
export { parseStore, composeProjection } from "./prompt-layers/store";
export type { CustomLayer } from "./prompt-layers/store";
export { readBaseVariants, resolveBaseSelection, readPromptLayers } from "./prompt-layers/snapshot";
export type { ToggleState, Drift, BaseVariant, BaseSelection, PromptLayerSnapshot } from "./prompt-layers/snapshot";
export { computePromptProbeStateFingerprint } from "./prompt-layers/fingerprint";
export type { WriteError, WriteResult } from "./prompt-layers/transaction";
export { previewAdopt, adoptDeveloperInstructions, previewSalvage, salvageProjection } from "./prompt-layers/adoption";
export type { AdoptPreview, SalvagePreview } from "./prompt-layers/adoption";
```

Re-exports bind nothing locally. Replace the residual import section with these exact imports:

```ts
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { durableWrite, durableDelete, ensureDir } from "./prompt-journal";
import { activeConfigPath, activeBaseVariantDir, type Paths } from "./prompt-layers/paths";
import { readFileOrNull } from "./prompt-layers/revision";
import { normalizeBody, findInvalidCharacter } from "./prompt-layers/encoding";
import { inspectOwnership } from "./prompt-layers/toml-read";
import { setRootBool, setRootString, setTableBool, setProjection } from "./prompt-layers/toml-edit";
import { isToggleId, TOGGLE_KEYS } from "./prompt-layers/inventory";
import { composeProjection, serializeStore, type CustomLayer } from "./prompt-layers/store";
import { readBaseVariants, resolveBaseSelection, readPromptLayers, BASE_VARIANT_ID, type BaseSelection, type BaseVariant } from "./prompt-layers/snapshot";
import { commit, type WriteResult } from "./prompt-layers/transaction";
```

Remove all other old imports from the original file. In particular, `snapshot.ts` must not obtain `Paths`, `CustomLayer`, or `ToggleId` from the facade, and `transaction.ts` must not obtain `PromptLayerSnapshot` from it.

## Module-level state and cycles

All coordinates below are in `origin/dev:src/codex/prompt-layers.ts`.

| Top-level state/constant | Line(s) | Single owner after S10 | Preservation |
|---|---|---|---|
| `LAYER_INVENTORY` | 88–122 | `prompt-layers/inventory.ts` (L2) | same shallow `Object.freeze`, same rows/order and reference identity |
| `TOGGLE_KEYS` | 130–136 | `prompt-layers/inventory.ts` (L2) | one object; export internally for readers/writers, never copy |
| `TOGGLE_IDS` | 138 | `prompt-layers/inventory.ts` (L2) | same frozen derivation after `TOGGLE_KEYS` |
| `PROBE_INSTRUCTION_FILES` | 191 | `prompt-layers/fingerprint.ts` (L2) | same tuple/order |
| `PARSE_FAILED` | 249 | `prompt-layers/toml-read.ts` (L1) | unique Symbol stays beside every identity comparison, not recreated |
| `TABLE_HEADER` | 513 | `prompt-layers/toml-read.ts` (L1) | one non-global RegExp shared with edits |
| `DEV_INSTRUCTIONS_KEY` | 555 | `prompt-layers/toml-read.ts` (L1) | same literal, edit leaf imports it |
| `CANONICAL_LINE` | 556 | `prompt-layers/toml-read.ts` (L1) | remains private non-global RegExp |
| `ANY_DEV_INSTRUCTIONS` | 557 | `prompt-layers/toml-read.ts` (L1) | one non-global RegExp shared with edits |
| `LAYER_ID` | 596 | `prompt-layers/store.ts` (L2) | validator-local owner |
| `BASE_VARIANT_ID` | 736 | `prompt-layers/snapshot.ts` (L2) | same object; residual writer imports it directly |
| `MAX_BASE_VARIANTS` | 1338 | original residual | retain exported constant and cap, no snapshot back-import |
| `UNRECOVERABLE` | 1597–1604 | `prompt-layers/adoption.ts` (L2) | same frozen list shared by previews |

There is **no top-level `let`, Map, Set, WeakMap, cached path, or acquired lock handle** in this file. `new Set` at 619, 1437, and 1487 is call-local; hashes at 494/892 and `acquired/handle` at 1172/1174 are call-local. The existing filesystem lock stays owned by `src/codex/prompt-lock.ts`; commit at 1158–1272 moves whole to `transaction.ts`, with its acquisition/recovery/check/rollback/release sequence intact. It does not introduce another mutex or move lock acquisition to module evaluation.

Path resolution stays call-time (154–183). Pure reads (811–855) never acquire a lock, repair, recover, or write; the journal/lock leaves are not dependencies of `snapshot.ts`. The length-framed revision and probe fields share `revision.ts:updateFingerprintField` (384–388), not copied implementations. Journal hashBytes remains a different existing contract in `prompt-journal.ts`; do not substitute one hash for the other.

Cycle prevention and coupling classification:

- Current audited graph has no return path (lane 013:151); the eight direct consumers confirmed by rg include no reverse imports from the current dependencies.
- L1 direction: residual → paths/revision/encoding/toml-read/toml-edit; toml-edit → toml-read + encoding; toml-read → encoding. No leaf imports `../prompt-layers` or `./index`.
- L2 direction: residual → inventory/store/snapshot/transaction; adoption → transaction + store + TOML leaves; transaction → snapshot; fingerprint → snapshot + paths + revision + toml-read; snapshot → inventory/store + L1 leaves. Every leaf imports its exact lower owner, including types.
- Moving commit alone while leaving `readPromptLayers` behind would form `facade → transaction → facade`; L2 moves snapshot first within the same layer. `WriteResult` moves with transaction and imports `PromptLayerSnapshot` from snapshot, never from facade.
- Moving fingerprint alone while importing `readBaseVariants/resolveBaseSelection` through the facade has the same problem; they move together in L2. Snapshot exports `BASE_VARIANT_ID` internally so the remaining writer never makes snapshot import its caller.
- These edges are functional/sequential coupling. Existing file-before-config and clear-key-before-delete ordering at 1391–1409/1423–1431 is temporal coupling, preserved rather than redesigned. No new common mutable state or content coupling is introduced. Existing internal declarations become leaf exports only when another production owner actually needs them; they do not become new facade exports.

Future static check: capture ast-grep `import_statement` and `export_statement` edges for the facade and all eleven leaves, resolve relative paths, include type-only edges, and require a DFS/SCC result with no cycle containing a split module. The explicit adjacency above is the expected graph. Check transitive return paths through unchanged config/home/journal/lock dependencies as well; do not install a new analysis dependency or claim typecheck alone detects cycles.

## Tests

Direct importer list from `rg -l 'from.*prompt-layers"' tests` (all remain **unchanged**, importing the original facade):

| Test file | Import line at origin/dev | Disposition |
|---|---:|---|
| `tests/codex-integration/codex-prompt-layers.test.ts` | 20 | unchanged |
| `tests/codex-integration/codex-prompt-layers-read.test.ts` | 16 | unchanged |
| `tests/codex-integration/codex-prompt-layers-write.test.ts` | 15 | unchanged |
| `tests/codex-integration/codex-prompt-base-variants.test.ts` | 16 | unchanged |
| `tests/codex-integration/codex-prompt-adopt.test.ts` | 19 | unchanged |
| `tests/codex-integration/codex-prompt-route.test.ts` | 14 | unchanged |

**Exact-path text-oracle readers of `src/codex/prompt-layers.ts`: none.** Reproducing 001's broad read-function/basename intersection returns the following 3 files, but inspection confirms each reads fixture data, not this source. This resolves the apparent disagreement with lane 013:152 rather than inventing retargets.

| Broad-search candidate | Exact read site and actual target | Disposition |
|---|---|---|
| `tests/codex-integration/codex-prompt-layers-write.test.ts` | line 37 `readFileSync(path, "utf8")`: fixture config/store through local helper | unchanged; no retarget-to-leaf |
| `tests/codex-integration/codex-prompt-layers-read.test.ts` | lines 203/204 `Bun.file(paths.configPath/storePath).text()`; line 217 `Bun.file(nested).exists()` | unchanged; fixture files, no source reader |
| `tests/codex-integration/codex-prompt-adopt.test.ts` | lines 75/93/111/178 read fixture config; line 163 reads salvage backup | unchanged; no retarget-to-leaf |

Other importer read sites: `codex-prompt-base-variants.test.ts:34` reads fixture files; `codex-prompt-route.test.ts:70` reads fixtures, while its actual source guards read `src/server/management/codex-prompt-routes.ts` at **806** and `src/codex/prompt-text-probe.ts` at **811/820**. All unchanged: neither source is split in S10. There is no S10 retarget-to-leaf and no existing explicit source scan list requiring add-leaf-to-scan-list.

`tests/lab/core-lab-boundary.test.ts:69` is a generic graph reader (not an explicit prompt-source oracle). Its import/re-export traversal discovers reachable leaves automatically; keep its `PROTECTED` roots and assertions unchanged. Run it as an extra boundary check because the facade is consumed from management code, even though 002 only mandates it when server/router/lib paths themselves are touched. Do not weaken the graph or manufacture an exemption.

The future executor drives the named guards red once by a temporary mutation in its own isolated layer worktree, records the actual expected failure, restores the mutation, then runs green. No test, mutation, or red/green exercise is executed during this planning task.

Guards to drive red once in L2:

1. `tests/codex-integration/codex-prompt-layers-write.test.ts:117`: temporarily disable revision rejection in `prompt-layers/transaction.ts:commit`; stale-revision/no-write guard must fail. Preserve lock/refusal cases at 215/224/252 and rollback at 337.
2. `tests/codex-integration/codex-prompt-route.test.ts:1090`: temporarily remove length framing in the shared `revision.ts:updateFingerprintField` in the isolated worktree; the field-boundary collision guard must fail. Restore L1 byte content afterward; no L1 change remains in L2.
3. `tests/codex-integration/codex-prompt-route.test.ts:1410`: temporarily omit the skill-manifest fields in `fingerprint.ts`; manifest-edit invalidation must fail. Keep quoted-key, parent-directory, and parser-failure cases at 1278/1322/1365.
4. `tests/codex-integration/codex-prompt-base-variants.test.ts:131`: temporarily omit clearing a selected variant's config key in the residual writer; live-delete guard must fail.
5. `tests/codex-integration/codex-prompt-layers-read.test.ts:193` and `codex-prompt-adopt.test.ts:154` remain read-purity/backup characterization coverage; their expected byte/mode checks must not be altered.

Transaction/journal code can carry config bytes containing credentials. Preserve existing privacy and fail-closed checks exactly; any newly found vulnerability belongs in ignored scratch, not this public plan. No new disclosure or behavior repair is part of the move.

## Verification

This instantiates **002_layer_map.md → Per-layer gate**, not the stale “003” reference in 000. These are future execution commands, **not checks run in this docs-only delegation**. Domain: `tests/codex-integration`; additional graph guard: `tests/lab/core-lab-boundary.test.ts`.

```sh
bun run typecheck
bun test tests/codex-integration/codex-prompt-layers.test.ts \
  tests/codex-integration/codex-prompt-layers-read.test.ts \
  tests/codex-integration/codex-prompt-layers-write.test.ts \
  tests/codex-integration/codex-prompt-base-variants.test.ts \
  tests/codex-integration/codex-prompt-adopt.test.ts \
  tests/codex-integration/codex-prompt-route.test.ts \
  tests/codex-integration/codex-prompt-journal.test.ts \
  tests/codex-integration/codex-prompt-lock.test.ts \
  tests/codex-integration/codex-prompt-text-probe.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/codex/prompt-layers/encoding.ts \
  src/codex/prompt-layers/revision.ts \
  src/codex/prompt-layers/paths.ts \
  src/codex/prompt-layers/toml-read.ts \
  src/codex/prompt-layers/toml-edit.ts \
  src/codex/prompt-layers/inventory.ts \
  src/codex/prompt-layers/store.ts \
  src/codex/prompt-layers/snapshot.ts \
  src/codex/prompt-layers/fingerprint.ts \
  src/codex/prompt-layers/transaction.ts \
  src/codex/prompt-layers/adoption.ts \
  src/codex/prompt-layers.ts
rg -n 'from "[^"]*/prompt-layers"' src gui/src scripts tests | wc -l
```

Require each executed command's real exit code 0 and focused tests 0 failures. The external importer baseline is **8** (6 tests + 2 runtime), unaffected by new leaf-local imports. Compare the 44-name facade export surface against origin/dev, including types, zero-consumer names, and `readFileBytes`. Verify declaration bodies with AST/moved-code diff after stripping only import/export linkage changes. Compare the exact moved source ranges and require the acyclic edge result described above. All eleven leaves and the estimated 234-line original must be ≤400; no later S10 layer is assumed.

Full suite **never locally**. Only the authorized executor uses the 002 remote workspace on `lidge`, verifies that its fetched branch SHA equals the PR head, and runs this gate under Bash pipefail so `tail` cannot mask a test failure:

```sh
ssh lidge "bash -lc 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-prompt-layers-b && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'"
```

Before dispatch, the parent/executor must check that the shared remote CI checkout is not occupied by another stack; this docs task reserves nothing. Record exact-head CI rollup in the owning layer doc and fill the repository PR template with actual verification evidence. No merge, release, source dogfood, or running-service restart is included.

## Accept criteria

1. Parent records a resolution of **S10-SIZE-01** before implementation; no claim that two ≤500-line layers can satisfy the current 1,652→≤400 goal.
2. The source basis is rechecked at execution; every one of the 89 declarations and the line-505 alias has exactly one owner in this inventory. No body, branch, signature, identifier, error string, persistence byte format, or ordered operation changes.
3. Exactly six additional leaves match this partition; all eleven leaves and the residual are ≤400 (residual expected 234). L1 leaves are unchanged in the committed L2 delta.
4. All **44 existing exported names**, including 16 types and the `readFileBytes` alias, remain importable from `src/codex/prompt-layers.ts`; no private helper leaks through that facade. External importer count stays **8**.
5. Every needed residual binding is explicitly imported; no leaf imports the facade, no type-only cycle, no second lock/journal/constant owner, no newly reachable Lab code.
6. All six existing importer tests remain facade-based; the broad “3 textoracle” count is reconciled against actual read sites. Named guards have recorded red→restored-green evidence during execution, not invented passing results.
7. Instantiated typecheck, focused tests, privacy scan, boundary guard, size/import checks, static cycle inspection, remote full-suite exit, and exact-head CI are recorded before the PR is review-ready. No local full suite.
8. Future source diff touches only the original and this layer's planned leaves unless the parent explicitly expands scope. This delegation itself writes only 300/310 Markdown, runs no tests, mutates no git state, and invokes no orchestration/loop/goal commands.

## PR

Title: `refactor(codex): isolate prompt reads and journaled commits (split S10 L2/2)`

Branch: `codex/split-codex-prompt-layers-b`.
Base: `codex/split-codex-prompt-layers-a`.
Closes: **none**.

DEV-STACK-03 map for the PR body (PR numbers intentionally unassigned placeholders):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S10-L2 | codex prompt #b ← you are here | `codex/split-codex-prompt-layers-b` | `codex/split-codex-prompt-layers-a` | read snapshot, fingerprint, single transaction owner, final size cap |
| 1 | #TBD-S10-L1 | codex prompt #a | `codex/split-codex-prompt-layers-a` | `dev` | byte codecs, paths, TOML leaves; preserve facade |

Depends on #TBD-S10-L1. Review this layer's diff only. Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, and Checklist; cite S10-SIZE-01 and the parent's recorded resolution before marking ready. Each layer needs its own actual checks and exact-head CI. Cascade parent edits to L2 before publishing any update; merge remains bottom-up and separately user-authorized. This planning task creates no branch or PR.

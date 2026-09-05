## Loop spec

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

- Archetype: **pure-move**. Work class: **C3**, bounded docs-only subagent; parent owns orchestration, loop, goal, and execution worktrees. No cxc state commands here.
- Non-goals: no behavior fixes, parser changes, hash framing changes, new cache/state, durability rewrite, function-body refactor, public rename/removal, test weakening, caller import migration, or operational writes.
- Goal: move the low-consumer path/byte/TOML dependency leaves first while every current export remains available at the original path; leave the documented remainder for 310 #b.
- Verifier: **002 “Per-layer gate”**, instantiated below; current delegation verifies the two documents only, without test runs.
- Stop: five leaves and the compatible residual are independently verifiable; L1 implementation may start only after S10-SIZE-01 is resolved.
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
| `LayerClass` | type | 53–58 | yes | 0 | `inventory.ts` (L2; retain for #b) |
| `ToggleId` | type | 60–65 | yes | 0 | `inventory.ts` (L2; retain for #b) |
| `LayerDescriptor` | interface | 67–76 | yes | 0 | `inventory.ts` (L2; retain for #b) |
| `LAYER_INVENTORY` | const | 88–122 | yes | 3 | `inventory.ts` (L2; retain for #b) |
| `TOGGLE_KEYS` | const | 130–136 | no | 0 | `inventory.ts` (L2; retain for #b) |
| `TOGGLE_IDS` | const | 138–138 | yes | 1 | `inventory.ts` (L2; retain for #b) |
| `isToggleId` | function | 140–142 | yes | 1 | `inventory.ts` (L2; retain for #b) |
| `Paths` | interface | 148–152 | yes | 2 | `paths.ts` (L1) |
| `activeCodexHome` | function | 154–163 | no | 0 | `paths.ts` (L1) |
| `activeConfigPath` | function | 165–167 | yes | 0 | `paths.ts` (L1) |
| `activeStorePath` | function | 169–171 | yes | 0 | `paths.ts` (L1) |
| `activeBaseVariantDir` | function | 181–183 | yes | 0 | `paths.ts` (L1) |
| `PROBE_INSTRUCTION_FILES` | const | 191–191 | no | 0 | `fingerprint.ts` (L2; retain for #b) |
| `probeInstructionFilenames` | function | 203–213 | no | 0 | `fingerprint.ts` (L2; retain for #b) |
| `rootArrayEntries` | function | 237–242 | no | 0 | `toml-read.ts` (L1) |
| `PARSE_FAILED` | const | 249–249 | no | 0 | `toml-read.ts` (L1) |
| `rootValue` | function | 252–262 | no | 0 | `toml-read.ts` (L1) |
| `scanRootArrayEntries` | function | 272–296 | no | 0 | `toml-read.ts` (L1) |
| `probeProjectDocDirs` | function | 313–337 | no | 0 | `fingerprint.ts` (L2; retain for #b) |
| `projectRootMarkers` | function | 340–345 | no | 0 | `fingerprint.ts` (L2; retain for #b) |
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
| `CustomLayer` | interface | 588–594 | yes | 2 | `store.ts` (L2; retain for #b) |
| `LAYER_ID` | const | 596–596 | no | 0 | `store.ts` (L2; retain for #b) |
| `isCustomLayer` | function | 598–605 | no | 0 | `store.ts` (L2; retain for #b) |
| `parseStore` | function | 608–622 | yes | 1 | `store.ts` (L2; retain for #b) |
| `composeProjection` | function | 625–627 | yes | 2 | `store.ts` (L2; retain for #b) |
| `ToggleState` | interface | 633–645 | yes | 0 | `snapshot.ts` (L2; retain for #b) |
| `Drift` | type | 647–652 | yes | 0 | `snapshot.ts` (L2; retain for #b) |
| `BaseVariant` | interface | 655–660 | yes | 0 | `snapshot.ts` (L2; retain for #b) |
| `BaseSelection` | type | 678–678 | yes | 1 | `snapshot.ts` (L2; retain for #b) |
| `PromptLayerSnapshot` | interface | 680–694 | yes | 1 | `snapshot.ts` (L2; retain for #b) |
| `readToggle` | function | 696–713 | no | 0 | `snapshot.ts` (L2; retain for #b) |
| `readModelInstructionsFile` | function | 715–733 | no | 0 | `snapshot.ts` (L2; retain for #b) |
| `BASE_VARIANT_ID` | const | 736–736 | no | 0 | `snapshot.ts` (L2; retain for #b) |
| `readBaseVariants` | function | 746–776 | yes | 1 | `snapshot.ts` (L2; retain for #b) |
| `resolveBaseSelection` | function | 785–805 | yes | 0 | `snapshot.ts` (L2; retain for #b) |
| `readPromptLayers` | function | 811–855 | yes | 6 | `snapshot.ts` (L2; retain for #b) |
| `computePromptProbeStateFingerprint` | function | 887–942 | yes | 1 | `fingerprint.ts` (L2; retain for #b) |
| `probeSkillManifests` | function | 960–974 | no | 0 | `fingerprint.ts` (L2; retain for #b) |
| `WriteError` | type | 980–993 | yes | 1 | `transaction.ts` (L2; retain for #b) |
| `WriteResult` | type | 995–997 | yes | 1 | `transaction.ts` (L2; retain for #b) |
| `dominantEol` | function | 1000–1005 | no | 0 | `toml-edit.ts` (L1) |
| `splitLines` | function | 1007–1009 | no | 0 | `toml-edit.ts` (L1) |
| `splitBom` | function | 1023–1027 | no | 0 | `toml-edit.ts` (L1) |
| `joinLines` | function | 1029–1032 | no | 0 | `toml-edit.ts` (L1) |
| `firstTableIndex` | function | 1034–1037 | no | 0 | `toml-edit.ts` (L1) |
| `setRootBool` | function | 1040–1056 | no | 0 | `toml-edit.ts` (L1) |
| `setRootString` | function | 1065–1081 | no | 0 | `toml-edit.ts` (L1) |
| `setTableBool` | function | 1084–1108 | no | 0 | `toml-edit.ts` (L1) |
| `setProjection` | function | 1115–1142 | no | 0 | `toml-edit.ts` (L1) |
| `serializeStore` | function | 1144–1146 | no | 0 | `store.ts` (L2; retain for #b) |
| `Mutation` | interface | 1148–1151 | no | 0 | `transaction.ts` (L2; retain for #b) |
| `commit` | function | 1158–1272 | no | 0 | `transaction.ts` (L2; retain for #b) |
| `rollback` | function | 1275–1294 | no | 0 | `transaction.ts` (L2; retain for #b) |
| `setToggle` | function | 1297–1306 | yes | 2 | residual |
| `selectBaseVariant` | function | 1316–1335 | yes | 2 | residual |
| `MAX_BASE_VARIANTS` | const | 1338–1338 | yes | 2 | residual |
| `writeBaseVariant` | function | 1351–1434 | yes | 2 | residual |
| `newBaseVariantId` | function | 1436–1442 | no | 0 | residual |
| `writeCustomLayers` | function | 1445–1466 | yes | 2 | residual |
| `AdoptPreview` | interface | 1476–1484 | yes | 0 | `adoption.ts` (L2; retain for #b) |
| `newLayerId` | function | 1486–1492 | no | 0 | `store.ts` (L2; retain for #b) |
| `previewAdopt` | function | 1498–1536 | yes | 2 | `adoption.ts` (L2; retain for #b) |
| `adoptDeveloperInstructions` | function | 1539–1565 | yes | 2 | `adoption.ts` (L2; retain for #b) |
| `removeUnownedProjection` | function | 1568–1579 | no | 0 | `toml-edit.ts` (L1) |
| `SalvagePreview` | interface | 1589–1595 | yes | 0 | `adoption.ts` (L2; retain for #b) |
| `UNRECOVERABLE` | const | 1597–1604 | no | 0 | `adoption.ts` (L2; retain for #b) |
| `previewSalvage` | function | 1606–1620 | yes | 2 | `adoption.ts` (L2; retain for #b) |
| `salvageProjection` | function | 1627–1652 | yes | 2 | `adoption.ts` (L2; retain for #b) |
| `readFileBytes` | export alias of `readFileOrNull` | 505–505 | yes | 0 | `revision.ts` (L1); preserve alias exactly |

## Leaf partition

This layer creates the following five files. No files are created by this planning turn outside its assigned two Markdown documents.

### src/codex/prompt-layers/encoding.ts

- Move original ranges `src/codex/prompt-layers.ts:398–478` including comments and blank lines: 81 lines.
- Symbols: `CharacterFinding`, `normalizeBody`, `findInvalidCharacter`, `encodeBasicString`, `decodeBasicString`.
- Expected length: **81 lines**, including 0 one-line imports; limit 400.
- Own imports: none; do not add a facade import.

### src/codex/prompt-layers/revision.ts

- Move original ranges `src/codex/prompt-layers.ts:366–389`, `src/codex/prompt-layers.ts:479–506` including comments and blank lines: 52 lines.
- Symbols: `updateFingerprintField`, `readFileOrNull`, `computeRevision`; retain the existing `readFileOrNull as readFileBytes` alias at original line 505.
- Expected length: **55 lines**, including 2 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { existsSync, readFileSync } from "node:fs";
import { createHash, type Hash } from "node:crypto";
```

### src/codex/prompt-layers/paths.ts

- Move original ranges `src/codex/prompt-layers.ts:144–184`, `src/codex/prompt-layers.ts:390–397` including comments and blank lines: 49 lines.
- Symbols: `Paths`, `activeCodexHome`, `activeConfigPath`, `activeStorePath`, `activeBaseVariantDir`, `journalPathFor`, `lockPathFor`.
- Expected length: **54 lines**, including 4 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandUserPath } from "../../config";
import { CODEX_CONFIG_PATH } from "../paths";
```

### src/codex/prompt-layers/toml-read.ts

- Move original ranges `src/codex/prompt-layers.ts:215–296`, `src/codex/prompt-layers.ts:347–364`, `src/codex/prompt-layers.ts:507–583` including comments and blank lines: 177 lines.
- Symbols: `rootArrayEntries`, `PARSE_FAILED`, `rootValue`, `scanRootArrayEntries`, `hasRootKey`, `scanHasRootKey`, `TABLE_HEADER`, `rootLines`, `tableLines`, `boolInLines`, `DEV_INSTRUCTIONS_KEY`, `CANONICAL_LINE`, `ANY_DEV_INSTRUCTIONS`, `Ownership`, `inspectOwnership`.
- Expected length: **180 lines**, including 2 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { OCX_SECTION_MARKER } from "../injected-marker";
import { decodeBasicString } from "./encoding";
```

### src/codex/prompt-layers/toml-edit.ts

- Move original ranges `src/codex/prompt-layers.ts:999–1143`, `src/codex/prompt-layers.ts:1567–1580` including comments and blank lines: 159 lines.
- Symbols: `dominantEol`, `splitLines`, `splitBom`, `joinLines`, `firstTableIndex`, `setRootBool`, `setRootString`, `setTableBool`, `setProjection`, `removeUnownedProjection`.
- Expected length: **163 lines**, including 3 one-line imports and one separating blank line; limit 400.
- Own imports:

```ts
import { OCX_SECTION_MARKER } from "../injected-marker";
import { encodeBasicString } from "./encoding";
import { TABLE_HEADER, ANY_DEV_INSTRUCTIONS, DEV_INSTRUCTIONS_KEY } from "./toml-read";
```

The residual retains every L2 declaration in the inventory, plus the six final mutation declarations. **Residual >400 is intentional only for L1; 310_codex_prompt_layers_b.md takes the rest.**

| Stage | Original lines extracted this layer | New leaves this layer (expected total) | Original residual |
|---|---:|---:|---:|
| Basis | 0 | 0 | 1652 |
| L1 / 300 #a | 518 | 533 across 5 files | 1146 |
| L2 / 310 #b | 913 | 953 across 6 files | 234 |

Accounting uses inclusive source chunks (comments retained), one-line import/export statements as shown, and one blank line after each non-empty leaf import block. L1: `1652 - 518 - 2 + 14 = 1146`: remove the two obsolete facade imports at old 33/35, add five local imports + seven re-exports + two separator lines. L2: `1146 - 913 - 13 + 4 + 10 = 234`: reduce the remaining sixteen old import lines to three; grow five leaf-local import lines to nine; add ten named re-export lines. Original retained content is lines 1–47, 297, 365, and 1296–1467 with imports rewritten; the final implementation body chunk is 172 lines. Total completed source estimate: `533 + 953 + 234 = 1720`; the +68 lines over 1652 are import/re-export/spacing overhead, not duplicated bodies. Expected counts are formatting estimates, but the ≤400 final cap is mechanical.

Only cross-leaf production dependencies gain named leaf exports: paths → `journalPathFor, lockPathFor`; revision → `readFileOrNull, updateFingerprintField`; toml-read → `rootArrayEntries, hasRootKey, rootLines, tableLines, boolInLines, TABLE_HEADER, DEV_INSTRUCTIONS_KEY, ANY_DEV_INSTRUCTIONS`; toml-edit → `setRootBool, setRootString, setTableBool, setProjection, removeUnownedProjection`; inventory → `TOGGLE_KEYS`; store → `serializeStore, newLayerId`; snapshot → `BASE_VARIANT_ID`; transaction → `commit`. Keep all other original private declarations private. `readFileOrNull` keeps its declaration name and the existing leaf alias `export { readFileOrNull as readFileBytes };`. None of these extra internal names is added to the original facade's public surface.

## Re-export block

Insert these seven lines; the remaining exports stay as direct declarations until #b.

```ts
export { activeConfigPath, activeStorePath, activeBaseVariantDir } from "./prompt-layers/paths";
export type { Paths } from "./prompt-layers/paths";
export { computeRevision, readFileBytes } from "./prompt-layers/revision";
export { normalizeBody, findInvalidCharacter, encodeBasicString, decodeBasicString } from "./prompt-layers/encoding";
export type { CharacterFinding } from "./prompt-layers/encoding";
export { inspectOwnership } from "./prompt-layers/toml-read";
export type { Ownership } from "./prompt-layers/toml-read";
```

Re-exports bind nothing locally. Add these explicit local imports for the retained code:

```ts
import { activeConfigPath, activeStorePath, activeBaseVariantDir, journalPathFor, lockPathFor, type Paths } from "./prompt-layers/paths";
import { readFileOrNull, computeRevision, updateFingerprintField } from "./prompt-layers/revision";
import { normalizeBody, findInvalidCharacter, decodeBasicString } from "./prompt-layers/encoding";
import { rootArrayEntries, hasRootKey, rootLines, tableLines, boolInLines, inspectOwnership } from "./prompt-layers/toml-read";
import { setRootBool, setRootString, setTableBool, setProjection, removeUnownedProjection } from "./prompt-layers/toml-edit";
```

Remove original `CODEX_CONFIG_PATH` import at 33 and `OCX_SECTION_MARKER` import at 35; remove `realpathSync` and type `Hash` from the remaining multi-binding imports at 29/31. Retain the other original imports: filesystem reads, `dirname/join/resolve`, `createHash/randomBytes`, `expandUserPath`, `resolveCodexHomeDir`, journal functions/types, and lock functions are still used by the L2 residual.

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

Guards to drive red once in L1:

1. `tests/codex-integration/codex-prompt-layers.test.ts:138–146`: temporarily break one encoding escape in `prompt-layers/encoding.ts`; grammar/round-trip assertions must fail.
2. `tests/codex-integration/codex-prompt-layers-write.test.ts:280`: temporarily return an empty BOM from the moved `splitBom` in `prompt-layers/toml-edit.ts`; byte-zero assertion must fail. Also preserve existing root/table placement cases at 57/85/95 and CRLF case at 104.
3. `tests/codex-integration/codex-prompt-layers-read.test.ts:112`: temporarily relax adjacency in `prompt-layers/toml-read.ts:inspectOwnership`; marker-two-lines-up guard must fail.

These mutation exercises add no permanent tests or new layout-manifest entries. Keep existing source guards at route-test 806/811/820 unchanged.

## Verification

This instantiates **002_layer_map.md → Per-layer gate**, not the stale “003” reference in 000. These are future execution commands, **not checks run in this docs-only delegation**. Domain: `tests/codex-integration`; additional graph guard: `tests/lab/core-lab-boundary.test.ts`.

```sh
bun run typecheck
bun test tests/codex-integration/codex-prompt-layers.test.ts \
  tests/codex-integration/codex-prompt-layers-read.test.ts \
  tests/codex-integration/codex-prompt-layers-write.test.ts \
  tests/codex-integration/codex-prompt-base-variants.test.ts \
  tests/codex-integration/codex-prompt-adopt.test.ts \
  tests/codex-integration/codex-prompt-route.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/codex/prompt-layers/encoding.ts \
  src/codex/prompt-layers/revision.ts \
  src/codex/prompt-layers/paths.ts \
  src/codex/prompt-layers/toml-read.ts \
  src/codex/prompt-layers/toml-edit.ts \
  src/codex/prompt-layers.ts
rg -n 'from "[^"]*/prompt-layers"' src gui/src scripts tests | wc -l
```

Require each executed command's real exit code 0 and focused tests 0 failures. The external importer baseline is **8** (6 tests + 2 runtime), unaffected by new leaf-local imports. Compare the 44-name facade export surface against origin/dev, including types, zero-consumer names, and `readFileBytes`. Verify declaration bodies with AST/moved-code diff after stripping only import/export linkage changes. Compare the exact moved source ranges and require the acyclic edge result described above. Allow only this layer's explicitly recorded 1,146-line residual; 310 #b owns its remaining extraction.

Full suite **never locally**. Only the authorized executor uses the 002 remote workspace on `lidge`, verifies that its fetched branch SHA equals the PR head, and runs this gate under Bash pipefail so `tail` cannot mask a test failure:

```sh
ssh lidge "bash -lc 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-prompt-layers-a && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'"
```

Before dispatch, the parent/executor must check that the shared remote CI checkout is not occupied by another stack; this docs task reserves nothing. Record exact-head CI rollup in the owning layer doc and fill the repository PR template with actual verification evidence. No merge, release, source dogfood, or running-service restart is included.

## Accept criteria

1. Parent records a resolution of **S10-SIZE-01** before implementation; no claim that two ≤500-line layers can satisfy the current 1,652→≤400 goal.
2. The source basis is rechecked at execution; every one of the 89 declarations and the line-505 alias has exactly one owner in this inventory. No body, branch, signature, identifier, error string, persistence byte format, or ordered operation changes.
3. Exactly five new leaves match this partition, each ≤400; residual expected 1146 and explicitly assigned to 310 #b.
4. All **44 existing exported names**, including 16 types and the `readFileBytes` alias, remain importable from `src/codex/prompt-layers.ts`; no private helper leaks through that facade. External importer count stays **8**.
5. Every needed residual binding is explicitly imported; no leaf imports the facade, no type-only cycle, no second lock/journal/constant owner, no newly reachable Lab code.
6. All six existing importer tests remain facade-based; the broad “3 textoracle” count is reconciled against actual read sites. Named guards have recorded red→restored-green evidence during execution, not invented passing results.
7. Instantiated typecheck, focused tests, privacy scan, boundary guard, size/import checks, static cycle inspection, remote full-suite exit, and exact-head CI are recorded before the PR is review-ready. No local full suite.
8. Future source diff touches only the original and this layer's planned leaves unless the parent explicitly expands scope. This delegation itself writes only 300/310 Markdown, runs no tests, mutates no git state, and invokes no orchestration/loop/goal commands.

## PR

Title: `refactor(codex): extract prompt byte and TOML leaves (split S10 L1/2)`

Branch: `codex/split-codex-prompt-layers-a`.
Base: `dev`.
Closes: **none**.

DEV-STACK-03 map for the PR body (PR numbers intentionally unassigned placeholders):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S10-L2 | codex prompt #b | `codex/split-codex-prompt-layers-b` | `codex/split-codex-prompt-layers-a` | read snapshot, fingerprint, single transaction owner, final size cap |
| 1 | #TBD-S10-L1 | codex prompt #a ← you are here | `codex/split-codex-prompt-layers-a` | `dev` | byte codecs, paths, TOML leaves; preserve facade |

Review this layer's diff only. Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, and Checklist; cite S10-SIZE-01 and the parent's recorded resolution before marking ready. Each layer needs its own actual checks and exact-head CI. Cascade parent edits to L2 before publishing any update; merge remains bottom-up and separately user-authorized. This planning task creates no branch or PR.

## P stale-check (2026-09-05, wp300)

origin/dev 3c920af5f; prompt-layers.ts unchanged since 445742966 (1652 lines); 25 slice anchors confirmed by sed. Base `dev` (S10 bottom; 310 #b chains on it). Subdirectory `src/codex/prompt-layers/` follows existing precedent (src/codex/catalog/, src/codex/log-guard/). 003 INTERMEDIATE-RESIDUAL-01 applies: the 1146 residual after #a is bounded by #b (→ 234). Text oracles: three prompt-layers tests read source (per 001) — the audit must list their exact read sites and dispositions. Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change.

## A amendment (Lovelace audit, GO-WITH-FIXES blockers=1 → folded)

1. Test change: "all importer tests unchanged" applies to existing assertions and import paths. The authorized test change for CI hygiene is one appended test in tests/codex-integration/codex-prompt-layers.test.ts: seam identity (facade vs leaf) for computeRevision, encodeBasicString/decodeBasicString, inspectOwnership; a decodeBasicString round-trip via the encoding leaf; and a readFileSync+repoPath guard that no leaf under src/codex/prompt-layers/ matches /from\s+["']\.\.\/prompt-layers["']/.
2. Text oracles: the "3 tests read source" claim (001 broad count, plan:356) is false — audit verified none of the codex-prompt-* tests reads prompt-layers.ts as source (all reads are fixture config/store files; codex-prompt-route.test.ts:806/811/820 read codex-prompt-routes.ts and prompt-text-probe.ts, untouched). No retarget.
3. Residual imports: also drop `readFileSync` from the node:fs import (its only use, :487, moves to revision.ts). S10-SIZE-01 is resolved by 003 PURE-MOVE-SIZE-01 (stale plan:20 wording void).
Audit-verified structure: 89/90 declaration ranges exact, 518 disjoint extracted lines, leaf own-imports complete and minimal, DAG toml-edit → toml-read → encoding (+ toml-edit → encoding), paths/revision standalone, 23/23 residual bindings covered, 44/44 exports preserved, 6 test importers exact.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-300.dQlJzd/wt` (branch `codex/split-codex-prompt-layers-a`, base origin/dev 3c920af5f). Executor: gpt-6-astra high (Plato, 01a06f7a-8a4e-7e10-a991-aa39a3799f4a).
- Commits: baef8af7f (move: encoding 81, revision 56, paths 55, toml-read 182, toml-edit 164, prompt-layers.ts residual 1146), f2c9b29aa (test: codex-prompt-layers.test.ts — seam identity, decode round-trip, no back-edge), 82e069c9f (main agent: trimmed the trailing blank line at each leaf EOF flagged by `git diff --check`; leaves 80/54/55/181/163). Diff: 7 files.
- Residual 1146 > 400 is the planned intermediate state (003 INTERMEDIATE-RESIDUAL-01; #b layer 310 → 234).
- Local gate: typecheck 0; focused (6 files) 205 pass / 0 fail; core-lab-boundary 17/0; privacy passed; 8 original-path importers unchanged; 89 declarations single-owned; 44/44 exports.
- Red-drives: (a) decodeBasicString identity → drift/adopt-preview tests + seam test fail, restored; (b) setProjection marker broken → custom-layers write test fails, restored; (c) lab import in paths.ts → management-api transitive guard fails via codex-prompt-routes → prompt-layers → paths → lab/paths, restored 17/0.

- Adversarial diff review (Anscombe, gpt-6-astra high, 01a06f7f-3ae0-7e32-80cb-8c84cb0284c4): VERDICT: PASS (slices exact modulo 5 inserted blank separators between slices, residual reconstruction exact at 1146, 44/44 exports incl. readFileBytes === revision.readFileOrNull, 17 seams not leaked, DAG per plan, no cycle; #b starting numbers match — 310 line-219 estimates off by one per leaf).
- lidge full suite at 82e069c9f: SUITE_EXIT=0, 18067 pass / 0 fail / 16 skip (/tmp/suite-split-300.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3590 (base dev, head 82e069c9f). CI rollup at record time: OPEN draft=false 82e069c9f =1 =5 CANCELLED=1 SUCCESS=2

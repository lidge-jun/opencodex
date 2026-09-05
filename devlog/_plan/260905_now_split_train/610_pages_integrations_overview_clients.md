# S18 L1 — Overview contracts and primary row adapters

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only delegated task. No implementation, tests, Git mutation, or orchestration was performed here.
- Goal: reduce `gui/src/pages/integrations/overview-clients.ts` from 555 to an expected 378 physical lines, retaining all 15 current exports at that path. Move existing contracts and the Codex/credential row adapters; no new behavior.
- Non-goals: native toggle policy, journal-map relocation, client ordering, translation changes, cache policy, API changes, merge/release, or decomposition of long functions left within the limit.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; this document is a plan, not a green gate receipt.
- Stop: two leaves and the residual satisfy size/export/oracle checks and the layer's exact-head checks are recorded. Stop and re-inventory if the source changes before implementation.
- Escalation: changes beyond these moves, changed API semantics, cycles requiring another owner, or a measured source diff above 500 lines go to the parent before expanding the layer. S18 L2's remaining component debt is not resolved by L1.

Basis: docs HEAD `4cc219549`; code `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line ranges below refer to that code revision. Read `000_plan.md`, `001_stale_check.md`, the S18 rows and gate in `002_layer_map.md`, and `015_lane_gui.md:359–370`. The lane names the adapter seam and specifically leaves ordered assembly and `JOURNAL_KIND_KEY` at the existing boundary.

Structural decision: the file combines DTOs, source-specific row adapters, and ordered aggregation. Do nothing/configure cannot satisfy the size goal; deleting mappings changes behavior. Reusing `integration-api.ts`, `native-api.ts`, `cursor-api.ts`, and `IntegrationStateBadge.tsx` contracts is retained, not replaced. Moving every native adapter would require a larger diff; moving types alone leaves about 447 lines after compatibility exports. Chosen move is contracts plus the two primary-surface adapters, with no external importer migration. Consequence: a type-only contract leaf becomes the single owner of shared types, and the original module imports the adapter leaf without a back-edge.

Current map: `IntegrationsOverview.tsx:15`, `RollbackHistory.tsx:23`, `components/integration-marks.ts:18`, and three GUI test files import the original boundary; the boundary depends on the five existing contract/API owners at lines 15–24. Intended map: those six importers → unchanged boundary → `overview-primary-rows.ts` → `overview-client-types.ts` → existing contracts. Blast radius: local integrations feature and its existing type consumers. No package export, route, or wire contract changes. Sibling naming follows `integration-api.ts`, `native-api.ts`, `cursor-api.ts`, and `refusal-copy.ts`; no new internal `index.ts`.

## Symbol inventory

Ranges were checked with `git show origin/dev:<path> | nl -ba` and `sg run --lang typescript --kind function_declaration/interface_declaration --json=compact --stdin`; `rg` covers type aliases and constants. Inventory covers all 25 top-level owned declarations, not imported bindings. Consumer counts are distinct external files from `rg -l -w '<symbol>' src gui/src scripts tests gui/tests`, excluding this source, then resolving imports versus comments/homonyms. `0` does not mean unused inside this module.

Target abbreviations: `types` = `gui/src/pages/integrations/overview-client-types.ts`; `primary` = `gui/src/pages/integrations/overview-primary-rows.ts`; `residual` = original path.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| OverviewClientId | type alias | 26–32 | yes, type | 1 importer; 2 name-hit files | types |
| ApiKeyReadPhase | type alias | 35–35 | yes, type | 1 | types |
| ApiKeysOverviewRow | interface | 49–55 | yes, type | 1 | types |
| OverviewRows | interface | 57–60 | yes, type | 0 | types |
| OverviewRow | interface | 62–95 | yes, type | 1 | types |
| CodexRoutingPayload | interface | 98–102 | yes, type | 0 | types |
| ClaudeCodePayload | interface | 103–106 | yes, type | 0 | types |
| ClaudeDesktopPayload | interface | 107–117 | yes, type | 0 | types |
| GrokPayload | interface | 118–121 | yes, type | 0 | types |
| OverviewSources | interface | 123–140 | yes, type | 3 | types |
| FILE_LABEL_KEY | const record | 142–155 | no | 0 | residual |
| JOURNAL_KIND_KEY | const record | 165–176 | yes, value | 1 importer + 1 text oracle | residual |
| isAppliedState | function | 178–180 | yes, value | 0 | residual |
| codexRow | function | 191–224 | no | 0 | primary |
| keysRow | function | 227–250 | no | 0 importers; 2 property/local-name hits | primary |
| claudeDetailKey | function | 253–263 | no | 0 | residual |
| claudeRow | function | 265–302 | no | 0 | residual |
| claudeDesktopRow | function | 314–384 | no | 0 | residual |
| grokDetail | function | 394–401 | no | 0 | residual |
| grokRow | function | 403–437 | no | 0 | residual |
| cursorRow | function | 444–468 | no | 0 importers; 1 local-name hit | residual |
| fileRow | function | 470–488 | no | 0 | residual |
| buildOverviewRows | function | 495–539 | yes, value | 4 | residual |
| OverviewCounts | interface | 541–546 | yes, type | 0 | types |
| countOverviewRows | function | 548–555 | yes, value | 2 | residual |

`integration-marks.test.ts:22` only mentions `OverviewClientId` in prose; it imports the marks owner, not this type. `keysRow` external hits refer to the result property/local variable, and the `cursorRow` hit is a test-local variable. The actual external imports are three production files plus three tests, not all seven basename-hit files (the seventh is the journal source reader).

## Leaf partition

1. **`gui/src/pages/integrations/overview-client-types.ts` — expected 128 lines.** Move source 26–140 (115 lines, including inter-declaration comments) and 541–546 (6), separated by one blank line, after the following five import lines and one blank line. Symbols: all 11 type exports in the inventory. Keep fields, optionality, comments, and unions verbatim.

   ```ts
   import type { TKey } from "../../i18n/shared";
   import type { VisualIntegrationState } from "./IntegrationStateBadge";
   import type { FileIntegrationClientId, IntegrationStatus } from "./integration-api";
   import type { NativeIntegrationClientId, NativeStatus } from "./native-api";
   import type { CursorIntegrationStatus } from "./cursor-api";
   ```

2. **`gui/src/pages/integrations/overview-primary-rows.ts` — expected 72 lines.** Move source 182–250 (69 lines, including the Codex and key comments), adding `export` to the existing `codexRow` and `keysRow` declarations solely for the original owner to import. Two import lines plus one blank line:

   ```ts
   import type { TKey } from "../../i18n/shared";
   import type { ApiKeyReadPhase, ApiKeysOverviewRow, CodexRoutingPayload, OverviewRow } from "./overview-client-types";
   ```

3. **Residual `gui/src/pages/integrations/overview-clients.ts` — expected 378 lines.** Keep header, `FILE_LABEL_KEY`, `JOURNAL_KIND_KEY`, `isAppliedState`, all Claude/Desktop/Grok/Cursor/file adapters, ordered `buildOverviewRows`, and `countOverviewRows`. Keep original imports at 15–24 except drop the unused `NativeIntegrationClientId` binding from line 23 (retain `NativeStatus`). Add exactly the 13 one-line imports/re-exports below, using existing surrounding blank lines.

Arithmetic: `555 - 115 - 6 - 69 + 13 = 378`; leaves `128 + 72`; total planned source `578`, versus `555` before (23 lines of wiring/separation). Expected added+deleted source diff is about 405 lines, with a 450-line planning allowance; measure it at implementation, including tests. Both leaves and residual are ≤400, no `#b` for this file. This is not an `#a/#b` series; the chosen executable leaves have zero external consumers and leave the higher-fan-in aggregation/map stable.

## Re-export block

Exact additions to the original path (no `export *`, no exported identifier renames):

```ts
export type { OverviewClientId } from "./overview-client-types";
export type { ApiKeyReadPhase } from "./overview-client-types";
export type { ApiKeysOverviewRow } from "./overview-client-types";
export type { OverviewRows } from "./overview-client-types";
export type { OverviewRow } from "./overview-client-types";
export type { CodexRoutingPayload } from "./overview-client-types";
export type { ClaudeCodePayload } from "./overview-client-types";
export type { ClaudeDesktopPayload } from "./overview-client-types";
export type { GrokPayload } from "./overview-client-types";
export type { OverviewSources } from "./overview-client-types";
export type { OverviewCounts } from "./overview-client-types";
import type { ClaudeCodePayload, ClaudeDesktopPayload, GrokPayload, OverviewRow, OverviewRows, OverviewSources, OverviewCounts } from "./overview-client-types";
import { codexRow, keysRow } from "./overview-primary-rows";
```

The explicit local imports are necessary: the re-exports bind nothing locally. `JOURNAL_KIND_KEY`, `isAppliedState`, `buildOverviewRows`, and `countOverviewRows` remain their existing exported declarations; no forwarding lines for these are needed. Do not re-export the formerly private adapters from the original path. This compatibility façade is required by the train; it is not permission to create convenience barrels or route new leaf dependencies upward through it.

## Module-level state and cycles

- `FILE_LABEL_KEY` at 142–155: one record, owned by the residual, used by `fileRow` and unknown-file assembly. Do not duplicate it in a leaf.
- `JOURNAL_KIND_KEY` at 165–176: one record, owned by the residual; `RollbackHistory` keeps the same identity and path. No new eager execution.
- No top-level `let`, Map, Set, WeakMap, lock, timer, or mutable cache. `statusByClient = new Map(...)` at 499 is invocation-local inside `buildOverviewRows`, stays there, and must not become a singleton. `Date.now()` at 444 remains evaluated on each `cursorRow` call.
- The type leaf must not import `overview-clients`: doing so would make `residual → primary → types → residual` a cycle. Both residual and primary import shared types directly from their owner. Existing contract dependencies are one-way (`integration-api.ts:1`, `native-api.ts:1`, `cursor-api.ts:5`, `IntegrationStateBadge.tsx:1–2`); none imports this model. Include type-only and re-export edges in the implementation cycle audit.
- Coupling remains functional (row adapters) and existing external DTO coupling; no new shared mutable or temporal coupling. No new validation, retries, or error swallowing.

## Tests

Discovery: `rg -l 'overview-clients' tests gui/tests` returns the following four files. Three import the module; one reads it as source. Also checked direct source consumers and their adjacent tests.

| Test file | Exact dependency at origin/dev | Disposition |
|---|---|---|
| `gui/tests/integrations-overview-rows.test.ts` | import block 2–6 | unchanged; maps/null phases/counts/order exercised through original exports |
| `gui/tests/overview-state-merge.test.ts` | import at 2 | unchanged; original `buildOverviewRows`/`OverviewSources` path |
| `gui/tests/cursor-integration-page.test.tsx` | import at 5 | unchanged; original model exports and Cursor recency semantics |
| `tests/clients/integrations-journal.test.ts` | `readFileSync(repoPath("gui/src/pages/integrations/overview-clients.ts"), "utf8")` at 386; match/assert at 387–390 | unchanged; map remains physically in original file |

Additional affected behavioral coverage: `gui/tests/integration-marks.test.ts` (imports marks owner at 4, not this module), and `gui/tests/integrations-surfaces.test.tsx` (dynamic page import at **545** in origin/dev, not working-tree line 509). Both unchanged. The upstream surfaces file is 69 lines ahead of docs HEAD; use the layer's origin/dev test version, not a copied docs-worktree file.

No retarget-to-leaf or add-leaf-to-scan-list is needed in L1: the only exact source reader still reaches its owning declaration. Never replace its enum-completeness assertion with a re-export-presence assertion.

Guards to drive red once during implementation C phase, then restore: remove the `overwrite` map member and run the journal copy test by name (must fail at the existing assertion); change the moved Codex adapter to key off `status` instead of `routingInjected` and run the matching existing row test (must fail). No mutation-test or test execution occurred during planning.

## Verification

Planning-only validation: a fresh read-only Node check confirmed the nine required headings in order, all 25 declarations, and the source-range arithmetic (555 → 378; leaves 128/72). These are document checks, not implementation/test results.

Execute in the dedicated L1 implementation worktree, not this docs checkout. Instantiate 002's gate:

```sh
bun run typecheck
bun test tests/clients/integrations-journal.test.ts
bun test gui/tests/integrations-overview-rows.test.ts gui/tests/overview-state-merge.test.ts gui/tests/cursor-integration-page.test.tsx gui/tests/integration-marks.test.ts gui/tests/integrations-surfaces.test.tsx
bun run privacy:scan
wc -l gui/src/pages/integrations/overview-client-types.ts gui/src/pages/integrations/overview-primary-rows.ts gui/src/pages/integrations/overview-clients.ts
rg -n 'from "[^\"]*/overview-clients"' src gui/src scripts tests gui/tests
git diff --numstat dev -- gui/src/pages/integrations tests/clients gui/tests
```

The importer command has **6** matching import-end lines before/after (three GUI source + three GUI tests). Keep file identity as well as count; no current import is migrated. The 002 command omits `gui/tests`, which would count only 3 here; record both baselines rather than silently excluding the GUI tests. Audit added leaf import/export edges against the acyclic map above; typecheck alone is not a cycle proof. A read-only relative-edge SCC scan including type imports must report no SCC containing a touched module. No `src/server`, `src/router`, or `src/lib` file is touched, so 002's conditional core-Lab test is not applicable; never edit its roots.

GUI-specific build gate: `(cd gui && bun run lint && bun run build)`; no copy changes, so no translation changes or i18n-key migration. Before review-ready, the full GUI test gate also runs remotely, not as a repository-wide local test.

Full suite **only on lidge**, using the 002 branch and checkout gate, with pipe failure preserved:

```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-integrations-overview-clients && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile >/dev/null && bun test tests 2>&1 | tail -15"'
```

Parent serializes access to that shared remote checkout and records the same exact SHA for both remote runs and CI; a plain successful `tail` is not proof that tests passed. No test runs, dependency installs, or remote checkout changes are authorized by this delegated planning task.

## Accept criteria

1. Pinned source rechecked; all 25 inventory declarations have exactly one owner, preserving function bodies, comments, field order, and signatures.
2. Exactly two new source leaves, each ≤400 lines; residual ≤400 (expected 378). No unrelated source changes; measured source added+deleted total ≤500.
3. All 11 type and 4 value exports remain importable from `overview-clients`; the six existing importer files retain their paths. Formerly private functions are not added to that compatibility API.
4. `JOURNAL_KIND_KEY` remains at the original path, its source oracle unchanged and demonstrated red/green; moved Codex adapter test also demonstrated red/green.
5. No cycles through runtime, type-only, or re-export edges; no new state/cache owner; file-client ordering and credential/client separation unchanged.
6. Focused tests, root typecheck, GUI lint/build, privacy scan, remote full suites, and exact-head CI all pass with SHA-linked evidence before implementation completion/review readiness.
7. PR targets `dev`, contains the complete two-layer map and repository template, and is not merged. Planning completion itself claims only this document, not code delivery.

## PR

Title: `refactor(gui-integrations): separate overview contracts and primary row adapters (split S18 L1/2)`

Branch: `codex/split-pages-integrations-overview-clients`

Base: `dev`

Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S18 L1/3 | #TBD-L1 | `codex/split-pages-integrations-overview-clients` | `dev` | contracts and primary adapters; this layer |
| S18 L2/3 | #TBD-L2 | `codex/split-pages-integrations-IntegrationsOverview-a` | `codex/split-pages-integrations-overview-clients` | existing card/key views (620) |
| S18 L3/3 | #TBD-L3 | `codex/split-pages-integrations-IntegrationsOverview-b` | `codex/split-pages-integrations-IntegrationsOverview-a` | passthrough section extraction (625) |

Use `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification, Checklist; include unchanged-UI screenshot evidence because the title contains `gui`. Review only this layer's diff. Cascade L2 if L1 changes, with refreshed exact-head checks. Merge remains parent/user-authorized, bottom-up; this task creates no PR.

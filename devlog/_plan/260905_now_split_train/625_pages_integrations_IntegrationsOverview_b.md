# S18 L3/3 — Overview return-tree leaf (#b)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`, under `003_parent_decisions.md` **GUI-SEAM-01**; C3, docs-only delegated planning. The JSX return tree, embedded callbacks, and two private copy records move verbatim. Props carry the same values/functions without changing the rendered DOM.
- Goal: finish `IntegrationsOverview.tsx` from the **619-line #a residual to 398 lines**, adding one 283-line sibling component. Across S18: five new source files total, zero final residuals over 400.
- Non-goals: extracting hooks or named action closures, moving state/cache ownership, changing deletion/refusal behavior, introducing context/memoization, changing DOM/CSS/i18n, modifying L1/L2 source, implementing the plan, test execution, or Git/orchestration commands.
- Verifier: `002_layer_map.md` **Per-layer gate**, amended by 003 **PURE-MOVE-SIZE-01**, **GUI-SEAM-01**, and **TYPE-CYCLE-01**, instantiated below. Non-move wiring/test diff must be ≤150 lines; moved code is checked as a verbatim relocation.
- Stop: one leaf and residual each ≤400, all old exports/importers preserved, unchanged render/action behavior verified, and exact-head gate evidence recorded by the executor. This planning task stops after document consistency checks only.
- Escalation: any moved expression/body change, new hook/state owner, non-move diff >150, actual residual >400, or new dependency cycle returns to the parent. No #c is planned or needed by this partition.

Read first: `003_parent_decisions.md`, then current 002 S18 rows, 620, and the actual source. Docs HEAD is `4cc219549`; source `origin/dev` remains `1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source citation below is `gui/src/pages/integrations/IntegrationsOverview.tsx` at **origin/dev**, unless another path is given. The original source is 757 lines, and the hypothetical 619-line #a residual has not been implemented in this docs checkout. Do not read the stale working-tree page or invent exact post-#a physical positions: ranges use the stable original-source coordinates, with #a's transformations applied in memory.

Structural decision: the page mixes a state/resource/action controller (171–518) and a complete return tree (519–728). Existing dependents are `gui/src/pages/Integrations.tsx:10` and the dynamic import in `gui/tests/integrations-surfaces.test.tsx:545`. Existing downstream owners are `data-surface`, i18n/UI/routing, model L1, the #a card/key leaves, and integration dialogs/API clients. Intended direction: parent route → original page/controller → `IntegrationsOverviewContent.tsx` → existing view/dialog/API/type owners. No upward dependency from the new leaf. Blast radius: the same GUI feature; no route, package, or management API contract changes.

Rejected alternatives: deleting/configuring away UI loses behavior; moving the whole original component preserves its oversized function; a new resource/action hook moves lifecycle and cache ownership unnecessarily. Moving JSX alone removes 210 lines but leaves 409 before wiring, so the leaf also takes its two private dialog-copy constants and now-unused imports. The single return-tree leaf is explicitly authorized by GUI-SEAM-01, unlike a controller rewrite. The wide props surface is a literal capture of the existing render scope, not a new store abstraction; types narrow the resource views and every passed binding is actually used. The cost is 29 passthrough bindings, accepted here to keep the lifetime-sensitive controller intact. Source resource types already exist at `gui/src/data-surface.ts:24–39`; translation function type at `gui/src/i18n/shared.ts:59`.

Search evidence: `rg -n 'OverviewContent|IntegrationsOverviewContent' gui/src gui/tests tests` found no existing owner; sibling conventions are `ConsequenceDialog.tsx`, `RestoreDialog.tsx`, `RollbackHistory.tsx`, and the two #a component leaves. Reuse those components and existing API/types; no convenience barrel or new common/helper module.

## Symbol inventory

Exact ranges: `git show origin/dev:gui/src/pages/integrations/IntegrationsOverview.tsx | nl -ba` and `sg run --lang tsx --kind function_declaration --json=compact --stdin`, with `rg` for top-level constants. `rg -l -w '<symbol>' src gui/src scripts tests gui/tests` counts distinct files; resolve name hits against import paths and exclude the source itself. The **four declarations present in the #a residual** are below. No top-level declaration is omitted; the two previously extracted components are accounted for afterward.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| GROK_DISABLE_COPY | const record | 43–49 | no | 0 external | `gui/src/pages/integrations/IntegrationsOverviewContent.tsx` (private) |
| DESKTOP_DISABLE_COPY | const record | 51–58 | no | 0 external | `gui/src/pages/integrations/IntegrationsOverviewContent.tsx` (private) |
| isApplied | function | 60–62 | no | 0 importers; 4 unrelated backend name-hit files | residual `IntegrationsOverview.tsx` |
| IntegrationsOverview | component function | 171–729 | yes, default | 2 importers; 5 external name-hit files | residual; only return tree 519–728 moves |

#a provenance, not additional #b moves: `OverviewCard` (77–169) already belongs to `OverviewCard.tsx`; `ApiKeysRow` (743–757) already belongs to `ApiKeysRow.tsx`. Their sole direct importer after #a is the residual page; this layer relocates those two import edges to the new content leaf. No export or component body is edited in either #a leaf. Thus all six original declarations remain uniquely owned across the final tree.

New wiring-only declarations: private `IntegrationsOverviewContentProps` interface (no origin/dev range) and exported `IntegrationsOverviewContent` component shell around the existing return tree (provenance 519–728). The shell is used by the original page only and is not re-exported from it. Neither new declaration substitutes for a named action helper.

Nested boundary audit: all declarations at 178–518 stay in `IntegrationsOverview`, including all nine fetch callbacks/resources, derived rows/counts, `refresh` (348–357), `disableAll` (364–421), `lastChange` (423), `cardPending` (430), `refreshNativeDetails` (432–436), `setCardResult` (438–445), `toggleCard` (447–479), `requestToggle` (481–492), and `overwriteCard` (501–517). Inline JSX callbacks at 552, 607–611, 640, 657, 671–695, 701–705, and 720–724 move inside the intact return tree; they are not new controller abstractions.

## Leaf partition

**One new source file:** `gui/src/pages/integrations/IntegrationsOverviewContent.tsx`, expected **283 lines**, hard maximum 400.

- Move source **43–59** (17 lines, both private copy constants and their separators) without adding exports or changing values.
- Move source **519–728** (210 lines, the complete `return (...)` including `<section className="integrations-overview">`, all comments, and all four conditional dialogs) verbatim into the component shell below. Keep its original indentation; it already matches a top-level component's return block.
- Do not insert a wrapper DOM node, change keys, conditionally mount the content component, wrap it in `memo`, or call it as a plain function. The original page always returns the same component type, so local dialog lifetimes and DOM ordering remain stable across updates.
- Imports: exactly the following 13 lines, using L1's direct type owner and #a's view owners. `DataSurfaceResource`, `TFn`, and the model types are type-only imports.

```ts
import type { DataSurfaceResource } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { navigateHash } from "../../hash-routing";
import type { TFn } from "../../i18n/shared";
import { Notice } from "../../ui";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import RestoreDialog from "./RestoreDialog";
import { RollbackHistory } from "./RollbackHistory";
import { describeRefusal } from "./refusal-copy";
import { deleteJournalEntry, isMissingJournalEntry, type IntegrationJournalRow, type IntegrationStatus } from "./integration-api";
import type { ApiKeysOverviewRow, OverviewCounts, OverviewRow } from "./overview-client-types";
import { ApiKeysRow } from "./ApiKeysRow";
import { OverviewCard } from "./OverviewCard";
```

Add the following **31-line private props interface**. These are typed passthrough bindings, not copies of resource state or new domain DTOs. Passing the resource object itself preserves method receiver semantics in `historyResource.refresh()`; the narrowed type prevents the view from relying on unused resource fields. Setters only need the existing direct-value call form here, while their real React dispatch functions remain in the parent.

```ts
interface IntegrationsOverviewContentProps {
  t: TFn;
  counts: OverviewCounts;
  lastChange: string | undefined;
  disableAll: () => Promise<void>;
  bulkPending: boolean;
  appliedClients: IntegrationStatus[];
  keysRow: ApiKeysOverviewRow;
  statesResource: { state: Pick<DataSurfaceResource<IntegrationStatus[]>["state"], "kind"> };
  bulkResult: { tone: "ok" | "err"; text: string } | null;
  rows: OverviewRow[];
  cardPending: OverviewRow["id"] | null;
  cardResults: Partial<Record<OverviewRow["id"], { tone: "ok" | "err"; text: string }>>;
  requestToggle: (row: OverviewRow, next: boolean) => void;
  setPendingOverwrite: (row: OverviewRow | null) => void;
  clientsSettled: boolean;
  installedFileClients: IntegrationStatus[];
  historyResource: { state: Pick<DataSurfaceResource<IntegrationJournalRow[]>["state"], "kind" | "showSkeleton">; refresh: DataSurfaceResource<IntegrationJournalRow[]>["refresh"] };
  history: IntegrationJournalRow[];
  setRestoring: (row: IntegrationJournalRow | null) => void;
  setDeleting: (row: IntegrationJournalRow | null) => void;
  restoring: IntegrationJournalRow | null;
  apiBase: string;
  refresh: () => void;
  deleting: IntegrationJournalRow | null;
  pendingToggle: OverviewRow | null;
  setPendingToggle: (row: OverviewRow | null) => void;
  toggleCard: (row: OverviewRow, next: boolean) => Promise<void>;
  pendingOverwrite: OverviewRow | null;
  overwriteCard: (row: OverviewRow) => Promise<void>;
}
```

Component shell opening (8 lines); then one blank line, the verbatim 210-line return block, and one closing `}`. No new hook, computed value, handler body, error boundary, or branching is added:

```ts
export function IntegrationsOverviewContent({
  t, counts, lastChange, disableAll, bulkPending, appliedClients,
  keysRow, statesResource, bulkResult, rows, cardPending, cardResults,
  requestToggle, setPendingOverwrite, clientsSettled, installedFileClients,
  historyResource, history, setRestoring, setDeleting, restoring,
  apiBase, refresh, deleting, pendingToggle, setPendingToggle,
  toggleCard, pendingOverwrite, overwriteCard,
}: IntegrationsOverviewContentProps) {
```

Line accounting for the leaf: `13 imports + 1 blank + 17 copied constants/separators + 31 props + 1 blank + 8 signature + 1 blank + 210 copied return + 1 closing brace = 283`. The existing comments are retained, not shortened to manufacture headroom. Non-move shell/wiring is 56 new leaf lines.

**Residual original path:** expected **398 lines**. From #a's 619 remove 43–59 (17 original-source lines), replace 519–728 (210) with the exact 15-line return shown below, remove ten obsolete import lines, and add one content import. The ten removed imports are original-source lines **3, 4, 6, 10, 11, 12, 31, 32** plus #a's two new imports of `OverviewCard` and `ApiKeysRow`. Other imports remain, including `describeRefusal`, all data hooks/loaders/types, `toggleIntegration`, and `toggleNativeIntegration`. `IntegrationJournalRow` remains needed for state and resources.

Arithmetic: **`619 - 17 - 210 - 10 + 1 + 15 = 398`**. This leaves the page's function at `559 - 210 + 15 = 364` lines: existing function-length debt is not a claim of being ≤50, but the file-size goal is satisfied without a controller rewrite. The 003 RESIDUAL-FN-01 exception need not be used because the file fits. Formatting must preserve the stated bounded passthrough layout; if the actual file exceeds 400, stop and report rather than deleting comments or silently compressing executable code.

Stack totals: L1 leaves 128/72, model residual 378; #a leaves 115/32, page intermediate 619; #b leaf 283, page final 398. Thus **five leaves** and both final original files ≤400. #a took zero-external-consumer existing views first; #b now takes the remaining page render scope. No symbol is copied into both parts.

## Re-export block

No compatibility re-export lines: the sole current public export remains `export default function IntegrationsOverview` in the original path. Neither copy constant was public, and the new props interface stays private. No additional view export is exposed through the page; there is no `export *` or compatibility wrapper.

Exact local import addition to the residual (a re-export would bind nothing locally):

```ts
import { IntegrationsOverviewContent } from "./IntegrationsOverviewContent";
```

Exact **15-line** replacement of the old return block; every binding is passed unchanged, no spread of an opaque controller object or callback adaptation:

```tsx
  return (
    <IntegrationsOverviewContent
      t={t} counts={counts} lastChange={lastChange}
      disableAll={disableAll} bulkPending={bulkPending} appliedClients={appliedClients}
      keysRow={keysRow} statesResource={statesResource} bulkResult={bulkResult}
      rows={rows} cardPending={cardPending} cardResults={cardResults}
      requestToggle={requestToggle} setPendingOverwrite={setPendingOverwrite}
      clientsSettled={clientsSettled} installedFileClients={installedFileClients}
      historyResource={historyResource} history={history}
      setRestoring={setRestoring} setDeleting={setDeleting} restoring={restoring}
      apiBase={apiBase} refresh={refresh} deleting={deleting}
      pendingToggle={pendingToggle} setPendingToggle={setPendingToggle}
      toggleCard={toggleCard} pendingOverwrite={pendingOverwrite} overwriteCard={overwriteCard}
    />
  );
```

## Module-level state and cycles

- `GROK_DISABLE_COPY` (43–49) and `DESKTOP_DISABLE_COPY` (51–58) have exactly one new owner, the content leaf. They remain module-level private records; no mutation, cloning, lazy initialization, or per-render recreation. Both are used only by the moved conditional native dialog at 700.
- No top-level `let`, Map, Set, WeakMap, lock, timer, or cache exists in the original page or planned leaf. The controller's React state at 179–187 and 430, focus ref at 188, and restoration effect 190–196 stay at their original hook positions. The leaf has zero hooks.
- Resource definitions 198–297, `enabled: active`, session keys, lack of polling, and no `staleAfterMs` remain physically in the original page. `refresh` membership/order 348–357 and `refreshNativeDetails` 432–436 are unchanged; no opportunistic addition of Cursor refresh.
- Bulk disable 364–421 stays file-only, sequential, confirmation-gated and server-reconciled. `requestToggle` retains its original DOM-focus capture. Pending/result state remains parent-owned and callbacks are passed by reference, not wrapped or memoized.
- The entire existing delete `onConfirm` body (672–695) moves inside the copied JSX, retaining `isMissingJournalEntry` at 679, clear-and-refresh/return 680–682, localized rethrow 691, and success clear/refresh 693–694. Moving it does not authorize any API/deletion-policy change. The stale journal regression remains essential.
- Dependency map: page → content → #a views/dialogs/API clients/L1 type leaf. Content never imports the page, and neither the type leaf nor existing dialog/API owners import content. `OverviewCard → integration-marks → overview-clients` remains the existing one-way path. Type-only edges count; under TYPE-CYCLE-01 unchanged pre-existing type-only cycles are not new defects, but no new type/runtime cycle is allowed.
- Coupling is functional callback/data flow. Narrow resource projections explicitly retain the existing external data contract; no singleton/common mutable state or new validation boundary. Named per-page closures do not move into the leaf.

## Tests

Exact discovery command: `rg -l 'IntegrationsOverview' tests gui/tests`. Result is the following three files, deduplicated. Only one is a module importer. All lines are pinned origin/dev, including upstream's 69-line addition to the surfaces test versus docs HEAD.

| Test file | Import/source-read location | Disposition |
|---|---|---|
| `gui/tests/integrations-surfaces.test.tsx` | dynamic page import 545 | unchanged; keep import through original default export, render exercises the content transitively |
| `gui/tests/integrations-cache-freshness.test.ts` | literal path 13, `readFileSync(new URL(\`../${path}\`, import.meta.url), "utf8")` at 19; assertions 20–21 | unchanged; original page still owns all nine resources/session keys |
| `gui/tests/integrations-routing.test.ts` | `Bun.file(new URL("../src/pages/Integrations.tsx", import.meta.url)).text()` at 125; child assertions 129–135 | unchanged; text reader of parent route, not the split file |

No `retarget-to-leaf` needed: the cache policy does not move. No `add-leaf-to-scan-list`: the content component has no cache or resource hook, so adding it to `MIRROR_SURFACES` would incorrectly demand a cache key in presentation. Do not weaken either cache assertion or substitute an import-presence assertion. `page-loading-contract.test.tsx`'s explicit list 34–46 omits this page. `tests/clients/integrations-journal.test.ts:386` reads the separate `overview-clients.ts` journal map and remains unchanged; that source is not touched in #b.

Affected downstream tests kept unchanged: `gui/tests/integrations-overview-rows.test.ts`, `gui/tests/overview-state-merge.test.ts`, `gui/tests/cursor-integration-page.test.tsx`, and `gui/tests/integration-marks.test.ts`. No direct test imports of the newly extracted component are added just to expose its implementation.

Drive guards red once in implementation C phase, then restore exactly: (1) insert `staleAfterMs` on an original-page resource; cache freshness assertion must fail; (2) disable the moved missing-journal-entry reconciliation conditional, then run surfaces case **"the overview reconciles a journal row another tab already deleted"** (558–589), which must fail; (3) drop the `keysRow` passthrough temporarily, then run the surfaces credential-state case **"a source that cannot be read is unknown, never 'not applied'"** (943, `data-key-state` assertion 962), which must fail. These are bounded test-sensitivity checks, not proposed production changes. Existing bulk outcome cases and dialog focus cases run as part of the focused file. No tests were executed while drafting.

## Verification

Planning-only evidence: a fresh read-only Node reducer loaded the pinned source and applied #a/#b's line selections in memory: origin **757**, #a **619**, #b **398**, content leaf **283**. It checked the exact code-fence lengths (imports 13, props 31, signature 8, local import 1, return call 15), all **29** props against destructuring and unchanged-name call arguments, and all nine required headings plus three-layer branch references in both 620/625. `git diff --no-index --check /dev/null <doc>` found no whitespace errors in either document. No code, test, build, or Git-state mutation was performed.

Future executor only, in the #b worktree based on #a. The 002 gate plus 003 GUI/move requirements:

```sh
bun run typecheck
bun test gui/tests/integrations-surfaces.test.tsx gui/tests/integrations-cache-freshness.test.ts gui/tests/integrations-routing.test.ts
bun test gui/tests/integrations-overview-rows.test.ts gui/tests/overview-state-merge.test.ts gui/tests/cursor-integration-page.test.tsx gui/tests/integration-marks.test.ts
bun run privacy:scan
bun run lint:gui
bun run build:gui
wc -l gui/src/pages/integrations/IntegrationsOverviewContent.tsx gui/src/pages/integrations/IntegrationsOverview.tsx
rg -n 'from "[^\"]*/IntegrationsOverview"|import\("[^\"]*/IntegrationsOverview"\)' src gui/src scripts tests gui/tests
git diff -M --stat codex/split-pages-integrations-IntegrationsOverview-a
git diff --color-moved=dimmed-zebra codex/split-pages-integrations-IntegrationsOverview-a -- gui/src/pages/integrations
```

Counts: existing page importer identities stay **2** (one production static + one GUI-test dynamic); 002's static-only scan excluding `gui/tests` remains **1**. The #a view imports change owner from page to content exactly as listed above; counts each remain one and no external consumer is migrated. Add a read-only relative-edge SCC delta scan over the touched graph: no new runtime/type cycle. No server/router/lib changes, so 002's conditional core-Lab gate is not applicable and protected roots remain untouched.

PURE-MOVE-SIZE-01 receipt: record the **227 verbatim moved lines** (17 constants/separators + 210 return), compare the copied strings/AST against the #a/origin source, and confirm unique declaration ownership for all six original symbols plus the two new wiring declarations. Expected non-move budget is about **82 added/deleted lines** (`56 leaf wiring + 15 replacement + 1 import + 10 removed imports`), ceiling **150** including any verification-test additions. Count non-move edits separately from raw moved-line noise, not by hiding changes with whitespace-ignore. Any changed moved expression/body falls back to the literal 500-line rule and triggers escalation here. This planned raw diff is approximately 536 lines, which is why the parent amendment matters.

GUI-SEAM-01 additionally requires before/after screenshots of the same controlled fixture/page state attached to the PR. Compare the full content tree (summary, credential row, catalog, rollback and open consequence dialog) and exercise keyboard focus after confirm/cancel. Use isolated mocked/test data for mutation dialogs, not live user integrations. The only added React component boundary must introduce no DOM wrapper and no new state lifetime. Build/lint and rendered proof are required, not inferred from a move diff.

Full suites **only on lidge**, never repository-wide locally, at exact #b SHA:

```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-integrations-IntegrationsOverview-b && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile >/dev/null && bun test tests 2>&1 | tail -15"'
```

Parent serializes this shared remote checkout, proves both runs used the same #b SHA, and records exact-head CI. `pipefail` prevents a successful tail from concealing test failure. These commands are planned, not run by this docs-only delegation. Planning checks validate required headings, passthrough-name coverage, source-line arithmetic, and copied-slice provenance without running source code or tests.

## Accept criteria

1. #b starts at the documented 619-line #a residual on branch `codex/split-pages-integrations-IntegrationsOverview-a`; source provenance remains pinned origin/dev 757 lines, including the upstream delete reconciliation.
2. Exactly one new source leaf, expected 283 lines; original residual expected **398**, both ≤400. S18 totals are five new leaves and zero final oversized originals; no #c or undisclosed state/controller split.
3. All four #a-residual top-level declarations have one owner; #a's two view declarations remain untouched. All 29 captured JSX bindings are typed, passed under their original names, and used without adaptation. The only original export remains default `IntegrationsOverview` and both existing importers are unchanged.
4. Both copied ranges are verbatim and the JSX tree's DOM structure/order/keys are unchanged; hook order, data-resource policy, focus ownership, named actions, bulk sequencing, and callback outcomes are unchanged. The content component has no hooks, memoization, wrapper DOM, or conditional mounting.
5. Non-move diff ≤150 with move-aware review and exact unique-owner/copy evidence; no new runtime or type-only cycle. No new module-level cache/lock/timer or duplicated copy records.
6. Source-reading tests remain directed at their real owners without weakened assertions; the cache, credential, and stale-delete guards each have a recorded red/green sensitivity check during implementation.
7. Focused tests, typecheck, privacy scan, GUI lint/build, before/after rendered evidence, remote full suites, and exact-head CI pass before delivery. Planning arithmetic is not implementation or test-pass evidence.
8. PR targets #a, contains the complete three-layer map/template and screenshots, and is not merged without separate authorization. Only 625 and 620 are written by this planning follow-up; 610 metadata synchronization remains parent-owned/outside this write scope.

## PR

Title: `refactor(gui-integrations): separate overview rendering from its controller (split S18 L3/3)`

Branch: `codex/split-pages-integrations-IntegrationsOverview-b`

Base: `codex/split-pages-integrations-IntegrationsOverview-a`

Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S18 L1/3 | #TBD-L1 | `codex/split-pages-integrations-overview-clients` | `dev` | contracts and primary adapters |
| S18 L2/3 | #TBD-L2 | `codex/split-pages-integrations-IntegrationsOverview-a` | `codex/split-pages-integrations-overview-clients` | existing card/key leaves; intermediate 619 |
| S18 L3/3 | #TBD-L3 | `codex/split-pages-integrations-IntegrationsOverview-b` | `codex/split-pages-integrations-IntegrationsOverview-a` | return tree and private copy records; final 398; this layer |

Depends on #TBD-L2. Review this layer's diff only. Use `.github/PULL_REQUEST_TEMPLATE.md` Summary/Verification/Checklist; include `git diff --color-moved=dimmed-zebra` guidance, `git diff -M --stat`, unique-owner/copied-range evidence, non-move line count, and before/after screenshots. Cascade L2/L3 after an L1 change, L3 after an L2 change, and refresh exact-head evidence. Merge bottom-up only when separately authorized; no PR/Git operation is performed by this planning task.

# S18 L2/3 — Existing overview presentation leaves (#a)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only delegated task.
- Goal: extract the existing `OverviewCard` and `ApiKeysRow` components without changing their bodies, props, UI, or the page's resource/action lifetimes. Keep the existing default page export.
- Non-goals: rewriting the page controller, introducing a context/store, changing cache/refresh policy, moving confirmation ownership, changing bulk sequencing or upstream delete handling, code/test execution, or editing the train map.
- Verifier: `002_layer_map.md` **Per-layer gate**, amended by `003_parent_decisions.md` PURE-MOVE-SIZE-01 and GUI-SEAM-01, instantiated below. This is an intermediate layer; 625 brings the residual under 400.
- Stop: views moved and checks green for this layer, with the 619-line intermediate residual recorded. S18 file-size completion belongs to L3/3, not this layer.
- Escalation: any change beyond the approved views and the 625 continuation goes to the parent. Parent has approved S18 L3/3 (#b); no further map changes are authorized by this delegated task.

Basis: docs HEAD `4cc219549`; source `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`. Read source with `git show origin/dev:gui/src/pages/integrations/IntegrationsOverview.tsx`, never the working copy. The actual source is **757** physical lines, not 748: `001_stale_check.md` records the +9 upstream change but repeats the old count. The function now spans **171–729 (559 lines)**. `isMissingJournalEntry` is imported at 32 and handles a missing journal row at 679–683. All line references below are origin/dev. Lane basis: `015_lane_gui.md:208–219`; it explicitly proposes views first, then action slices while preserving confirmation ownership, not that moving two views alone finishes this file.

Structural decision: consumers are `gui/src/pages/Integrations.tsx:10` and the dynamic import in `gui/tests/integrations-surfaces.test.tsx:545`; the source reader is `gui/tests/integrations-cache-freshness.test.ts:19`. Existing page dependencies are React, data-surface, shared UI/i18n/routing/marks, model L1, integration/native/cursor API clients, and dialog/history components (source 1–41). Intended map: parent page → original default export → two presentation leaves; both leaves use existing contracts/UI owners, never the page. The original page keeps all data resources, mutations, and dialogs. Blast radius: local integrations feature; no route or package boundary changes.

Rejected alternatives: do nothing/delete/configure cannot remove executable size debt without losing UI. Moving the whole 559-line component merely relocates the violation. Extracting resources/actions would alter lexical boundaries unnecessarily. The chosen first move is the two existing zero-external-consumer components; the higher-fan-in default page and its cache oracle stay stable. The original raw-diff size objection is superseded by 003 PURE-MOVE-SIZE-01 (≤150 non-move lines); GUI-SEAM-01 permits 625 to move the remaining JSX tree with props passed through, without extracting the controller.

## Symbol inventory

`git show origin/dev:<path> | sg run --lang tsx --kind function_declaration --json=compact --stdin` gives the function spans; `rg`/numbered source gives the two const records. These are all **6 top-level owned declarations** (imports are wiring, listed under partition). `rg -l -w '<symbol>' src gui/src scripts tests gui/tests` counts external files, then import resolution excludes homonyms/comments.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| GROK_DISABLE_COPY | const record | 43–49 | no | 0 | residual `IntegrationsOverview.tsx` |
| DESKTOP_DISABLE_COPY | const record | 51–58 | no | 0 | residual `IntegrationsOverview.tsx` |
| isApplied | function | 60–62 | no | 0 importers; 4 unrelated backend name-hit files | residual `IntegrationsOverview.tsx` |
| OverviewCard | component function | 77–169 | no | 0 | `gui/src/pages/integrations/OverviewCard.tsx` |
| IntegrationsOverview | component function | 171–729 | yes, default | 2 importers; 5 external name-hit files | residual `IntegrationsOverview.tsx` |
| ApiKeysRow | component function | 743–757 | no | 0 | `gui/src/pages/integrations/ApiKeysRow.tsx` |

The five `IntegrationsOverview` name-hit files are the two importers, cache source reader, `integrations-routing.test.ts` (reads its parent), and a comment in `FileIntegrationPage.tsx`; those last three are not module importers. `isApplied` backend names are unrelated declarations, not consumers of this private function.

## Leaf partition

Existing PascalCase component siblings (`ConsequenceDialog.tsx`, `RestoreDialog.tsx`, `IntegrationStateBadge.tsx`, `RollbackHistory.tsx`) establish the naming pattern; exact-name search found no existing `OverviewCard`/`ApiKeysRow` owner outside this file.

1. **`gui/src/pages/integrations/OverviewCard.tsx` — expected 115 lines.** Move source 64–169 inclusive (106 lines with its accessibility comment), prefix the existing function with `export`, and add these eight imports plus a blank line. Keep its existing inline props, refusal construction, switch guard, markup, and handler wiring exactly.

   ```ts
   import { useT } from "../../i18n/shared";
   import { Notice, Switch } from "../../ui";
   import ClientMark from "../../components/ClientMark";
   import { markFor } from "../../components/integration-marks";
   import IntegrationStateBadge from "./IntegrationStateBadge";
   import { describeRefusal } from "./refusal-copy";
   import { NativeApiError } from "./native-api";
   import type { OverviewRow } from "./overview-client-types";
   ```

2. **`gui/src/pages/integrations/ApiKeysRow.tsx` — expected 32 lines.** Move source 730–757 inclusive (28 lines including the credential semantics comment), prefix the existing function with `export`, and add three imports plus a blank line:

   ```ts
   import { navigateHash } from "../../hash-routing";
   import { useT } from "../../i18n/shared";
   import type { ApiKeysOverviewRow } from "./overview-client-types";
   ```

3. **Residual `gui/src/pages/integrations/IntegrationsOverview.tsx` — expected 619 lines.** Remove 64–170 (component/comment plus its following blank, 107 lines) and 730–757 (28). Remove the three full imports at 7–9 and the `ApiKeysOverviewRow`/`NativeApiError` import lines at 19/38. Change `{ Notice, Switch }` to `{ Notice }` at 6. Add the two explicit view imports below. All other original imports remain, including `navigateHash`, `describeRefusal`, `isMissingJournalEntry`, all resource types/loaders, and the React hooks.

Arithmetic: `757 - 107 - 28 - 5 + 2 = 619`; new leaves `115 + 32 = 147`, total `766` (= original +9 net wiring lines). Raw added+deleted source estimate is about 292 lines. Per 003 PURE-MOVE-SIZE-01, enforce ≤150 non-move wiring/test lines and record moved lines separately. The two new leaves are under 400; **one intermediate residual remains over 400**, permitted by INTERMEDIATE-RESIDUAL-01 because L3/3 takes it to 398.

**Approved #b:** `625_pages_integrations_IntegrationsOverview_b.md`, S18 L3/3, branch `codex/split-pages-integrations-IntegrationsOverview-b`, base `codex/split-pages-integrations-IntegrationsOverview-a`. It takes the 619-line residual to **398** by moving the complete existing return tree (origin/dev 519–728) and its two private dialog-copy records (43–59) into `IntegrationsOverviewContent.tsx`. All hooks and named action closures remain in the page; this uses GUI-SEAM-01, not a new resource/controller hook. This layer still plans only its two leaves; 625 adds one more.

## Re-export block

**No compatibility re-export statements are required.** The only current export is `default function IntegrationsOverview`, and it stays as an actual declaration in the original file. Moving the private views does not justify widening its public API. Specifically, do not add `export { OverviewCard }` or `export { ApiKeysRow }` to the original module and do not replace the page export with a wrapper.

Exact explicit local imports added to the residual:

```ts
import { OverviewCard } from "./OverviewCard";
import { ApiKeysRow } from "./ApiKeysRow";
```

The leaves export their respective existing component names so the page can bind them. Re-export syntax alone would not bind a local name. L1 keeps the page's existing `overview-clients` model imports working; the new leaves import the L1 type owner directly. No `export *` or convenience barrel.

## Module-level state and cycles

- `GROK_DISABLE_COPY` (43–49) and `DESKTOP_DISABLE_COPY` (51–58) are the only top-level const records. Both remain owned by the original page; never copy them to a view leaf.
- No top-level `let`, Map, Set, WeakMap, cache, lock, or timer. Page-local hooks at 179–188 and 430 remain per mounted page. `restoreFocusRef` at 188 and its effect at 190–196 stay with the pending native toggle; no hoisting to a module singleton or new mount boundary.
- Resources and their `enabled: active`/session keys remain at 198–297; refresh membership/order at 348–357 and 432–436 stays unchanged. In particular, do not add Cursor to the current refresh closure as opportunistic cleanup.
- Sequential file-only bulk disable at 364–421 remains in the page, including confirmation, serial awaits, server re-read, and localized partial results. `requestToggle` 481–492 and the delete/native/overwrite dialogs 661–726 remain together. Upstream `isMissingJournalEntry` handling at 679–683 stays untouched.
- New edges: page → views → L1 contract leaf/existing UI owners. No view imports the page. `OverviewCard → integration-marks → overview-clients → overview-primary-rows → overview-client-types` is one-way; neither L1 leaf imports a view or the page. Type-only edges count in the cycle audit. No new state owner or internal validation.
- Coupling: functional props and existing external API refusal types. Moving presentation alone does not introduce control flow back into the page beyond the already-existing callback props. The forbidden alternative is reading controller state by importing the page.

## Tests

Discovery: `rg -l 'IntegrationsOverview' tests gui/tests` returns exactly these three files; only the first imports this module. All test line references below are from origin/dev, not stale docs HEAD.

| Test file | Exact dependency | Disposition |
|---|---|---|
| `gui/tests/integrations-surfaces.test.tsx` | dynamic `import("../src/pages/integrations/IntegrationsOverview")` at 545 | unchanged; covers page rendering, credential/client distinction, callbacks, bulk result confirmation and upstream journal-delete reconciliation at 558–588 |
| `gui/tests/integrations-cache-freshness.test.ts` | path array entry at 13; `readFileSync(new URL(\`../${path}\`, import.meta.url), "utf8")` at 19; assertions 20–21 | unchanged; all resource/cache declarations remain in residual |
| `gui/tests/integrations-routing.test.ts` | `Bun.file(..."../src/pages/Integrations.tsx"...).text()` at 125, child-name/prop assertions 129–135 | unchanged; reads parent, not the split source |

There are no test imports of the private components. `page-loading-contract.test.tsx` was checked: its explicit pages at 34–46 do not include this overview, so no entry should be invented. Run the existing L1 model tests and `integration-marks.test.ts` as focused dependency coverage; their import paths stay unchanged.

No retarget-to-leaf or add-leaf-to-scan-list in this bounded L2: neither new view owns a resource. Adding them to the cache oracle's `MIRROR_SURFACES` would incorrectly require a `sessionCacheKey` in stateless presentation. The approved 625 also leaves all resources in the original page, so its cache oracle remains unchanged too.

Guards to drive red once during implementation C phase, then restore: insert a `staleAfterMs` option into one page resource and run `integrations-cache-freshness.test.ts` (fails its negative assertion); corrupt the moved key row's `data-key-state` and run the corresponding `integrations-surfaces.test.tsx` credential-state case (must fail); disable the retained missing-journal reconciliation branch and run `--test-name-pattern 'the overview reconciles a journal row another tab already deleted'` (must fail). The last is verification-only and must be fully restored; it is not permission to redesign deletion behavior.

## Verification

Planning-only validation: a fresh read-only Node check confirmed the nine required headings in order, all six declarations, and source-range arithmetic (757 → 619; leaves 115/32). The pinned-source test read also confirmed the existing key-state assertion at `gui/tests/integrations-surfaces.test.tsx:962` and the delete reconciliation case at 558–589. These are document checks, not test-pass claims.

In the future dedicated L2 worktree based on L1, instantiate 002's gate:

```sh
bun run typecheck
bun test gui/tests/integrations-surfaces.test.tsx gui/tests/integrations-cache-freshness.test.ts gui/tests/integrations-routing.test.ts
bun test gui/tests/integrations-overview-rows.test.ts gui/tests/overview-state-merge.test.ts gui/tests/cursor-integration-page.test.tsx gui/tests/integration-marks.test.ts
bun run privacy:scan
wc -l gui/src/pages/integrations/OverviewCard.tsx gui/src/pages/integrations/ApiKeysRow.tsx gui/src/pages/integrations/IntegrationsOverview.tsx
rg -n 'from "[^\"]*/IntegrationsOverview"|import\("[^\"]*/IntegrationsOverview"\)' src gui/src scripts tests gui/tests
git diff --numstat codex/split-pages-integrations-overview-clients -- gui/src/pages/integrations gui/tests
```

Importer baseline: **2 files** (one static production import, one dynamic GUI-test import). 002's static-only command over `src gui/src scripts tests` returns **1**, so preserve that baseline too and explicitly supplement it with the dynamic/GUI-test search. Both identities must remain unchanged. No core/server/lib changes; the conditional `tests/lab/core-lab-boundary.test.ts` gate is not applicable and its protected roots must not be edited.

Audit relative runtime/type/re-export edges with a read-only SCC scan: no new cycle (003 TYPE-CYCLE-01 allows unchanged pre-existing type-only cycles). Typecheck does not establish absence of cycles. Per GUI-SEAM-01, run `bun run lint:gui` and `bun run build:gui`, and attach before/after screenshots. Record `git diff -M --stat` and use `git diff --color-moved=dimmed-zebra` with a symbol-owner check for PURE-MOVE-SIZE-01. Full GUI tests run on the remote host below. Preserve copy, CSS, and accessibility.

Full suite **only on lidge**; same 002 remote gate, preserving pipeline failure and recording the exact head:

```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-pages-integrations-IntegrationsOverview-a && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex/gui && bun install --frozen-lockfile >/dev/null && bun test tests 2>&1 | tail -15"'
```

Parent coordinates exclusive use of the remote checkout, verifies both runs used this layer SHA, and records exact-head CI. No commands in this section were executed in the delegated docs task. Size gate outcome must be recorded as **two passing leaves, one explicitly deferred residual (619 → required #b)**, not all files passing.

## Accept criteria

1. Source basis is the 757-line origin/dev version, with current delete-journal reconciliation and the matching upstream regression test retained.
2. Exactly two new source files, expected 115 and 32 lines and each ≤400; original default export and its two importer identities remain unchanged. No new exports added to the original boundary.
3. Existing component bodies/comments/props move intact; only imports and leaf export modifiers change. No controller, hook order, effect dependencies, callback sequencing, dialog ownership, CSS, or locale changes. Measured non-move diff ≤150 lines under PURE-MOVE-SIZE-01, with move and unique-owner evidence.
4. Residual count is recorded (expected **619**, not ≤400). The approved 625 / S18 L3/3 brings it to **398**; do not claim terminal size completion before that layer. No extra branch or map expansion beyond the approved three layers.
5. Cache oracle remains on the original resource owner, all named tests stay intact, required guards have red/green evidence, and the delete 404 test is from origin/dev.
6. No new runtime/type-only/re-export cycle (003 TYPE-CYCLE-01); no new module-level state owner; all existing state remains per page instance.
7. Root typecheck, focused GUI tests, privacy scan, GUI lint/build, remote full suites, and exact-head CI pass before this bounded move is review-ready. Record the residual exception separately from check outcomes.
8. PR base is L1, map includes all three allocated layers, template is complete, before/after screenshot evidence is attached, and no merge occurs under this task's authority.

## PR

Title: `refactor(gui-integrations): extract overview card and credential views (split S18 L2/3)`

Branch: `codex/split-pages-integrations-IntegrationsOverview-a`

Base: `codex/split-pages-integrations-overview-clients`

Closes: none.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| S18 L1/3 | #TBD-L1 | `codex/split-pages-integrations-overview-clients` | `dev` | contracts and primary adapters |
| S18 L2/3 | #TBD-L2 | `codex/split-pages-integrations-IntegrationsOverview-a` | `codex/split-pages-integrations-overview-clients` | existing card/key views; this layer |
| S18 L3/3 | #TBD-L3 | `codex/split-pages-integrations-IntegrationsOverview-b` | `codex/split-pages-integrations-IntegrationsOverview-a` | return-tree leaf; residual ≤400 |

Depends on #TBD-L1. Review this layer's diff only. Fill Summary/Verification/Checklist in `.github/PULL_REQUEST_TEMPLATE.md`; disclose the intermediate 619-line residual and approved 625 continuation, link `git diff --color-moved=dimmed-zebra` review guidance, and attach before/after screenshots. Cascade through L2 and L3 after an L1 update and refresh exact-head evidence. Merge is bottom-up and separately authorized; this task opens no PR.

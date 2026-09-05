# 040 — Provider model deletion, visibility and static default-only sync

Class C3 with C4 review for model identity and management mutations. Active P baseline: `67fdf24eb6e661f4d9e84aaa86a4eb39c6f3ba58` (2026-09-06 KST), including the verified ordering/Lab landing `76356176c` and D Cursor description preservation. Source #3659 remains OPEN at `ff4e5cd5352b9c1bd05e3de0091f3483ca130be5`; all five original commits are by gqchen <276851182@qq.com>. This active contract supersedes conflicting proposals in the historical source appendix. Current independent preparation found no need for a new endpoint, store, dependency or visual redesign.

The previous ordering cycle is complete. The new implementation stays in bound f80e on `codex/lane-b-04-management`. User authorization includes no-verify pushes, admin merges and immediate source closure after verified dev inclusion. No local tests, suites, typechecks or builds; execution is isolated remote or hosted CI. No release/deployment, global account or service changes.

## Accepted behavior

Delete removes one stored custom definition by stable ID. It sends exactly one DELETE and never an automatic visibility PUT. A native or discovered counterpart can return and keep the inventory count unchanged. Hide sends exactly one visibility PUT using a confirmed server row. Add saves a definition and preserves independent visibility/selection policy. No permanent browser tombstone survives a refresh. The existing Models page is the recovery surface for hidden rows, including when the provider tab is empty.

The frontend consumes existing /api/models DTOs once per parent refresh alongside the full /api/selected-models response. It does not add disabled to selected-models or introduce another identity classifier. Existing full available, selected and liveModelCounts retain their meanings. The only production backend change is the source static-default seed plus any narrowly demonstrated regression repair approved in this cycle.

## Planned interfaces and owners

- Reuse type-only ModelRow from gui/src/pages/models-shared.ts. Add a strict row-array boundary parser/grouping beside current provider-workspace helpers, with dedicated model-inventory module if size warrants. Validate nonblank provider/id/namespaced, boolean disabled and optional native/custom/pending flags, plus nonblank customId for custom rows. Invalid destructive identity fails the whole refresh. Preserve raw strings; use Map/null-prototype records and namespaced uniqueness.
- ProviderWorkspaceShell owns one paired read per refresh epoch. Adopt both successful responses together; do not claim cross-endpoint transactional consistency. Maintain a current refresh key/revision and the revision of the adopted snapshot. Invalidate readiness immediately on retry, external refresh or mutation reconciliation; deferred effect loading alone is insufficient. Keep cancellation/generation rejection and use existing bounded fetch conventions.
- Pass modelRows: ModelRow[] | null and refresh revision/readiness through DetailSlotData, Providers, ProviderDetails and keyed ProviderModels. null is unavailable; [] is a successful empty projection. Add onOpenModels from Providers using existing navigateHash("models").
- ProviderModels refreshes its full custom-definition GET whenever the parent revision changes, and records the successful ownership revision. Controls require a current row snapshot and current custom ownership, no load error, no pending mutation and matching customId/provider/modelId for Delete. Refetch both resources after success, failure or an ambiguous response. Successful ownership GET must not erase unresolved mutation feedback.
- On confirmed snapshots, render non-disabled DTOs; key chips, copy and busy state by namespaced. Identical raw labels with distinct selectors are disambiguated using namespaced. An unavailable snapshot may retain old/read-only fallback data; successful empty must not insert configured/default/native rows. Pending/unknown identity has no mutation action.
- Rail count uses the full unique non-disabled DTO inventory before query or render cap. Detail search/truncation count is separately understood. An allowlist badge does not change inventory count, and native selection does not borrow a routed same-raw-id badge. Full available/provenance stay separate.
- Delete custom records only; other confirmed rows Hide with row.provider, row.id and row.native === true. Block both handlers and all buttons on the shared busy/readiness condition. Do not infer native from provider name or substitute Hide when custom ownership is unavailable.
- Preserve existing Add duplicate/encoded-collision checks using full raw configured/discovered/custom inputs. Do not newly reject a valid native override solely because a native DTO has the same raw id. Existing hidden custom definitions remain duplicates and use Models to restore visibility. Validate POST 201 identity and stable ID before adoption. Saved, saved-but-hidden, refresh-pending and unconfirmed-save outcomes are distinct; no automatic POST retry or implicit unhide.

## Source carry disposition

Preserve gqchen <276851182@qq.com> in the carry commit and Co-authored-by trailer. Carry the static default-only patch, source UI controls/icons/locales and docs with adaptation. Omit the source selected-models disabled-map API hunk and its redundant parser/prop chain. Replace source Delete-then-Hide and raw-ID tombstones with the contract above. Preserve the complete historical source appendix as evidence, explicitly superseded where it conflicts with this amendment. Refresh the screenshot from the actual amended UI; the source image is historical.

## Verification required before completion

- GUI exact request counts for cancel/Delete/Hide; custom-only delete/re-add/remount; native and discovered replacement after Delete; raw/encoded and account-qualified collisions; invalid DTO/native/custom metadata; pending rows; failed custom GET; three-resource refresh readiness with reversed responses, external custom-ID replacement and provider switch; malformed/ambiguous POST reconciliation without repeat writes; independent hidden/allowlist state preserved; empty and 300+ inventories; recovery link visible in empty state; counts match the canonical pre-search inventory.
- Actual management DELETE→GET round trips, preserving native/routed/account hides and existing validation. No new management write semantics or relaxation.
- Static omitted/empty models + default + retain union/dedupe, explicit list precedence, no default/no lists, forward early return, successful-empty live discovery; no extra network activity in static cases.
- Independent C4 source/security review and final UI/code review. Actual isolated compiled GUI with synthetic API state, screenshots and remount/error evidence. Root/GUI focused checks, typecheck, docs build and exact-head hosted functional CI. No local suite/test/typecheck/build.
- Update English and translations for static seeding and the amended Delete/Hide meaning, and the existing source of truth. Do not document an unimplemented disabled-map API.

Obtain an independent full plan audit before B. One B implements this management slice only; Fable remains a separate later cycle. Preserve the original patch below as historical source evidence, not current implementation instructions.

## Concrete component contract and file inventory

The parent passes `modelRows: ModelRow[] | null`, `modelRevision: string` and `modelRowsReady: boolean` through its existing detail chain. `modelRevision` represents the current API base, external refresh token and local retry epoch. The adopted parent snapshot carries its own revision; readiness requires equality. The child custom-record load is keyed by the same revision and separately records successful ownership observation. A revision mismatch disables actions immediately, even before deferred loading effects run. Mutation start has an immediate single-flight guard; parent and ownership reconciliation must finish before that guard reopens. Failed/old reads cannot certify a new revision.

The existing fetch owner gains cancellation and generation checks without a new cache/store. Reuse `readJsonOrThrow` and the shared `putModelVisibility`. Mutation responses must be read and their confirmed-save versus catalog-refresh status distinguished. Never treat abort/transport loss as a rollback. The UI keeps previous display under loading/error treatment where appropriate and has a retry path. When the removed focused chip disappears, return focus to a stable search/recovery control without stealing focus from a user who moved elsewhere.

| Action | Exact paths and ownership |
| --- | --- |
| MODIFY | `src/codex/catalog/provider-fetch.ts`: static default seed and adjacent comment, preserving forward/static/live boundaries. |
| ADD | `gui/src/provider-workspace/model-inventory.ts`: strict existing-DTO parser, provider grouping/count projection, and narrowly needed custom-response identity parsing; no network or second native classifier. Search existing owners before each helper. |
| ADD | `gui/src/components/provider-workspace/ProviderModelChip.tsx`: focused existing chip markup with accessible copy/Delete/Hide controls; authority remains in ProviderModels. This keeps its stateful parent below the 400-line limit. |
| MODIFY | `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`: paired parent reads, revision-bound snapshot/readiness, canonical inventory counts and props. |
| MODIFY | `gui/src/pages/Providers.tsx`, `gui/src/components/provider-workspace/ProviderDetails.tsx`: pass rows/revision/readiness and existing Models navigation. Preserve keyed provider mounts. |
| MODIFY | `gui/src/components/provider-workspace/ProviderModels.tsx`: stable custom ownership, revision readiness, disjoint one-request mutations, confirmed identity, feedback/reconciliation, canonical row view and Add policy. No session-long removed-ID set. |
| MODIFY | `gui/src/icons.tsx`: source EyeOff utility icon, preserving existing icon grammar. |
| MODIFY | `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,zh,zh-TW}.ts`: every displayed new label/outcome/confirmation across all nine files; retain D Logs keys. Use existing keys where their meaning fits. |
| MODIFY | `gui/tests/provider-model-custom-add.test.tsx`: preserve Add coverage, update realistic DTO/revision fixtures and the native override/ambiguous-save cases. |
| ADD | `gui/tests/provider-model-management.test.tsx`: stateful server-backed Delete/Hide/reload/recovery and asynchronous readiness/focus cases. |
| ADD | `gui/tests/provider-model-inventory.test.ts`: malformed DTO/identity, namespace collisions, unique inventory counts and successful-empty semantics. GUI tests are outside the root layout registry. |
| MODIFY | Existing workspace/Providers tests that render the touched chain: update their paired endpoint fixtures and verify counts/provenance. Only actual affected callers, found by search, are changed. |
| MODIFY | `tests/codex-integration/codex-catalog.test.ts`: static-default/retain/explicit/forward/live-empty behavior and no-network oracles. |
| MODIFY | `tests/codex-integration/model-visibility-management-api.test.ts`: actual custom DELETE then GET restoration/identity, independent hide state and unchanged target validation. |
| OMIT source hunk | `src/server/management/model-routes.ts`, `gui/src/provider-workspace/usage.ts`, `tests/server/model-discovery-management-api.test.ts`: do not add the proposed disabled-map API/parser/assertion; existing response and helper meanings stay intact. |
| MODIFY | The source's provider-reference and codex-integration guide changes in English plus fr/ja/ko/ru/tr/zh-cn/zh-tw: static seeding and existing visibility policy. |
| MODIFY | `docs-site/src/content/docs/{,fr/,ja/,ko/,ru/,tr/,zh-cn/,zh-tw/}guides/web-dashboard.md`: Delete definition versus Hide, count semantics and existing Models recovery; retain D Logs descriptions. |
| MODIFY | `structure/03_catalog-and-subagents.md`: ordered static seed union and provider-workspace inventory/identity/Delete/Hide contract. No direct-routing permission change. |
| REPLACE artifact | `docs-site/public/pr-screenshots/3659-provider-model-removal.png`: capture the actual amended UI in isolated compiled QA; the source image is historical. Add only necessary state/viewport evidence. |

Canonical count is unique non-disabled projected inventory before search and the 300-chip cap. SelectedModels remains a routed allowlist badge; native rows do not borrow a routed same-ID selection. A successful empty DTO never activates raw fallback. Native-only DTO raw IDs must not newly enter Add's duplicate set; preserve the pre-existing configured/discovered/custom and encoded-collision validation. Custom/native equal raw IDs remain distinct namespaced chips where both are projected.

## Design and verification contract

Keep the existing wrapping chip layout, typography, tokens and icons. Delete confirmation explicitly says it removes the custom definition and may reveal an underlying model. Hide confirmation explains catalog visibility and preserves direct routing policy. Keep an always-visible, keyboard-accessible Models recovery action, including empty/after-Hide/error states. No hidden panel, new deep-link protocol, additional permission flow or visual redesign.

Final GUI checks run on the remote exact branch: `cd gui && bun test --isolate tests`, `bun run lint`, `bun run lint:i18n`, `bun run build`. Root focused checks include catalog, model-discovery management, model-visibility API and the import-connected set; source-oracle/subprocess paths are explicitly covered. Root typecheck/privacy and docs build run remotely. Hosted exact-head Linux/macOS functional CI and actual target composition remain merge gates; final all-Windows dispatch remains in 060.

Browser QA uses the actual remotely compiled dashboard with an isolated synthetic management state. Capture desktop and narrow Korean layouts plus: custom-only deletion/re-add, custom/native and custom/live restoration, independent Hide and remount, existing Models recovery, error/ambiguous-save and pending-ownership states. Observe requests and resulting rows/counts; screenshots alone do not prove persistence. No real provider accounts, global proxy or deployment are touched.

Delegation after A: main owns source carry/static seed/branch/FSM/PR integration; frontend writer owns the component/helper chain; separate GUI test writer owns behavioral fixtures; catalog/API worker owns backend regression cases; docs worker owns translations and public guides; independent reviewer owns C4 identity/security and final source audit; remote QA owns exact-head execution and browser evidence. Workers inherit the model and may delegate bounded subwork; no worker mutates main FSM or pushes/merges.

## Reviewable PR layers within this work phase

Use two dependent PRs for the two capabilities in source #3659. This is one management work-phase/PABCD cycle, not the Fable cycle. Layer 1 (`codex/lane-b-04-static-default`) carries static default seeding, source catalog regressions and static-provider documentation. Layer 2 (`codex/lane-b-04-management`) builds on layer 1 and contains the canonical DTO workspace, Delete/Hide controls, UI/API regression coverage, translations and rendered evidence. Both preserve gqchen attribution. The UI layer remains one coherent interaction contract; its larger regression matrix is necessary to review the three asynchronous resources and identity boundaries together.

Main commits and publishes the static parent before switching the same bound checkout to its UI child, then delegates UI writers. No branch movement occurs under a running test/build. Verification for both prepared heads is collected in C; land the reviewed stack bottom-up (or a separately audited verified composition), retarget children before parent cleanup, and close original #3659 only after both capabilities are verified on dev. No source closure is claimed for the partial static landing.

## Structural decision and dependency map

The pressure is adding trusted row actions and refresh state to the existing 276-line ProviderModels while preserving a single server identity owner. Current edges are `ProviderWorkspaceShell -> usage/report`, `Providers -> ProviderDetails -> ProviderModels -> report/slug-codec`; `/api/models` identity comes from `src/server/management/model-rows.ts -> catalog/config`. The new parser is an HTTP read boundary, not a second identity policy.

Chosen edges: the parent and child import the colocated pure `provider-workspace/model-inventory.ts`; its ModelRow dependency is type-only from `pages/models-shared.ts`. ProviderModels imports the colocated ProviderModelChip; that leaf uses existing icons/i18n and receives callbacks, never fetches or chooses authority. No barrel/public export, runtime server-to-GUI import, shared mutable store or backend layering change is introduced. Blast radius is this provider-workspace feature and its existing prop/test callers.

The source disabled-map alternative is rejected because it duplicates native/custom identity policy and misses fallback/native state. Putting every new parser, state transition and chip into ProviderModels is rejected because it mixes response validation, authority and markup while approaching the 400-line boundary. The selected split leaves operation/state ownership visible in the existing parent/child. Existing component fetch conventions are retained rather than adding a query-library dependency or migrating unrelated server/cache ownership. Verify the paired read cost, no duplicate per-row request, exact prop callers, strict boundary parsing, focus and state generations in the planned remote tests/browser QA.

## Historical source snapshot and full source patch

Everything below is the original roadmap snapshot and public upstream diff. Its superseded two-write removal, disabled-map API, unconditional native inference and always-decrement count are not accepted implementation requirements. Active requirements are above.


Read on 2026-09-06 KST in `/Users/jun/.codex/worktrees/f80e/opencodex` at `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. Pinned source: [PR #3659](https://github.com/lidge-jun/opencodex/pull/3659), head `ff4e5cd5352b9c1bd05e3de0091f3483ca130be5`, source base `af50c6d3451078a7d298b044c08fd2684c9e8eeb`. Inputs are captured `.tmp/lane-b/3659.json` and `.patch`; no claim of a fresh remote status check is made. `git show -s` independently confirmed the head commit author below.

| Source commit | Actual commit author | Subject |
|---|---|---|
| `2a41fea0229f7d2bcc9e90d6b614ad94bbd6802f` | gqchen &lt;276851182@qq.com&gt; | feat(gui): remove models from provider catalog |
| `34ace947a31aa154d77cd6d0eac67669304dd72b` | gqchen &lt;276851182@qq.com&gt; | fix(codex): sync static default-only providers |
| `13e6ea29e6904afff68c6eccd177c9e929f494d7` | gqchen &lt;276851182@qq.com&gt; | docs(pr): add provider model removal screenshot |
| `e005d028d3b4697676f17817b10de4c8ea4e2987` | gqchen &lt;276851182@qq.com&gt; | fix(gui): address provider model removal review |
| `ff4e5cd5352b9c1bd05e3de0091f3483ca130be5` | gqchen &lt;276851182@qq.com&gt; | fix(gui): distinguish hidden provider models |

Preserve original commit authors on a clean replay; for reimplementation or squash put `Co-authored-by: gqchen <276851182@qq.com>` in each carried logical commit and the final squash body. PR login alone is not an author trailer.

Safe carry strategy: main revalidates pinned source/head and incoming parent; replay the complete reviewed source series in order or reproduce its exact delta with attribution. Preserve source follow-up commits, not only the initial feature commit. Publish a child against its still-open parent; after parent squash, rebuild the child on the new dev ancestry and re-run exact-head CI. Retarget surviving children before parent branch deletion. Push uses the user's authorized `--no-verify` to avoid local hooks; this does not substitute for CI. Once dev contains the complete carried behavior, close the superseded source PR with a carry reference; do not close it for a partial/default-only slice. No linked issue is invented.

## Exact change ledger

Every source changed file is accounted for below. “Same base” means a read-only `git hash-object` of current file bytes matches the patch's old blob prefix; it does not prove future cherry-pick cleanliness. “Drift” requires contextual reconciliation. Source binary is explicitly unreviewed. All textual hunks were inspected as source behavior; appendix preserves exact before/after, including complete NEW test content. No source production file was edited.

| Operation | Exact path | Baseline / disposition |
|---|---|---|
| NEW | `docs-site/public/pr-screenshots/3659-provider-model-removal.png` | Binary skipped: payload absent from text patch; visual proof required |
| MODIFY | `docs-site/src/content/docs/fr/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/fr/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/ja/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/ja/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/ko/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/ko/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/reference/configuration/providers.md` | Drift; preserve current unrelated edits |
| MODIFY | `docs-site/src/content/docs/ru/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/ru/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/tr/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/tr/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/zh-cn/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/zh-cn/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/zh-tw/guides/codex-integration.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/zh-tw/reference/configuration/providers.md` | Same base; reviewed textual delta |
| MODIFY | `gui/src/components/provider-workspace/ProviderDetails.tsx` | Same base; reviewed textual delta |
| MODIFY | `gui/src/components/provider-workspace/ProviderModels.tsx` | Same base; reviewed textual delta |
| MODIFY | `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` | Same base; reviewed textual delta |
| MODIFY | `gui/src/i18n/de.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/en.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/fr.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/ja.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/ko.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/ru.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/tr.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/zh-TW.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/i18n/zh.ts` | Drift; preserve current unrelated edits |
| MODIFY | `gui/src/icons.tsx` | Same base; reviewed textual delta |
| MODIFY | `gui/src/pages/Providers.tsx` | Same base; reviewed textual delta |
| MODIFY | `gui/src/provider-workspace/usage.ts` | Same base; reviewed textual delta |
| MODIFY | `gui/tests/provider-model-custom-add.test.tsx` | Same base; reviewed textual delta |
| MODIFY | `src/codex/catalog/provider-fetch.ts` | Same base; reviewed textual delta |
| MODIFY | `src/server/management/model-routes.ts` | Same base; reviewed textual delta |
| MODIFY | `tests/codex-integration/codex-catalog.test.ts` | Same base; reviewed textual delta |
| MODIFY | `tests/server/model-discovery-management-api.test.ts` | Same base; reviewed textual delta |
| MODIFY (planned SoT addition) | `structure/03_catalog-and-subagents.md` | Public contract prose delta specified above; not in source PR |
| MODIFY (planned API doc addition) | `docs-site/src/content/docs/reference/management-api.md` | Add disabled response field alongside preceding phases |

## Execution boundary and verifier

This is a docs-only roadmap deliverable, not an implementation or merge receipt. The main agent owns 000, the goal/FSM, branch operations, integration, and final acceptance. No local tests, suites, typecheck, builds, hooks, provider requests, commits, pushes, or GitHub writes were run by this researcher. The next implementation cycle must re-read this plan against its actual parent tip.

Loop archetype: spec-satisfaction repair. Trigger: carry the pinned public source PR into lane B. Stop: required behaviors, exact-head CI, reviewer disposition and parent integration all have durable evidence. Expected result: DONE only after verified dev ancestry; NOOP only if equivalent behavior is already landed; unresolved correctness/CI evidence is pending, not DONE. Scope and unattended resource bounds are inherited from main's 000; this document does not arm or amend the goal. Upward escalation: return concrete caller/test evidence to main if the carry contract cannot be satisfied; additional worker dispatch requires main's planned scope.

CI-only verifier, inspected at the baseline below:

- `.github/workflows/ci.yml:5` uses unfiltered `pull_request`, so child PR bases are supported. `changes` at lines 181-218 admits `src/**`, `tests/**`, `scripts/**`, `gui/**`; source changes also admit packaging.
- Linux `test 1/4..4/4`, lines 255-316, invokes `scripts/ci/run-bun-test-batches.sh`. That runner enumerates `tests` (line 197), admits `.test.ts` files (lines 46-68), and excludes only storage/API-usage families into dedicated jobs; the catalog/management files in this plan are included. Each actual batch runs `bun test --isolate --timeout 60000` under a process timeout (lines 121-126). Read logs to prove the named files ran; aggregate green alone is insufficient.
- `gates`, lines 390-449, runs root TypeScript (`bun x tsc --noEmit`), GUI tests (`cd gui && bun test --isolate tests`), privacy scan and skill-surface check. GUI changes additionally run `bun run lint` and `bun run build`; `gui/package.json:8` expands build to `tsc -b && vite build`. GUI lint is `oxlint .`, including changed locale/UI inputs; the separately named `lint:i18n` script is not a dedicated CI step.
- macOS runs two full-suite shards (lines 451-547). Windows full-suite six shards (lines 658-769) run only on `workflow_dispatch` with lane `all`; do not infer Windows full-suite coverage from packaging smoke or PR aggregate success. Main must obtain an exact-ref dispatch if Windows full-suite evidence is required, then verify the run head.
- `.github/workflows/deploy-docs.yml:3-10,24-33` builds Astro only on main push or manual dispatch and then deploys. Normal PR CI has no Astro docs build. Do not trigger this deploy workflow merely to obtain a pre-merge check. Main must arrange an approved non-deploy CI verifier on the exact candidate commit or explicitly retain this as a readiness gap; this research does not add workflow code or authorize deployment.
- Save head SHA, parent/base SHA, run URL, executed job conclusions, named test logs, approvals and unresolved-thread disposition. Source-author reported passes are historical claims, not carried-head validation. Never attest local checks that were intentionally prohibited.


## Pinned public source delta

Reconcile only the touched hunks at the implementation parent. The conceptual deltas above and acceptance amendments take precedence over copying this source verbatim. This appendix records public source-PR behavior only.

````diff
diff --git a/docs-site/public/pr-screenshots/3659-provider-model-removal.png b/docs-site/public/pr-screenshots/3659-provider-model-removal.png
new file mode 100644
index 0000000000..dafe828720
Binary files /dev/null and b/docs-site/public/pr-screenshots/3659-provider-model-removal.png differ
diff --git a/docs-site/src/content/docs/fr/guides/codex-integration.md b/docs-site/src/content/docs/fr/guides/codex-integration.md
index 091a63a787..fe0a5d687a 100644
--- a/docs-site/src/content/docs/fr/guides/codex-integration.md
+++ b/docs-site/src/content/docs/fr/guides/codex-integration.md
@@ -311,8 +311,9 @@ S'il manque un modèle dans Codex, ou si l'ordre ou la visibilité du catalogue
    d'autorisation n'atteint jamais le catalogue.
 2. **`disabledModels`** au niveau supérieur — masque les modèles dans le catalogue comme dans `/v1/models`, et
    fait passer les identifiants GPT natifs non qualifiés à `visibility: "hide"`.
-3. **`liveModels: false` avec `models` vide** — lorsque la découverte en direct est désactivée et que `models`
-   est vide ou absent, opencodex n'expose aucun modèle routé pour ce fournisseur.
+3. **`liveModels: false`** — lorsque la découverte en direct est désactivée, les modèles routés proviennent de
+   `models` et `retainModels`. Si `models` est vide ou absent, un `defaultModel` configuré est également inclus ;
+   si aucun de ces champs ne fournit d'identifiant, opencodex n'expose aucun modèle routé.
 4. **Cursor `GetUsableModels`** — l'adaptateur Cursor découvre les modèles par son appel RPC protobuf
    `GetUsableModels`, et non par `/models` ; une modification côté Cursor peut donc changer les identifiants visibles
    indépendamment des autres fournisseurs.
diff --git a/docs-site/src/content/docs/fr/reference/configuration/providers.md b/docs-site/src/content/docs/fr/reference/configuration/providers.md
index bec7932c09..dcfcc0af63 100644
--- a/docs-site/src/content/docs/fr/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/fr/reference/configuration/providers.md
@@ -93,7 +93,7 @@ sauvegarde dont le contenu diffère, puis réécrit en identifiants sans préfix
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Style de l'en-tête de clé Anthropic. La valeur par défaut est l'en-tête natif `x-api-key` ; ce champ n'est valable que pour les fournisseurs `anthropic` authentifiés par clé. |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | Pool multi-clés. `apiKey` reflète l'entrée active ; chaque élément a `id`, `key`, `label` facultatif et `addedAt` numérique facultatif. |
 | `defaultModel?` | `string` | Modèle utilisé lorsque ce fournisseur est sélectionné sans modèle explicite. |
-| `models?` | `string[]` | Liste initiale ou de repli des modèles. Avec `liveModels: false`, ce sont les seuls modèles découverts. |
+| `models?` | `string[]` | Liste initiale ou de repli. Avec `liveModels: false`, les modèles routés proviennent de `models` et `retainModels` ; `defaultModel` est aussi inclus lorsque `models` est vide. |
 | `liveModels?` | `boolean` | Récupère le catalogue actif au démarrage et lors de la synchronisation (true par défaut). Les fournisseurs personnalisés utilisent `${baseUrl}/models` ; les fournisseurs intégrés peuvent employer une URL de registre et un filtre. |
 | `selectedModels?` | `string[]` | Liste autorisée du catalogue après la découverte. Non vide expose uniquement ces identifiants ; vide ou omis expose tous les modèles découverts. |
 | `contextWindow?` | `number` | Repli contextuel à l’échelle du fournisseur lorsque les métadonnées en amont sont absentes ; sinon, un plafond qui conserve des métadonnées en direct plus petites. Le tableau de bord Modèles expose cela séparément de `providerContextCaps`. |
@@ -435,8 +435,8 @@ modèle. Le même mappage s'applique à un sélecteur natif `vercel/<model-id>`
 
 ## Listes autorisées de modèles statiques
 
-Réglez `liveModels: false` pour exposer uniquement `models`. Si `models` est vide ou omis, le fournisseur n'expose
-aucun modèle routé. La découverte dynamique rejette plus de 4 Mio ou 2 000 lignes de modèle brutes avant leur mise en cache ;
+Réglez `liveModels: false` pour exposer uniquement les modèles configurés dans `models` et `retainModels`. Si `models` est vide ou omis,
+un `defaultModel` configuré est également inclus. Si aucun de ces champs ne fournit d'identifiant, aucun modèle routé n'est exposé. La découverte dynamique rejette plus de 4 Mio ou 2 000 lignes de modèle brutes avant leur mise en cache ;
 les préréglages intégrés peuvent appliquer des limites inférieures et filtrer les lignes admissibles à la conversation. Les résultats trop volumineux ou mal formés
 utilisent le catalogue obsolète ou configuré comme solution de repli. Un résultat valide ne contenant aucun modèle admissible fait autorité et n'est pas
 silencieusement remplacé ou tronqué.
diff --git a/docs-site/src/content/docs/guides/codex-integration.md b/docs-site/src/content/docs/guides/codex-integration.md
index b2ae7fcb91..62f5b0a662 100644
--- a/docs-site/src/content/docs/guides/codex-integration.md
+++ b/docs-site/src/content/docs/guides/codex-integration.md
@@ -454,8 +454,9 @@ If a model is missing from Codex, or the catalog order/visibility looks wrong, c
    catalog.
 2. **`disabledModels`** (top level) — hides models from both the catalog and `/v1/models`, and flips
    bare native GPT slugs to `visibility: "hide"`.
-3. **`liveModels: false` with empty `models`** — when live discovery is off and `models` is empty or
-   omitted, opencodex exposes no routed models for that provider.
+3. **`liveModels: false`** — with live discovery off, routed models come from `models` and
+   `retainModels`. When `models` is empty or omitted, a configured `defaultModel` is included too;
+   if none of those fields supplies an id, opencodex exposes no routed models.
 4. **Cursor `GetUsableModels`** — the Cursor adapter discovers models through its protobuf
    `GetUsableModels` RPC, not `/models`, so a Cursor-side change can alter which ids are visible
    independently of other providers.
diff --git a/docs-site/src/content/docs/ja/guides/codex-integration.md b/docs-site/src/content/docs/ja/guides/codex-integration.md
index 06cd590084..d49fae078c 100644
--- a/docs-site/src/content/docs/ja/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ja/guides/codex-integration.md
@@ -197,8 +197,9 @@ ocx sync-cache
 空または省略すると、検出されたすべてのモデルが公開されます。ホワイトリストにない ID はカタログに到達しません。
 2. **`disabledModels`** (トップレベル) — カタログと `/v1/models` の両方からモデルを非表示にし、反転します
 裸のネイティブ GPT スラッグを `visibility: "hide"` にします。
-3. **`liveModels: false` と空の `models`** — ライブ検出がオフで、`models` が空の場合、または
-省略すると、opencodex はそのプロバイダーのルーティング モデルを公開しません。
+3. **`liveModels: false`** — ライブ検出がオフの場合、ルーティングモデルは `models` と
+`retainModels` から取得されます。`models` が空または省略されている場合は構成済みの `defaultModel` も含まれ、
+いずれのフィールドにも ID がない場合のみルーティングモデルを公開しません。
 4. **Cursor `GetUsableModels`** — Cursor アダプターはその protobuf を通じてモデルを検出します。
 `/models` ではなく `GetUsableModels` RPC であるため、カーソル側の変更により、他のプロバイダーとは独立して表示される ID が変更される可能性があります。
 5. **キャッシュと `ocx sync`** - ライブ カタログは約 5 分間キャッシュされます (`modelCacheTtlMs`、
diff --git a/docs-site/src/content/docs/ja/reference/configuration/providers.md b/docs-site/src/content/docs/ja/reference/configuration/providers.md
index bd33d34a3f..41e1de7aa3 100644
--- a/docs-site/src/content/docs/ja/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/ja/reference/configuration/providers.md
@@ -81,7 +81,7 @@ account を削除しても mapping は保持され、同じ id を再追加す
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic キーのヘッダー スタイル。デフォルトはネイティブ `x-api-key` です。キー認証 `anthropic` プロバイダーにのみ有効です。 |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` |マルチキープール。 `apiKey` はアクティブなエントリをミラーリングします。各項目には `id`、`key`、オプションの `label`、およびオプションの数値 `addedAt` があります。 |
 | `defaultModel?` | `string` |このプロバイダーが明示的なモデルなしで選択された場合に使用されるモデル。 |
-| `models?` | `string[]` |シード/フォールバック モデルのリスト。 `liveModels: false` では、発見されたモデルはこれらのみです。 |
+| `models?` | `string[]` |シード/フォールバック モデルのリスト。`liveModels: false` ではルーティングモデルは `models` と `retainModels` から取得され、`models` が空の場合は `defaultModel` も含まれます。 |
 | `liveModels?` | `boolean` |開始/同期時にライブ カタログをフェッチします (デフォルトは `true`)。カスタムプロバイダーは `${baseUrl}/models` を使用します。組み込みはレジストリ URL とフィルターを使用する場合があります。 |
 | `selectedModels?` | `string[]` |検出後のカタログ許可リスト。空でない場合は、それらの ID のみが公開されます。空または省略すると、検出されたすべてのモデルが公開されます。 |
 | `modelDisplayNames?` | `Record<string, string>` | このプロバイダーの正確なネイティブモデル ID をキーにした、永続的な表示専用ラベルです。大文字と小文字は区別されます。ラベルはプロバイダーカタログのメタデータより優先され、認証、アダプター、ルーティング、課金、上流リクエストには影響しません。マップは検出上限と同じ 2,000 件までです。 |
@@ -354,7 +354,7 @@ Vercel AI Gateway は、1 つのモデルを複数の基盤となる推論プロ
 
 ## 静的モデルのホワイトリスト
 
-`models` のみを公開するように `liveModels: false` を設定します。 `models` が空であるか省略されている場合、プロバイダーはルーティングされたモデルを公開しません。ライブ ディスカバリは、キャッシュする前に 4 MiB または 2,000 を超える生のモデル行を拒否します。組み込みのプリセットは下限を使用し、チャットに適した行にフィルターをかけることができます。サイズが大きすぎる、または形式が正しくない結果は、古い/構成されたフォールバックに続きます。ゼロに適格な有効な結果は引き続き権威を持ち、暗黙的に置き換えられたり切り捨てられたりすることはありません。
+構成済みモデルのみを公開するように `liveModels: false` を設定します。ルーティングモデルは `models` と `retainModels` から取得され、`models` が空または省略されている場合は構成済みの `defaultModel` も含まれます。いずれのフィールドにも ID がない場合のみ、ルーティングモデルを公開しません。ライブ ディスカバリは、キャッシュする前に 4 MiB または 2,000 を超える生のモデル行を拒否します。組み込みのプリセットは下限を使用し、チャットに適した行にフィルターをかけることができます。サイズが大きすぎる、または形式が正しくない結果は、古い/構成されたフォールバックに続きます。ゼロに適格な有効な結果は引き続き権威を持ち、暗黙的に置き換えられたり切り捨てられたりすることはありません。
 
 検出を実行する必要があるが、選択した ID のみが Codex および `/v1/models` に表示される必要がある場合は、`selectedModels` を使用します。ダッシュボードには、後で許可リストを変更できるように、検出された完全なリストが保持されます。
 
diff --git a/docs-site/src/content/docs/ko/guides/codex-integration.md b/docs-site/src/content/docs/ko/guides/codex-integration.md
index 3f777153ec..ece36df6af 100644
--- a/docs-site/src/content/docs/ko/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ko/guides/codex-integration.md
@@ -197,7 +197,7 @@ Codex에서 model이 빠졌거나 catalog 순서/가시성이 이상해 보이
 
 1. provider의 **`selectedModels`** - 비어 있지 않은 allowlist는 해당 id만 Codex에 노출합니다. 비어 있거나 생략하면 발견된 model이 모두 노출됩니다. allowlist에 없는 id는 catalog에 절대 들어가지 않습니다.
 2. **`disabledModels`**(top level) - catalog와 `/v1/models`에서 model을 숨기고, bare native GPT slug는 `visibility: "hide"`로 바꿉니다.
-3. **`liveModels: false`와 비어 있는 `models`** - live discovery가 꺼져 있고 `models`가 비어 있거나 생략되면, opencodex는 그 provider에 대해 routed model을 하나도 노출하지 않습니다.
+3. **`liveModels: false`** - live discovery가 꺼져 있으면 routed model은 `models`와 `retainModels`에서 가져옵니다. `models`가 비어 있거나 생략되면 구성된 `defaultModel`도 포함되며, 어느 필드에도 ID가 없을 때만 routed model을 노출하지 않습니다.
 4. **Cursor `GetUsableModels`** - Cursor adapter는 `/models`가 아니라 protobuf `GetUsableModels` RPC로 model을 찾습니다. 그래서 Cursor 쪽 변경이 다른 provider와 무관하게 어떤 id가 보이는지 바꿀 수 있습니다.
 5. **캐시와 `ocx sync`** - live catalog는 약 5분(`modelCacheTtlMs`, 기본값 `300000`) 동안 캐시됩니다. `ocx sync`를 실행하면 새로 가져와서 catalog를 즉시 다시 쓸 수 있습니다.
 6. **실행 중인 Codex `app-server`** - 오래 살아 있는 Codex `app-server`(Desktop / CLI background host)가 이전 목록을 메모리에 쥐고 있으면 디스크 catalog를 다시 쓰는 것만으로는 부족합니다. `ocx sync`와 `ocx sync-cache`는 그런 process를 감지하면 경고합니다. `ocx sync --restart-codex`로 다시 시작하거나(아니면 일치하는 `app-server` process를 직접 중지한 뒤), Codex가 다시 만들게 해서 새 목록이 보이게 하세요.
diff --git a/docs-site/src/content/docs/ko/reference/configuration/providers.md b/docs-site/src/content/docs/ko/reference/configuration/providers.md
index 3d65dbfb4d..49b911d2c8 100644
--- a/docs-site/src/content/docs/ko/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/ko/reference/configuration/providers.md
@@ -81,7 +81,7 @@ managed map을 활성화하면 privacy-safe selector를 만들고, 이후 계정
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic 키 헤더 형식입니다. 기본값은 네이티브 `x-api-key`이며, 키 인증 `anthropic` 공급자에만 유효합니다. |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | 다중 키 풀입니다. `apiKey`는 활성 항목을 그대로 반영하며, 각 항목에는 `id`, `key`, 선택적 `label`, 선택적 숫자 `addedAt`가 들어갑니다. |
 | `defaultModel?` | `string` | 이 공급자를 선택할 때 모델을 따로 지정하지 않으면 사용하는 모델입니다. |
-| `models?` | `string[]` | 시드/폴백 모델 목록입니다. `liveModels: false`이면 이 목록만 발견된 모델로 취급합니다. |
+| `models?` | `string[]` | 시드/폴백 모델 목록입니다. `liveModels: false`이면 라우팅 모델은 `models`와 `retainModels`에서 가져오며, `models`가 비어 있으면 `defaultModel`도 포함됩니다. |
 | `liveModels?` | `boolean` | 시작 또는 동기화 시 라이브 카탈로그를 가져옵니다. 기본값은 `true`입니다. 사용자 지정 공급자는 `${baseUrl}/models`를 사용하고, 내장은 레지스트리 URL을 사용한 뒤 필터링할 수 있습니다. |
 | `selectedModels?` | `string[]` | 발견 후 카탈로그 허용 목록입니다. 값이 비어 있지 않으면 그 id만 노출하고, 비어 있거나 생략하면 발견된 모델을 모두 노출합니다. |
 | `modelDisplayNames?` | `Record<string, string>` | 이 공급자의 정확한 네이티브 모델 id를 키로 쓰는 영구 표시 전용 이름입니다. 키는 대소문자를 구분합니다. 이름은 공급자 카탈로그 메타데이터보다 우선하며 인증, 어댑터, 라우팅, 청구 또는 업스트림 요청을 바꾸지 않습니다. 맵은 발견 한도와 같은 최대 2,000개 항목을 가질 수 있습니다. |
@@ -361,7 +361,7 @@ Vercel AI Gateway는 하나의 모델을 여러 기반 추론 공급자에 걸
 
 ## 정적 모델 허용 목록
 
-`liveModels: false`로 두면 `models`만 노출합니다. `models`가 비어 있거나 생략되면 공급자는 어떤 라우팅 모델도 노출하지 않습니다. 라이브 발견은 캐싱 전에 4 MiB 또는 원시 모델 행 2,000개를 넘으면 거부합니다. 내장 프리셋은 더 낮은 한도를 쓰고 chat 가능한 행만 필터링할 수 있습니다. 너무 크거나 형식이 잘못된 결과는 오래된/설정된 폴백을 따릅니다. 유효하지만 선택 가능한 항목이 0개인 결과는 그대로 권위가 있으며, 조용히 다른 값으로 바꾸거나 잘라내지 않습니다.
+`liveModels: false`로 두면 구성된 모델만 노출합니다. 라우팅 모델은 `models`와 `retainModels`에서 가져오며, `models`가 비어 있거나 생략되면 구성된 `defaultModel`도 포함됩니다. 어느 필드에도 ID가 없을 때만 라우팅 모델을 노출하지 않습니다. 라이브 발견은 캐싱 전에 4 MiB 또는 원시 모델 행 2,000개를 넘으면 거부합니다. 내장 프리셋은 더 낮은 한도를 쓰고 chat 가능한 행만 필터링할 수 있습니다. 너무 크거나 형식이 잘못된 결과는 오래된/설정된 폴백을 따릅니다. 유효하지만 선택 가능한 항목이 0개인 결과는 그대로 권위가 있으며, 조용히 다른 값으로 바꾸거나 잘라내지 않습니다.
 
 `selectedModels`는 발견은 계속하되, 선택된 id만 Codex와 `/v1/models`에 나타나게 하고 싶을 때 사용합니다. 대시보드는 나중에 허용 목록을 바꿀 수 있도록 발견된 전체 목록을 보관합니다.
 
diff --git a/docs-site/src/content/docs/reference/configuration/providers.md b/docs-site/src/content/docs/reference/configuration/providers.md
index ab8a154ecb..2a56f4ceb9 100644
--- a/docs-site/src/content/docs/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/reference/configuration/providers.md
@@ -136,7 +136,7 @@ predictions. Explicit provider/model price overrides still take precedence.
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key header style. Defaults to native `x-api-key`; valid only for key-auth `anthropic` providers. |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | Multi-key pool. `apiKey` mirrors the active entry; each item has `id`, `key`, optional `label`, and optional numeric `addedAt`. |
 | `defaultModel?` | `string` | Model used when this provider is selected without an explicit model. |
-| `models?` | `string[]` | Seed/fallback model list. With `liveModels: false`, these are the only discovered models. |
+| `models?` | `string[]` | Seed/fallback model list. With `liveModels: false`, routed models come from `models` and `retainModels`; `defaultModel` is also included when `models` is empty. |
 | `liveModels?` | `boolean` | Fetch the live catalog on start/sync (default `true`). Custom providers use `${baseUrl}/models`; built-ins may use a registry URL and filter. |
 | `selectedModels?` | `string[]` | Catalog allowlist after discovery. Non-empty exposes only those ids; empty or omitted exposes all discovered models. |
 | `retainModels?` | `string[]` | Ids kept in the catalog even when live discovery omits them. They need not be repeated in `models`. Empty or omitted keeps today's behavior. |
@@ -738,8 +738,8 @@ container usually has no unlocked keychain session, so requests would fail close
 `${ENV_VAR}` reference in the service environment there instead. Env references are left untouched
 by `store`.
 
-Set `liveModels: false` to expose only `models`. If `models` is empty or omitted, the provider exposes
-no routed models. Live discovery rejects more than 4 MiB or 2,000 raw model rows before caching;
+Set `liveModels: false` to expose only configured models from `models` and `retainModels`. If `models`
+is empty or omitted, a configured `defaultModel` is included too. If none of those fields supplies an id, the provider exposes no routed models. Live discovery rejects more than 4 MiB or 2,000 raw model rows before caching;
 built-in presets may use lower limits and filter to chat-eligible rows. Oversized or malformed results
 follow stale/configured fallback. A valid zero-eligible result remains authoritative and is not
 silently replaced or truncated.
diff --git a/docs-site/src/content/docs/ru/guides/codex-integration.md b/docs-site/src/content/docs/ru/guides/codex-integration.md
index e33bb6c835..ebdec89431 100644
--- a/docs-site/src/content/docs/ru/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ru/guides/codex-integration.md
@@ -304,8 +304,9 @@ Codex на встроенный провайдер `openai` и удалите л
    allowlist, никогда не попадёт в каталог.
 2. **`disabledModels`** (верхний уровень) — скрывает модели и из каталога, и из `/v1/models`, а у
    голых нативных GPT-slug устанавливает `visibility: "hide"`.
-3. **`liveModels: false` и пустой `models`** — если живое обнаружение выключено, а `models` пуст
-   или отсутствует, opencodex не показывает ни одной маршрутизируемой модели этого провайдера.
+3. **`liveModels: false`** — если живое обнаружение выключено, маршрутизируемые модели берутся из
+   `models` и `retainModels`. Если `models` пуст или отсутствует, также включается настроенный `defaultModel`;
+   если ни одно из этих полей не содержит идентификатор, opencodex не показывает маршрутизируемых моделей.
 4. **Cursor `GetUsableModels`** — адаптер Cursor получает модели через protobuf RPC
    `GetUsableModels`, а не через `/models`, поэтому изменение на стороне Cursor может менять
    видимые id независимо от остальных провайдеров.
diff --git a/docs-site/src/content/docs/ru/reference/configuration/providers.md b/docs-site/src/content/docs/ru/reference/configuration/providers.md
index a058fdb842..f31d0ffc13 100644
--- a/docs-site/src/content/docs/ru/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/ru/reference/configuration/providers.md
@@ -94,7 +94,7 @@ cross-route credential fallback не существует. Строки API GPT-
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Header-style для ключа Anthropic. По умолчанию нативный `x-api-key`; допустим только для key-auth-провайдеров `anthropic`. |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | Пул из нескольких ключей. `apiKey` зеркалит активную запись; каждый элемент содержит `id`, `key`, необязательный `label` и необязательное числовое `addedAt`. |
 | `defaultModel?` | `string` | Модель, используемая когда этот провайдер выбран без явной модели. |
-| `models?` | `string[]` | Seed/fallback-список моделей. При `liveModels: false` это и есть единственный список обнаруженных моделей. |
+| `models?` | `string[]` | Seed/fallback-список. При `liveModels: false` маршрутизируемые модели берутся из `models` и `retainModels`; если `models` пуст, также включается `defaultModel`. |
 | `liveModels?` | `boolean` | Получать live-каталог на start/sync (по умолчанию `true`). Custom-провайдеры используют `${baseUrl}/models`; built-in могут использовать registry URL и дополнительно фильтровать результат. |
 | `selectedModels?` | `string[]` | Allowlist каталога после discovery. Непустой список показывает только эти id; пустой или отсутствующий показывает всё, что было обнаружено. |
 | `modelDisplayNames?` | `Record<string, string>` | Постоянные display-only имена с точным нативным id модели этого провайдера в качестве ключа. Ключи чувствительны к регистру. Имена имеют приоритет над metadata каталога провайдера и не меняют аутентификацию, adapter, routing, billing или upstream-запросы. Карта содержит не более 2 000 записей, как и discovery. |
@@ -439,8 +439,8 @@ Chat-запросов не добавляют поле `provider`, а Vercel AI
 
 ## Статические allowlist'ы моделей
 
-Задайте `liveModels: false`, чтобы показывать только `models`. Если `models` пуст или отсутствует,
-провайдер не будет показывать ни одной маршрутизируемой модели. Live-discovery отвергает ответы
+Задайте `liveModels: false`, чтобы показывать только настроенные модели из `models` и `retainModels`. Если `models` пуст или отсутствует,
+также включается настроенный `defaultModel`. Если ни одно из этих полей не содержит идентификатор, провайдер не показывает маршрутизируемых моделей. Live-discovery отвергает ответы
 размером более 4 MiB или более 2000 сырых model-row до кэширования; built-in preset'ы могут
 использовать меньшие лимиты и фильтровать список до chat-совместимых строк. Oversized или
 malformed-результаты откатываются к stale/configured fallback. Валидный результат с нулём
diff --git a/docs-site/src/content/docs/tr/guides/codex-integration.md b/docs-site/src/content/docs/tr/guides/codex-integration.md
index 7692980e91..39ef68406d 100644
--- a/docs-site/src/content/docs/tr/guides/codex-integration.md
+++ b/docs-site/src/content/docs/tr/guides/codex-integration.md
@@ -353,9 +353,9 @@ sırayla kontrol edin:
 2. **`disabledModels`** (üst düzey) — modelleri hem katalogdan hem de
    `/v1/models` listesinden gizler ve yalın yerel GPT slug'larını `visibility:
    "hide"` olarak değiştirir.
-3. **Boş `models` ile `liveModels: false`** — canlı keşif kapalı olduğunda ve
-   `models` boş veya atlandığında opencodex bu sağlayıcı için hiçbir
-   yönlendirilmiş model göstermez.
+3. **`liveModels: false`** — canlı keşif kapalı olduğunda yönlendirilmiş modeller `models` ve
+   `retainModels` alanlarından gelir. `models` boş veya atlanmışsa yapılandırılmış `defaultModel` da eklenir;
+   bu alanların hiçbiri bir kimlik sağlamıyorsa opencodex yönlendirilmiş model göstermez.
 4. **Cursor `GetUsableModels`** — Cursor adaptörü modelleri `/models` üzerinden
    değil, protobuf `GetUsableModels` RPC'si üzerinden keşfeder; bu nedenle
    Cursor tarafındaki bir değişiklik diğer sağlayıcılardan bağımsız olarak hangi
diff --git a/docs-site/src/content/docs/tr/reference/configuration/providers.md b/docs-site/src/content/docs/tr/reference/configuration/providers.md
index 4213ab6001..27fe115fc1 100644
--- a/docs-site/src/content/docs/tr/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/tr/reference/configuration/providers.md
@@ -100,7 +100,7 @@ alanlı seçilmiş kimlikleri yalın kimliklere yeniden yazar.
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic anahtar başlığı stili. Varsayılan olarak yerel `x-api-key`; yalnızca anahtar kimlik doğrulamalı `anthropic` sağlayıcıları için geçerlidir. |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | Çoklu anahtar havuzu. `apiKey` aktif girdiyi yansıtır; her öğe `id`, `key`, isteğe bağlı `label` ve isteğe bağlı sayısal `addedAt` değerine sahiptir. |
 | `defaultModel?` | `string` | Bu sağlayıcı açık bir model olmadan seçildiğinde kullanılan model. |
-| `models?` | `string[]` | Tohum/geri dönüş model listesi. `liveModels: false` olduğunda bunlar keşfedilen tek modellerdir. |
+| `models?` | `string[]` | Tohum/geri dönüş listesi. `liveModels: false` iken yönlendirilen modeller `models` ve `retainModels` alanlarından gelir; `models` boşsa `defaultModel` da eklenir. |
 | `liveModels?` | `boolean` | Başlatmada/senkronizasyonda canlı kataloğu getirin (varsayılan `true`). Özel sağlayıcılar `${baseUrl}/models` kullanır; yerleşikler bir kayıt defteri URL'si ve filtresi kullanabilir. |
 | `selectedModels?` | `string[]` | Keşiften sonra katalog izin listesi. Boş olmaması yalnızca bu kimlikleri gösterir; boş veya atlanmış olması keşfedilen tüm modelleri gösterir. |
 | `contextWindow?` | `number` | Yukarı akış meta verileri olmadığında sağlayıcı genelinde bağlam geri dönüşü; aksi takdirde daha küçük canlı meta verileri koruyan bir sınır. Modeller kontrol paneli bunu `providerContextCaps` alanından ayrı olarak gösterir. |
@@ -476,8 +476,8 @@ uygulamadan önce yerel `zai/glm-5.2` kimliğini geri yükler. Aynı eşleme yer
 
 ## Statik model izin listeleri
 
-Yalnızca `models`'ı göstermek için `liveModels: false` ayarlayın. `models` boşsa
-veya atlanırsa sağlayıcı yönlendirilen hiçbir modeli göstermez. Canlı keşif,
+Yalnızca yapılandırılmış modelleri göstermek için `liveModels: false` ayarlayın. Yönlendirilen modeller `models` ve `retainModels` alanlarından gelir;
+`models` boşsa veya atlanırsa yapılandırılmış `defaultModel` da eklenir. Bu alanların hiçbiri bir kimlik sağlamıyorsa yönlendirilmiş model gösterilmez. Canlı keşif,
 önbelleğe almadan önce 4 MiB'den veya 2.000 ham model satırından fazlasını
 reddeder; yerleşik önayarlar daha düşük sınırlar kullanabilir ve sohbete uygun
 satırlara filtre uygulayabilir. Büyük boyutlu veya hatalı biçimlendirilmiş
diff --git a/docs-site/src/content/docs/zh-cn/guides/codex-integration.md b/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
index e2a5601d62..e9ddcf3307 100644
--- a/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
+++ b/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
@@ -260,8 +260,8 @@ provider 形式一样，从 `OPENCODEX_API_AUTH_TOKEN` 传入 `x-opencodex-api-k
    所有发现到的模型。一个不在 allowlist 里的 id 永远不会进入 catalog。
 2. **`disabledModels`**（顶层） - 会同时隐藏 catalog 和 `/v1/models` 中的模型，并把裸原生 GPT slug
    切成 `visibility: "hide"`。
-3. **`liveModels: false` 且 `models` 为空** - 当 live discovery 关闭而 `models` 为空或省略时，opencodex
-   不会为那个 provider 暴露任何路由模型。
+3. **`liveModels: false`** - 关闭 live discovery 后，路由模型来自 `models` 和 `retainModels`。
+   当 `models` 为空或省略时，还会包含已配置的 `defaultModel`；这些字段都没有提供 id 时，opencodex 才不暴露路由模型。
 4. **Cursor `GetUsableModels`** - Cursor adapter 通过它的 protobuf `GetUsableModels` RPC 发现模型，而不是
    `/models`，所以 Cursor 侧的变动会独立于其他 provider 改变哪些 id 可见。
 5. **缓存和 `ocx sync`** - live catalog 的缓存时间大约是五分钟（`modelCacheTtlMs`，默认 `300000`）。
diff --git a/docs-site/src/content/docs/zh-cn/reference/configuration/providers.md b/docs-site/src/content/docs/zh-cn/reference/configuration/providers.md
index f2d245b5ec..142faba847 100644
--- a/docs-site/src/content/docs/zh-cn/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/zh-cn/reference/configuration/providers.md
@@ -81,7 +81,7 @@ selector，而不是分配一个新名称。
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic key 头部样式。默认使用原生 `x-api-key`；仅对 key-auth `anthropic` 提供者有效。 |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多 key 池。`apiKey` 会镜像当前激活条目；每个条目都有 `id`、`key`、可选 `label`，以及可选的数值 `addedAt`。 |
 | `defaultModel?` | `string` | 当选择该提供者但未显式指定模型时使用的模型。 |
-| `models?` | `string[]` | 种子/回退模型列表。配合 `liveModels: false` 时，这些就是唯一发现到的模型。 |
+| `models?` | `string[]` | 种子/回退模型列表。配合 `liveModels: false` 时，路由模型来自 `models` 和 `retainModels`；`models` 为空时还会包含 `defaultModel`。 |
 | `liveModels?` | `boolean` | 启动/同步时获取实时目录（默认 `true`）。自定义提供者使用 `${baseUrl}/models`；内置项可能使用注册表 URL 并进行过滤。 |
 | `selectedModels?` | `string[]` | 发现之后的目录允许列表。非空时只暴露这些 id；为空或省略时则暴露全部发现到的模型。 |
 | `modelDisplayNames?` | `Record<string, string>` | 持久的仅显示名称，以此提供者的精确原生模型 id 为键。键区分大小写。名称优先于提供者目录元数据，并且不会改变身份验证、适配器、路由、计费或上游请求。该映射最多可包含 2,000 个条目，与发现上限相同。 |
@@ -357,7 +357,7 @@ Vercel AI Gateway 可以在多个底层推理提供者之间路由一个模型
 
 ## 静态模型允许列表
 
-将 `liveModels: false` 设为只暴露 `models`。如果 `models` 为空或省略，该提供者将不暴露任何路由模型。实时发现会在缓存前拒绝超过 4 MiB 或 2,000 条原始模型行；内置预设可能使用更低的限制，并过滤为可聊天的行。过大或格式错误的结果会走陈旧/配置回退。合法的、零可用结果的发现仍然具有权威性，不会被静默替换或截断。
+将 `liveModels: false` 设为只暴露已配置模型。路由模型来自 `models` 和 `retainModels`；如果 `models` 为空或省略，还会包含已配置的 `defaultModel`。这些字段都没有提供 id 时才不暴露路由模型。实时发现会在缓存前拒绝超过 4 MiB 或 2,000 条原始模型行；内置预设可能使用更低的限制，并过滤为可聊天的行。过大或格式错误的结果会走陈旧/配置回退。合法的、零可用结果的发现仍然具有权威性，不会被静默替换或截断。
 
 当需要继续运行发现，但只有选定 id 应该出现在 Codex 和 `/v1/models` 中时，请使用 `selectedModels`。仪表板会保留完整的已发现列表，以便之后调整允许列表。
 
diff --git a/docs-site/src/content/docs/zh-tw/guides/codex-integration.md b/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
index 4166276fbc..f096f22502 100644
--- a/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
+++ b/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
@@ -266,8 +266,8 @@ OpenCodex 直接注入路由，請先將 Codex 切回內建 `openai` provider，
    已發現模型。不在 allowlist 中的 id 永遠不會進入目錄。
 2. **`disabledModels`（頂層）**：會同時從目錄與 `/v1/models` 隱藏模型，並把裸原生 GPT slug 設為
    `visibility: "hide"`。
-3. **`liveModels: false` 且 `models` 為空**：當即時探索關閉，且 `models` 為空或省略時，opencodex
-   不會為該 provider 暴露任何路由模型。
+3. **`liveModels: false`**：關閉即時探索後，路由模型來自 `models` 和 `retainModels`。
+   當 `models` 為空或省略時，還會包含已設定的 `defaultModel`；這些欄位皆未提供 id 時，opencodex 才不暴露路由模型。
 4. **Cursor `GetUsableModels`**：Cursor adapter 透過 protobuf `GetUsableModels` RPC 探索模型，而不是
    `/models`，所以 Cursor 端變更可獨立改變可見 id。
 5. **cache 與 `ocx sync`**：即時目錄約快取五分鐘（`modelCacheTtlMs`，預設 `300000`）。執行
diff --git a/docs-site/src/content/docs/zh-tw/reference/configuration/providers.md b/docs-site/src/content/docs/zh-tw/reference/configuration/providers.md
index 7a27de4f61..5154957052 100644
--- a/docs-site/src/content/docs/zh-tw/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/zh-tw/reference/configuration/providers.md
@@ -63,7 +63,7 @@ ocx models provider openrouter on
 | `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic 金鑰標頭風格。預設為原生 `x-api-key`；僅對 key-auth `anthropic` 供應商有效。 |
 | `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多金鑰池。`apiKey` 反映現用項目；每個項目有 `id`、`key`、可選 `label` 與可選數值 `addedAt`。 |
 | `defaultModel?` | `string` | 在未指定明確模型時選擇此供應商所使用的模型。 |
-| `models?` | `string[]` | 播種／後備模型清單。在 `liveModels: false` 時，這些是唯一探索的模型。 |
+| `models?` | `string[]` | 播種／後備模型清單。`liveModels: false` 時，路由模型來自 `models` 和 `retainModels`；`models` 為空時還會包含 `defaultModel`。 |
 | `liveModels?` | `boolean` | 在啟動／同步時擷取即時目錄（預設 `true`）。自訂供應商使用 `${baseUrl}/models`；內建可能使用 registry URL 並過濾。 |
 | `selectedModels?` | `string[]` | 探索後的目錄允許清單。非空時僅暴露那些 id；空或省略時暴露所有探索的模型。 |
 | `contextWindow?` | `number` | 供應商範圍的 Codex 可見 context 上限。較小的即時中繼資料被保留。 |
@@ -324,7 +324,7 @@ Vercel AI Gateway 可在多個底層推論供應商之間路由一個模型。`v
 
 ## 靜態模型允許清單
 
-設定 `liveModels: false` 以僅暴露 `models`。若 `models` 為空或省略，供應商暴露無路由模型。即時探索在快取前拒絕超過 4 MiB 或 2,000 個原始模型列；內建預設可能使用較低限制並過濾到 chat 合格列。過大或格式錯誤的結果遵循過時／設定的後備。有效的零合格結果恆為權威，且不被靜默取代或截斷。
+設定 `liveModels: false` 以僅暴露已設定模型。路由模型來自 `models` 和 `retainModels`；若 `models` 為空或省略，還會包含已設定的 `defaultModel`。這些欄位皆未提供 id 時才不暴露路由模型。即時探索在快取前拒絕超過 4 MiB 或 2,000 個原始模型列；內建預設可能使用較低限制並過濾到 chat 合格列。過大或格式錯誤的結果遵循過時／設定的後備。有效的零合格結果恆為權威，且不被靜默取代或截斷。
 
 當探索應仍然執行但只有 selected id 應出現在 Codex 與 `/v1/models` 時，請使用 `selectedModels`。儀表板保留完整的探索清單供日後允許清單變更。
 
diff --git a/gui/src/components/provider-workspace/ProviderDetails.tsx b/gui/src/components/provider-workspace/ProviderDetails.tsx
index 645511f69d..7a1f66a213 100644
--- a/gui/src/components/provider-workspace/ProviderDetails.tsx
+++ b/gui/src/components/provider-workspace/ProviderDetails.tsx
@@ -32,6 +32,7 @@ export default function ProviderDetails({
   availableModels,
   hasLiveModels,
   selectedModels,
+  disabledModels,
   modelsLoading,
   modelsLoadFailed,
   onRetryModels,
@@ -65,6 +66,7 @@ export default function ProviderDetails({
   /** Server-reported live-catalog provenance; see filterModels(). */
   hasLiveModels: boolean;
   selectedModels: string[];
+  disabledModels: string[];
   modelsLoading?: boolean;
   modelsLoadFailed?: boolean;
   onRetryModels?: () => void;
@@ -293,6 +295,7 @@ export default function ProviderDetails({
             availableModels={availableModels}
             hasLiveModels={hasLiveModels}
             selectedModels={selectedModels}
+            disabledModels={disabledModels}
             modelsLoading={modelsLoading}
             modelsLoadFailed={modelsLoadFailed}
             needsReauth={
diff --git a/gui/src/components/provider-workspace/ProviderModels.tsx b/gui/src/components/provider-workspace/ProviderModels.tsx
index 56cc588292..2f89b886d6 100644
--- a/gui/src/components/provider-workspace/ProviderModels.tsx
+++ b/gui/src/components/provider-workspace/ProviderModels.tsx
@@ -7,14 +7,19 @@ import { useEffect, useMemo, useRef, useState } from "react";
 import { useT } from "../../i18n/shared";
 import type { WorkspaceItem } from "../../provider-workspace/catalog";
 import { filterModels } from "../../provider-workspace/report";
+import { IconEyeOff, IconTrash } from "../../icons";
+import { putModelVisibility } from "../../model-visibility";
 import { encodedModelIdCollides } from "../../../../src/providers/slug-codec";
 
+type CustomModelRef = { id?: string; modelId: string };
+
 export default function ProviderModels({
   item,
   apiBase,
   availableModels,
   hasLiveModels,
   selectedModels,
+  disabledModels,
   modelsLoading = false,
   modelsLoadFailed = false,
   needsReauth = false,
@@ -25,6 +30,7 @@ export default function ProviderModels({
   apiBase: string;
   availableModels: string[];
   selectedModels: string[];
+  disabledModels: string[];
   /** Server-reported: did the last successful discovery return any rows? */
   hasLiveModels: boolean;
   modelsLoading?: boolean;
@@ -38,16 +44,20 @@ export default function ProviderModels({
   const [query, setQuery] = useState("");
   const [customModelId, setCustomModelId] = useState("");
   const [customSaving, setCustomSaving] = useState(false);
+  const [removingModelId, setRemovingModelId] = useState<string | null>(null);
+  const [removedModelIds, setRemovedModelIds] = useState<Set<string>>(() => new Set());
   const [customError, setCustomError] = useState("");
   const [customSuccess, setCustomSuccess] = useState("");
-  const [customModelIds, setCustomModelIds] = useState<string[]>([]);
+  const [customModels, setCustomModels] = useState<CustomModelRef[]>([]);
   const [customModelsReady, setCustomModelsReady] = useState(false);
   const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
   const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
   const [copiedId, setCopiedId] = useState<string | null>(null);
   const copyResetRef = useRef<number | null>(null);
   const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
+  const hiddenSet = useMemo(() => new Set([...disabledModels, ...removedModelIds]), [disabledModels, removedModelIds]);
   const configuredModels = useMemo(() => item.models ?? [], [item.models]);
+  const customModelIds = useMemo(() => customModels.map(model => model.modelId), [customModels]);
   const trimmedCustomModelId = customModelId.trim();
   const knownModelIds = [
     ...availableModels,
@@ -63,8 +73,9 @@ export default function ProviderModels({
     || item.defaultModel === trimmedCustomModelId
     || encodedModelIdCollides(trimmedCustomModelId, knownModelIds);
   const models = useMemo(
-    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels),
-    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels],
+    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels)
+      .filter(modelId => !hiddenSet.has(modelId)),
+    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels, hiddenSet],
   );
 
   useEffect(() => {
@@ -76,17 +87,20 @@ export default function ProviderModels({
         const rows: unknown = await response.json();
         if (!Array.isArray(rows)) throw new Error("Invalid custom model list");
         if (!active) return;
-        setCustomModelIds(rows.flatMap(row => {
+        setCustomModels(rows.flatMap(row => {
           if (!row || typeof row !== "object") return [];
-          const model = row as { provider?: unknown; modelId?: unknown };
-          return model.provider === item.name && typeof model.modelId === "string" ? [model.modelId] : [];
+          const model = row as { id?: unknown; provider?: unknown; modelId?: unknown };
+          return model.provider === item.name
+            && typeof model.modelId === "string"
+            ? [{ ...(typeof model.id === "string" ? { id: model.id } : {}), modelId: model.modelId }]
+            : [];
         }));
         setCustomModelsLoadFailed(false);
         setCustomError("");
         setCustomModelsReady(true);
       } catch {
         if (!active) return;
-        setCustomModelIds([]);
+        setCustomModels([]);
         // Without this the component stays permanently unable to add a model: `customModelsReady`
         // never flips back and the effect has no trigger left, so a single transient GET failure
         // disabled Add until the whole panel remounted.
@@ -136,7 +150,20 @@ export default function ProviderModels({
         body: JSON.stringify({ provider: item.name, modelId: trimmedCustomModelId }),
       });
       if (response.ok) {
-        setCustomModelIds(ids => ids.includes(trimmedCustomModelId) ? ids : [...ids, trimmedCustomModelId]);
+        const added: unknown = await response.json();
+        if (!added || typeof added !== "object" || typeof (added as { id?: unknown }).id !== "string") {
+          setCustomError(t("models.customSaveFailed"));
+          return;
+        }
+        const id = (added as { id: string }).id;
+        setCustomModels(models => models.some(model => model.modelId === trimmedCustomModelId)
+          ? models
+          : [...models, { id, modelId: trimmedCustomModelId }]);
+        setRemovedModelIds(ids => {
+          const next = new Set(ids);
+          next.delete(trimmedCustomModelId);
+          return next;
+        });
         setCustomModelId("");
         setCustomSuccess(t("models.customAdded"));
         onRetryModels?.();
@@ -150,6 +177,39 @@ export default function ProviderModels({
     }
   };
 
+  const removeModel = async (modelId: string) => {
+    const customModel = customModels.find(model => model.modelId === modelId && model.id);
+    if (removingModelId || !window.confirm(t(customModel ? "models.customDeleteConfirm" : "models.hideConfirm", { name: modelId }))) return;
+    const visibilityTarget = { id: modelId, ...(item.name === "openai" ? { native: true } : {}) };
+    setRemovingModelId(modelId);
+    setCustomError("");
+    setCustomSuccess("");
+    try {
+      if (customModel?.id) {
+        const deleteResponse = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(customModel.id)}`, { method: "DELETE" });
+        if (!deleteResponse.ok) {
+          setCustomError(t("models.customSaveFailed"));
+          return;
+        }
+        setCustomModels(models => models.filter(model => model.modelId !== modelId));
+      }
+      const visibilityResponse = await putModelVisibility(apiBase, "models", item.name, [visibilityTarget], false);
+      if (!visibilityResponse.ok) {
+        onRetryModels?.();
+        setCustomError(t("models.saveFailed"));
+        return;
+      }
+      setRemovedModelIds(ids => new Set(ids).add(modelId));
+      setCustomSuccess(t(customModel ? "models.customDeleted" : "models.applied"));
+      onRetryModels?.();
+    } catch {
+      onRetryModels?.();
+      setCustomError(t("models.networkError"));
+    } finally {
+      setRemovingModelId(null);
+    }
+  };
+
   const emptyBase = availableModels.length === 0
     && configuredModels.length === 0
     && customModelIds.length === 0
@@ -247,7 +307,9 @@ export default function ProviderModels({
           {visibleModels.map(modelId => {
             const isDefault = modelId === item.defaultModel;
             const isSelected = selectedSet.has(modelId);
+            const isCustom = customModels.some(model => model.modelId === modelId && model.id);
             const copied = copiedId === modelId;
+            const removeLabel = t(isCustom ? "models.customDelete" : "models.hide");
             return (
               <li key={modelId} className="pws-model-chip">
                 <button
@@ -261,6 +323,18 @@ export default function ProviderModels({
                 </button>
                 {isDefault ? <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span> : null}
                 {isSelected ? <span className="badge badge-accent pws-model-flag">{t("pws.selected")}</span> : null}
+                <button
+                  type="button"
+                  className="btn btn-ghost btn-sm btn-icon-only"
+                  onClick={() => { void removeModel(modelId); }}
+                  disabled={customSaving || removingModelId !== null}
+                  aria-label={removeLabel}
+                  title={removeLabel}
+                >
+                  {isCustom
+                    ? <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
+                    : <IconEyeOff style={{ width: 13, height: 13 }} aria-hidden="true" />}
+                </button>
               </li>
             );
           })}
diff --git a/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx b/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx
index 91faecb6fc..24fe187f94 100644
--- a/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx
+++ b/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx
@@ -24,7 +24,7 @@ import {
 import { providerKind } from "../../provider-workspace/kind";
 import { readJsonIfOk, readJsonOrThrow } from "../../fetch-json";
 import { readSessionListCache, writeSessionListCache } from "../../session-list-cache";
-import { buildProviderModelUsage, buildProviderUsageTotals, countAvailableModels, parseAvailableModels, parseLiveModelCounts, parseSelectedModels, type ProviderAvailableModels, type ProviderLiveModelCounts, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
+import { buildProviderModelUsage, buildProviderUsageTotals, countAvailableModels, parseAvailableModels, parseDisabledModels, parseLiveModelCounts, parseSelectedModels, type ProviderAvailableModels, type ProviderDisabledModels, type ProviderLiveModelCounts, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
 import {
   freshQuotaReportRecord,
   freshQuotaReportsFromResponse,
@@ -47,6 +47,7 @@ export interface DetailSlotData {
   /** Did the last successful discovery return rows? Server-reported, never inferred. */
   hasLiveModels: boolean;
   selectedModels: string[];
+  disabledModels: string[];
   modelsLoading: boolean;
   modelsLoadFailed: boolean;
   onRetryModels?: () => void;
@@ -141,6 +142,7 @@ export default function ProviderWorkspaceShell({
   const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
   const [liveModelCounts, setLiveModelCounts] = useState<ProviderLiveModelCounts>({});
   const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
+  const [disabledModels, setDisabledModels] = useState<ProviderDisabledModels>({});
   const [modelsLoading, setModelsLoading] = useState(false);
   const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
   const quotasCacheKey = `ocx.providers.quotas.v1:${apiBase}`;
@@ -189,6 +191,7 @@ export default function ProviderWorkspaceShell({
           setAvailableModels(parseAvailableModels(data));
           setLiveModelCounts(parseLiveModelCounts(data));
           setSelectedModels(parseSelectedModels(data));
+          setDisabledModels(parseDisabledModels(data));
           setModelsLoadFailed(false);
           succeeded = true;
         } catch {
@@ -559,6 +562,7 @@ export default function ProviderWorkspaceShell({
             availableModels: availableModels[selectedItem.name] ?? [],
             hasLiveModels: (liveModelCounts[selectedItem.name] ?? 0) > 0,
             selectedModels: selectedModels[selectedItem.name] ?? [],
+            disabledModels: disabledModels[selectedItem.name] ?? [],
             modelsLoading,
             modelsLoadFailed,
             onRetryModels: retryModels,
diff --git a/gui/src/i18n/de.ts b/gui/src/i18n/de.ts
index 4d4b79e5d5..c29aad7355 100644
--- a/gui/src/i18n/de.ts
+++ b/gui/src/i18n/de.ts
@@ -577,6 +577,8 @@ export const de: Record<TKey, string> = {
   "models.customEdit": "Bearbeiten",
   "models.customDelete": "Löschen",
   "models.customDeleteConfirm": "Modell {name} löschen?",
+  "models.hide": "Ausblenden",
+  "models.hideConfirm": "Modell {name} aus dem Katalog ausblenden?",
   "models.customBadge": "Benutzerdefiniert",
   "models.customSummary": "{count} benutzerdefiniert",
   "models.customFieldModelId": "Modell-ID (Endpunkt-Slug)",
diff --git a/gui/src/i18n/en.ts b/gui/src/i18n/en.ts
index cf9eb253dd..ae4761051f 100644
--- a/gui/src/i18n/en.ts
+++ b/gui/src/i18n/en.ts
@@ -602,6 +602,8 @@ export const en = {
   "models.customEdit": "Edit",
   "models.customDelete": "Delete",
   "models.customDeleteConfirm": "Delete the {name} model?",
+  "models.hide": "Hide",
+  "models.hideConfirm": "Hide the {name} model from the catalog?",
   "models.customBadge": "Custom",
   "models.customSummary": "{count} custom",
   "models.customFieldModelId": "Model ID (endpoint slug)",
diff --git a/gui/src/i18n/fr.ts b/gui/src/i18n/fr.ts
index 2d90382f1a..455898688e 100644
--- a/gui/src/i18n/fr.ts
+++ b/gui/src/i18n/fr.ts
@@ -587,6 +587,8 @@ export const fr: Record<TKey, string> = {
   "models.customEdit": "Modifier",
   "models.customDelete": "Supprimer",
   "models.customDeleteConfirm": "Supprimer le modèle {name} ?",
+  "models.hide": "Masquer",
+  "models.hideConfirm": "Masquer le modèle {name} du catalogue ?",
   "models.customBadge": "Personnalisé",
   "models.customSummary": "{count} personnalisés",
   "models.customFieldModelId": "ID du modèle (slug du point de terminaison)",
diff --git a/gui/src/i18n/ja.ts b/gui/src/i18n/ja.ts
index c9d2e9ea4a..d413daa401 100644
--- a/gui/src/i18n/ja.ts
+++ b/gui/src/i18n/ja.ts
@@ -2315,6 +2315,8 @@ export const ja: Record<TKey, string> = {
   "models.customEdit": "Edit",
   "models.customDelete": "Delete",
   "models.customDeleteConfirm": "Delete the {name} model?",
+  "models.hide": "非表示",
+  "models.hideConfirm": "モデル {name} をカタログから非表示にしますか？",
   "models.customBadge": "Custom",
   "models.customSummary": "{count} custom",
   "models.customFieldModelId": "Model ID (endpoint slug)",
diff --git a/gui/src/i18n/ko.ts b/gui/src/i18n/ko.ts
index d9c983a5fb..7ffa869a59 100644
--- a/gui/src/i18n/ko.ts
+++ b/gui/src/i18n/ko.ts
@@ -588,6 +588,8 @@ export const ko: Record<TKey, string> = {
   "models.customEdit": "편집",
   "models.customDelete": "삭제",
   "models.customDeleteConfirm": "{name} 모델을 삭제하시겠습니까?",
+  "models.hide": "숨기기",
+  "models.hideConfirm": "{name} 모델을 카탈로그에서 숨기시겠습니까?",
   "models.customBadge": "커스텀",
   "models.customSummary": "커스텀 {count}개",
   "models.customFieldModelId": "모델 ID (엔드포인트 슬러그)",
diff --git a/gui/src/i18n/ru.ts b/gui/src/i18n/ru.ts
index 950cea7a81..324eae13fd 100644
--- a/gui/src/i18n/ru.ts
+++ b/gui/src/i18n/ru.ts
@@ -590,6 +590,8 @@ export const ru: Record<TKey, string> = {
   "models.customEdit": "Изменить",
   "models.customDelete": "Удалить",
   "models.customDeleteConfirm": "Удалить модель {name}?",
+  "models.hide": "Скрыть",
+  "models.hideConfirm": "Скрыть модель {name} из каталога?",
   "models.customBadge": "Пользовательская",
   "models.customSummary": "Пользовательских: {count}",
   "models.customFieldModelId": "ID модели (slug эндпоинта)",
diff --git a/gui/src/i18n/tr.ts b/gui/src/i18n/tr.ts
index 5db3ca23b5..37865f57c8 100644
--- a/gui/src/i18n/tr.ts
+++ b/gui/src/i18n/tr.ts
@@ -593,6 +593,8 @@ export const tr: Record<TKey, string> = {
   "models.customEdit": "Düzenle",
   "models.customDelete": "Sil",
   "models.customDeleteConfirm": "{name} modeli silinsin mi?",
+  "models.hide": "Gizle",
+  "models.hideConfirm": "{name} modeli katalogda gizlensin mi?",
   "models.customBadge": "Özel",
   "models.customSummary": "{count} özel",
   "models.customFieldModelId": "Model ID",
diff --git a/gui/src/i18n/zh-TW.ts b/gui/src/i18n/zh-TW.ts
index 06f8e6fa4b..b8a842bbcf 100644
--- a/gui/src/i18n/zh-TW.ts
+++ b/gui/src/i18n/zh-TW.ts
@@ -456,6 +456,8 @@ export const zhTW: Record<TKey, string> = {
   "models.customEdit": "編輯",
   "models.customDelete": "刪除",
   "models.customDeleteConfirm": "要刪除模型 {name} 嗎？",
+  "models.hide": "隱藏",
+  "models.hideConfirm": "要從目錄中隱藏模型 {name} 嗎？",
   "models.customBadge": "自訂",
   "models.customSummary": "{count} 個自訂模型",
   "models.customFieldModelId": "模型 ID（端點標識）",
diff --git a/gui/src/i18n/zh.ts b/gui/src/i18n/zh.ts
index 315869d88d..28758e6157 100644
--- a/gui/src/i18n/zh.ts
+++ b/gui/src/i18n/zh.ts
@@ -585,6 +585,8 @@ export const zh: Record<TKey, string> = {
   "models.customEdit": "编辑",
   "models.customDelete": "删除",
   "models.customDeleteConfirm": "要删除模型 {name} 吗？",
+  "models.hide": "隐藏",
+  "models.hideConfirm": "要从目录中隐藏模型 {name} 吗？",
   "models.customBadge": "自定义",
   "models.customSummary": "{count} 个自定义模型",
   "models.customFieldModelId": "模型 ID（端点标识）",
diff --git a/gui/src/icons.tsx b/gui/src/icons.tsx
index 6ec2ebf096..70afe03db9 100644
--- a/gui/src/icons.tsx
+++ b/gui/src/icons.tsx
@@ -24,6 +24,7 @@ export const IconRefresh = (p: P) => (<svg {...S(p)}><path d="M21 12a9 9 0 0 1-9
 export const IconPause = (p: P) => (<svg {...S(p)}><path d="M8 5v14M16 5v14"/></svg>);
 export const IconPlay = (p: P) => (<svg {...S(p)}><path d="m7 4 13 8-13 8Z"/></svg>);
 export const IconTrash = (p: P) => (<svg {...S(p)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>);
+export const IconEyeOff = (p: P) => (<svg {...S(p)}><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 9 4 10 8a12.7 12.7 0 0 1-2 4.1M6.6 6.6A12.4 12.4 0 0 0 2 12c1 4 5 8 10 8 1.5 0 2.9-.4 4.1-1"/></svg>);
 export const IconPencil = (p: P) => (<svg {...S(p)}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>);
 export const IconAlert = (p: P) => (<svg {...S(p)}><path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>);
 export const IconInfo = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>);
diff --git a/gui/src/pages/Providers.tsx b/gui/src/pages/Providers.tsx
index 8701b3acd3..84832e2d1b 100644
--- a/gui/src/pages/Providers.tsx
+++ b/gui/src/pages/Providers.tsx
@@ -459,6 +459,7 @@ export default function Providers({ apiBase }: { apiBase: string }) {
             availableModels={data.availableModels}
             hasLiveModels={data.hasLiveModels}
             selectedModels={data.selectedModels}
+            disabledModels={data.disabledModels}
             modelsLoading={data.modelsLoading}
             modelsLoadFailed={data.modelsLoadFailed}
             onRetryModels={data.onRetryModels}
diff --git a/gui/src/provider-workspace/usage.ts b/gui/src/provider-workspace/usage.ts
index 033bdbcee2..4cae58417a 100644
--- a/gui/src/provider-workspace/usage.ts
+++ b/gui/src/provider-workspace/usage.ts
@@ -16,6 +16,7 @@ import type { ProviderModelUsageRow } from "../components/provider-workspace/typ
 export type ProviderModelCounts = Record<string, number>;
 export type ProviderAvailableModels = Record<string, string[]>;
 export type ProviderSelectedModels = Record<string, string[]>;
+export type ProviderDisabledModels = Record<string, string[]>;
 
 /** Parse `/api/selected-models` available map into provider -> model id list. */
 export function parseAvailableModels(data: unknown): ProviderAvailableModels {
@@ -64,10 +65,26 @@ export function parseSelectedModels(data: unknown): ProviderSelectedModels {
   return models;
 }
 
+/** Parse `/api/selected-models` disabled map into provider -> hidden model id list. */
+export function parseDisabledModels(data: unknown): ProviderDisabledModels {
+  if (!data || typeof data !== "object") return {};
+  const disabled = (data as { disabled?: unknown }).disabled;
+  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return {};
+
+  const models: ProviderDisabledModels = {};
+  for (const [provider, ids] of Object.entries(disabled)) {
+    if (!Array.isArray(ids)) continue;
+    models[provider] = ids.filter((id): id is string => typeof id === "string");
+  }
+  return models;
+}
+
 export function countAvailableModels(data: unknown): ProviderModelCounts {
   const counts: ProviderModelCounts = {};
+  const disabled = parseDisabledModels(data);
   for (const [provider, models] of Object.entries(parseAvailableModels(data))) {
-    counts[provider] = models.length;
+    const hidden = new Set(disabled[provider] ?? []);
+    counts[provider] = models.filter(model => !hidden.has(model)).length;
   }
   return counts;
 }
diff --git a/gui/tests/provider-model-custom-add.test.tsx b/gui/tests/provider-model-custom-add.test.tsx
index 6ebc04134a..ee3046845b 100644
--- a/gui/tests/provider-model-custom-add.test.tsx
+++ b/gui/tests/provider-model-custom-add.test.tsx
@@ -5,6 +5,7 @@ import type { Root } from "react-dom/client";
 import { LanguageProvider } from "../src/i18n/provider";
 import ProviderModels from "../src/components/provider-workspace/ProviderModels";
 import type { WorkspaceItem } from "../src/provider-workspace/catalog";
+import { countAvailableModels } from "../src/provider-workspace/usage";
 
 const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
 const originalFetch = globalThis.fetch;
@@ -40,11 +41,17 @@ const item = {
   defaultModel: "claude-opus-5",
 } as WorkspaceItem;
 
+test("provider model counts exclude removed models", () => {
+  expect(countAvailableModels({ available: { vendor: ["a", "b", "c"] }, disabled: { vendor: ["b"] } }))
+    .toEqual({ vendor: 2 });
+});
+
 async function mountProviderModels(
   availableModels = ["claude-opus-5"],
   onRetryModels?: () => void,
   providerItem = item,
   hasLiveModels = true,
+  disabledModels: string[] = [],
 ): Promise<{ root: Root; container: HTMLElement; input: HTMLInputElement; addButton: HTMLButtonElement }> {
   const container = document.createElement("div");
   document.body.append(container);
@@ -59,6 +66,7 @@ async function mountProviderModels(
           availableModels={availableModels}
           hasLiveModels={hasLiveModels}
           selectedModels={[]}
+          disabledModels={disabledModels}
           apiBase="http://localhost:10100"
           onRetryModels={onRetryModels}
         />
@@ -205,6 +213,194 @@ test("custom-only catalog keeps configured fallback models visible", async () =>
   await act(async () => { root.unmount(); });
 });
 
+test("custom models use their stable id and persist discovered-model visibility when deleted", async () => {
+  const requests: Array<{ url: string; method: string; body: unknown }> = [];
+  globalThis.fetch = (async (input, init) => {
+    if (!init?.method || init.method === "GET") {
+      return Response.json([
+        { id: "custom-1", provider: "AiCodeWith", modelId: "claude-opus-5.1-custom" },
+      ]);
+    }
+    requests.push({
+      url: String(input),
+      method: init.method,
+      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
+    });
+    return Response.json({ ok: true });
+  }) as typeof fetch;
+  testWindow.confirm = () => true;
+
+  let refreshes = 0;
+  const { root, container } = await mountProviderModels(
+    ["claude-opus-5", "claude-opus-5.1-custom"],
+    () => { refreshes += 1; },
+  );
+  await act(async () => { await Promise.resolve(); });
+
+  const customChip = [...container.querySelectorAll(".pws-model-chip")]
+    .find(chip => chip.querySelector(".pws-model-id")?.textContent === "claude-opus-5.1-custom")!;
+  const deleteButton = customChip.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!;
+  await act(async () => {
+    deleteButton.click();
+    await Promise.resolve();
+    await Promise.resolve();
+  });
+
+  expect(requests).toEqual([
+    {
+      url: "http://localhost:10100/api/custom-models/custom-1",
+      method: "DELETE",
+      body: undefined,
+    },
+    {
+      url: "http://localhost:10100/api/model-visibility",
+      method: "PUT",
+      body: {
+        scope: "models",
+        provider: "AiCodeWith",
+        targets: [{ id: "claude-opus-5.1-custom" }],
+        enabled: false,
+      },
+    },
+  ]);
+  expect(refreshes).toBe(1);
+  expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent))
+    .toEqual(["claude-opus-5"]);
+  expect(container.querySelector('[role="status"]')?.textContent).toContain("Custom model deleted");
+
+  await act(async () => { root.unmount(); });
+});
+
+test("a custom model stays visible when its visibility update fails", async () => {
+  globalThis.fetch = (async (_input, init) => {
+    if (!init?.method || init.method === "GET") {
+      return Response.json([
+        { id: "custom-1", provider: "AiCodeWith", modelId: "claude-opus-5.1-custom" },
+      ]);
+    }
+    if (init.method === "DELETE") return Response.json({ ok: true });
+    return Response.json({ error: "failed" }, { status: 500 });
+  }) as typeof fetch;
+  testWindow.confirm = () => true;
+
+  const { root, container } = await mountProviderModels(["claude-opus-5.1-custom"]);
+  await act(async () => { await Promise.resolve(); });
+
+  await act(async () => {
+    container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click();
+    await Promise.resolve();
+    await Promise.resolve();
+  });
+
+  expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent))
+    .toEqual(["claude-opus-5.1-custom"]);
+  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
+
+  await act(async () => { root.unmount(); });
+});
+
+test("discovered models are labeled as hidden and removed from the local catalog", async () => {
+  const requests: Array<{ url: string; method: string; body: unknown }> = [];
+  globalThis.fetch = (async (input, init) => {
+    if (!init?.method || init.method === "GET") return Response.json([]);
+    requests.push({
+      url: String(input),
+      method: init.method,
+      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
+    });
+    return Response.json({ ok: true });
+  }) as typeof fetch;
+  let confirmation = "";
+  testWindow.confirm = message => {
+    confirmation = String(message);
+    return true;
+  };
+
+  let refreshes = 0;
+  const { root, container } = await mountProviderModels(
+    ["claude-opus-5", "claude-sonnet-5"],
+    () => { refreshes += 1; },
+  );
+  await act(async () => { await Promise.resolve(); });
+
+  const discoveredChip = [...container.querySelectorAll(".pws-model-chip")]
+    .find(chip => chip.querySelector(".pws-model-id")?.textContent === "claude-sonnet-5")!;
+  const hideButton = discoveredChip.querySelector<HTMLButtonElement>('button[aria-label="Hide"]')!;
+  expect(hideButton.title).toBe("Hide");
+  await act(async () => {
+    hideButton.click();
+    await Promise.resolve();
+  });
+
+  expect(confirmation).toBe("Hide the claude-sonnet-5 model from the catalog?");
+  expect(requests).toEqual([{
+    url: "http://localhost:10100/api/model-visibility",
+    method: "PUT",
+    body: {
+      scope: "models",
+      provider: "AiCodeWith",
+      targets: [{ id: "claude-sonnet-5" }],
+      enabled: false,
+    },
+  }]);
+  expect(refreshes).toBe(1);
+  expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent))
+    .toEqual(["claude-opus-5"]);
+  expect(container.querySelector('[role="status"]')?.textContent).toContain("Applied");
+
+  await act(async () => { root.unmount(); });
+});
+
+test("native OpenAI models use a native visibility target when removed", async () => {
+  const requests: unknown[] = [];
+  globalThis.fetch = (async (_input, init) => {
+    if (!init?.method || init.method === "GET") return Response.json([]);
+    requests.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined);
+    return Response.json({ ok: true });
+  }) as typeof fetch;
+  testWindow.confirm = () => true;
+  const openAiItem = {
+    ...item,
+    name: "openai",
+    models: ["gpt-5.5"],
+    defaultModel: "gpt-5.5",
+  } as WorkspaceItem;
+
+  const { root, container } = await mountProviderModels(["gpt-5.5"], undefined, openAiItem);
+  await act(async () => { await Promise.resolve(); });
+
+  await act(async () => {
+    container.querySelector<HTMLButtonElement>('button[aria-label="Hide"]')!.click();
+    await Promise.resolve();
+  });
+
+  expect(requests).toEqual([{
+    scope: "models",
+    provider: "openai",
+    targets: [{ id: "gpt-5.5", native: true }],
+    enabled: false,
+  }]);
+
+  await act(async () => { root.unmount(); });
+});
+
+test("disabled discovered models stay out of the provider model list", async () => {
+  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
+  const { root, container } = await mountProviderModels(
+    ["claude-opus-5", "claude-sonnet-5"],
+    undefined,
+    item,
+    true,
+    ["claude-sonnet-5"],
+  );
+  await act(async () => { await Promise.resolve(); });
+
+  expect([...container.querySelectorAll(".pws-model-id")].map(node => node.textContent))
+    .toEqual(["claude-opus-5"]);
+
+  await act(async () => { root.unmount(); });
+});
+
 // A single transient GET used to leave `customModelsReady` false forever: the effect had no
 // remaining trigger, so Add stayed disabled until the whole panel remounted. Drive the full
 // recovery in one mount: failed load -> retry -> successful load -> Add enabled -> exactly one POST.
diff --git a/src/codex/catalog/provider-fetch.ts b/src/codex/catalog/provider-fetch.ts
index f810bfb422..55b90cfea4 100644
--- a/src/codex/catalog/provider-fetch.ts
+++ b/src/codex/catalog/provider-fetch.ts
@@ -1506,11 +1506,14 @@ async function fetchProviderModelsWithAuth(
     && prov.googleMode === "vertex"
     && (prov.models?.length ?? 0) === 0
     && Boolean(prov.defaultModel);
-  // Ordered dedupe union: Vertex seed, then `models`, then `retainModels`. `configured` is the
+  const seedStaticDefault = prov.liveModels === false
+    && (prov.models?.length ?? 0) === 0
+    && Boolean(prov.defaultModel);
+  // Ordered dedupe union: implicit default seed, then `models`, then `retainModels`. `configured` is the
   // single seed for the static path, the degraded fallback, drop diagnostics, and provider hints,
   // so a retain-only id must enter here or it never exists to be retained (#1690).
   const configuredIds = [...new Set([
-    ...(seedVertexDefault && prov.defaultModel ? [prov.defaultModel] : []),
+    ...((seedVertexDefault || seedStaticDefault) && prov.defaultModel ? [prov.defaultModel] : []),
     ...(prov.models ?? []),
     ...(prov.retainModels ?? []),
   ])];
@@ -1563,9 +1566,8 @@ async function fetchProviderModelsWithAuth(
     : resolveAuth.resolve(name, prov));
   const apiKey = auth.apiKey;
   // A configured default is a real callable selector and must remain discoverable when a
-  // compatible provider's live /models request fails (issue #308). Keep this separate from the
-  // explicit static list: `liveModels: false` + empty `models[]` intentionally publishes zero
-  // rows, while a failed live discovery may degrade to the default selector.
+  // compatible provider's live /models request fails (issue #308). Static providers already seed
+  // their default selector above when no explicit model list exists.
   const failedDiscoveryConfigured = configured.length > 0 || !prov.defaultModel || prov.adapter !== "anthropic"
     ? configured
     : [{
diff --git a/src/server/management/model-routes.ts b/src/server/management/model-routes.ts
index e9ea26a90e..fd3f1eb43c 100644
--- a/src/server/management/model-routes.ts
+++ b/src/server/management/model-routes.ts
@@ -787,7 +787,14 @@ export async function handleModelRoutes(ctx: ManagementContext): Promise<Respons
   if (url.pathname === "/api/selected-models" && req.method === "GET") {
     const models = await fetchAllModels(config);
     const available: Record<string, string[]> = {};
-    for (const m of models) (available[m.provider] ??= []).push(m.id);
+    const disabled: Record<string, string[]> = {};
+    const disabledSlugs = config.disabledModels ?? [];
+    for (const m of models) {
+      (available[m.provider] ??= []).push(m.id);
+      if (disabledSlugs.some(slug => slugEquals(slug, m.provider, m.id))) {
+        (disabled[m.provider] ??= []).push(m.id);
+      }
+    }
     const selected: Record<string, string[]> = {};
     // Live-catalog provenance. The GUI cannot infer this by subtracting known custom ids: an id
     // that is both custom and discovered would make a real live catalog look custom-only.
@@ -797,7 +804,7 @@ export async function handleModelRoutes(ctx: ManagementContext): Promise<Respons
       const liveCount = getProviderLiveModelCount(name);
       if (liveCount !== undefined) liveModelCounts[name] = liveCount;
     }
-    return jsonResponse({ selected, available, liveModelCounts });
+    return jsonResponse({ selected, available, disabled, liveModelCounts });
   }
   if (url.pathname === "/api/model-presets" && req.method === "GET") {
     // Preview without applying: rules evaluated against the CURRENT catalog, so the count the
diff --git a/tests/codex-integration/codex-catalog.test.ts b/tests/codex-integration/codex-catalog.test.ts
index 37d8c69798..4effc2ed8a 100644
--- a/tests/codex-integration/codex-catalog.test.ts
+++ b/tests/codex-integration/codex-catalog.test.ts
@@ -599,6 +599,18 @@ describe("combo catalog capability intersection", () => {
       .toEqual([]);
   });
 
+  test("filters dashboard-hidden provider models before catalog sync", () => {
+    const models = [
+      { provider: "vendor", id: "visible-model" },
+      { provider: "vendor", id: "hidden-model" },
+    ];
+
+    expect(filterCatalogVisibleModels(models, {
+      disabledModels: ["vendor/hidden-model"],
+      providers: { vendor: {} },
+    })).toEqual([{ provider: "vendor", id: "visible-model" }]);
+  });
+
   test("repairs a provider row after its shadowing combo alias is disabled", () => {
     const alias = "vendor/deepseek-v4-flash";
     const combo = deriveComboCatalogModel(
@@ -4061,6 +4073,36 @@ describe("Codex catalog routed normalization", () => {
     }
   });
 
+  test("liveModels false uses the default model when no static list is configured", async () => {
+    const originalFetch = globalThis.fetch;
+    let fetchCalls = 0;
+    globalThis.fetch = (() => {
+      fetchCalls += 1;
+      throw new Error("fetch should not be called");
+    }) as typeof fetch;
+    try {
+      const models = await gatherRoutedModels({
+        providers: {
+          "static-default": {
+            baseUrl: "https://example.invalid/v1",
+            adapter: "openai-chat",
+            authMode: "key",
+            liveModels: false,
+            defaultModel: "only-model",
+          },
+        },
+      });
+
+      expect(fetchCalls).toBe(0);
+      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
+        "static-default/only-model",
+      ]);
+    } finally {
+      globalThis.fetch = originalFetch;
+      clearModelCache("static-default");
+    }
+  });
+
   test("Google Antigravity honors an explicit static catalog and suppresses stale discovery", async () => {
     const providerName = "google-antigravity";
     const provider = structuredClone(OAUTH_PROVIDERS[providerName].providerConfig);
diff --git a/tests/server/model-discovery-management-api.test.ts b/tests/server/model-discovery-management-api.test.ts
index ad132847bb..6d44c2f9ea 100644
--- a/tests/server/model-discovery-management-api.test.ts
+++ b/tests/server/model-discovery-management-api.test.ts
@@ -39,4 +39,12 @@ describe("model discovery management API", () => {
     expect(live.modelDiscovery.recentArrivals?.vendor).toEqual([]);
     expect(live.disabledModels).toEqual(["vendor/new"]);
   });
+
+  test("selected-models reports disabled discovered model ids by provider", async () => {
+    const live = config();
+    live.disabledModels = ["vendor/known", "other/ignored"];
+    const result = await call(live, "/api/selected-models");
+    expect(result.json.available).toEqual({ vendor: ["known"] });
+    expect(result.json.disabled).toEqual({ vendor: ["known"] });
+  });
 });

````

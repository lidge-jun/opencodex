# S21 L1/4 — Release notes part a

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**. Mode: bounded docs-only delegation; C3 structural planning with C4-level release-surface review care for eventual execution. Parent owns orchestration, goal, and loop state. No orchestration commands here.

Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated below. Stop after the specified layer has independently met those gates and has exact-head PR evidence; stop this drafting task after its assigned document is complete. Escalate behavior/signature changes, extra file owners, failed baseline, cycles, any leaf above 400, or literal diff-budget overruns. Never merge.

Structural decision: split the 1,233-line mixed concern while retaining the existing executable/public path. Reject deletion/configuration (cannot preserve the API and reduce this source), and reject moving callers to leaves (needless churn). Existing owners searched with `rg --files scripts`, exact symbol searches, and import scans: `scripts/test-layout/{schema,plan,move}.ts` demonstrates same-directory feature folders; `scripts/build-release-changelog.ts` consumes these helpers rather than owning an interchangeable implementation. Use `scripts/release-notes/*.ts`, no convenience `index.ts`. Boundary exception to generic barrel-only guidance is explicit: the user requires compatibility re-exports in the executable file.

Current edges: builder/bump/tests → release-notes; release-notes has no imports. Intended edges: existing consumers → same facade → concern leaves → format constants (and render → generated/commits). Blast radius: scripts feature/public helper surface, no runtime proxy modules.

Goal: extract low-consumer carry, commit, polish, and formatting-constant leaves; keep parser/tag/renderer code for B.
Non-goals: no release changes, no API additions on the original path, no CLI redesign, no output/category/credit/transport changes, no cleanup of existing long functions.

Budget escalation: 002 says “≤500 changed source lines.” A moves 471 and B moves 439 distinct original lines, but Git addition+deletion numstat is at least 942 and 878 respectively before binding changes. Two literal ≤500-numstat layers cannot remove the ≥833 lines necessary to reach 400 (even zero overhead needs ≥1,666 changed lines). Parent must explicitly approve the pure-move size exception or expand/replan S21 before implementation. This document does not silently reinterpret that limit or authorize extra branches.

## Symbol inventory

Basis: docs HEAD `4cc219549`; code `origin/dev = 1362b1a38`. A fresh `git diff origin/dev -- scripts/release-notes.ts scripts/test.ts scripts/disposable-host/codex-service-composed-acceptance.ts` was empty, so working-tree line anchors below are origin/dev anchors. Lane 016's `scripts/release-notes.ts` record supplies the audited seam; source is independently read.

Range method: `sg run --lang ts --kind 'function_declaration,lexical_declaration,type_alias_declaration,interface_declaration,class_declaration' --json=compact scripts/release-notes.ts`, filtered against column-zero declarations/`export` lines with `rg`; inclusive declaration spans, excluding preceding comments. Consumer count = distinct **external direct importer files** returned by `rg -l` for the public path, then `rg -w` for the identifier in their named import blocks; private symbols have 0 external consumers (not 0 internal calls). CLI references and same-named local declarations are excluded. There are 52 declarations, no import declarations. The top-level `if (import.meta.main)` statement at 1231–1233 stays original in both parts.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ParsedReleaseTag` | type | 19–25 | no | 0 | `release-notes/tags.ts` (L2, retain here now) |
| `parseReleaseTag` | function | 27–36 | no | 0 | `release-notes/tags.ts` (L2, retain here now) |
| `comparePrereleaseIds` | function | 39–60 | no | 0 | `release-notes/tags.ts` (L2, retain here now) |
| `compareReleaseTags` | function | 66–79 | yes | 3 | `release-notes/tags.ts` (L2, retain here now) |
| `sortVersionTagsAscending` | function | 81–83 | no | 0 | `release-notes/tags.ts` (L2, retain here now) |
| `matchingPreviewTag` | function | 86–89 | yes | 1 | `release-notes/tags.ts` (L2, retain here now) |
| `matchingPreviewTags` | function | 96–103 | yes | 1 | `release-notes/tags.ts` (L2, retain here now) |
| `previousReleaseNotesTag` | function | 122–133 | yes | 1 | `release-notes/tags.ts` (L2, retain here now) |
| `stripCarriedReleaseNotes` | function | 136–159 | yes | 1 | `release-notes/carried.ts` (this layer) |
| `isEmptyGeneratedNotes` | function | 162–170 | yes | 0 | `release-notes/carried.ts` (this layer) |
| `hasMeaningfulCarriedNotes` | function | 177–179 | yes | 1 | `release-notes/carried.ts` (this layer) |
| `ReleaseNoteCommit` | type | 185–189 | yes | 0 | `release-notes/commits.ts` (this layer) |
| `RENDER_CATEGORY_ORDER` | const | 192–192 | no | 0 | `release-notes/format-constants.ts` (this layer) |
| `COMMIT_TYPE_CATEGORY` | const | 195–206 | no | 0 | `release-notes/commits.ts` (this layer) |
| `isReleasePlumbingCommit` | function | 213–220 | yes | 1 | `release-notes/commits.ts` (this layer) |
| `sanitizeCommitText` | function | 228–239 | yes | 2 | `release-notes/commits.ts` (this layer) |
| `renderCommitFallbackNotes` | function | 258–293 | yes | 1 | `release-notes/commits.ts` (this layer) |
| `extractCommitBulletSections` | function | 305–332 | yes | 1 | `release-notes/commits.ts` (this layer) |
| `mergeCommitBulletSections` | function | 339–373 | yes | 1 | `release-notes/commits.ts` (this layer) |
| `parseCommitLog` | function | 383–396 | yes | 1 | `release-notes/commits.ts` (this layer) |
| `hasNonWhitespace` | function | 398–400 | yes | 0 | `release-notes/carried.ts` (this layer) |
| `joinCarriedPreviewNotes` | function | 403–409 | yes | 1 | `release-notes/carried.ts` (this layer) |
| `selectNewestCarriedPreviewTag` | function | 417–427 | yes | 1 | `release-notes/carried.ts` (this layer) |
| `parseTakeoverSourcePr` | function | 434–440 | yes | 1 | `release-notes/takeovers.ts` (L2, retain here now) |
| `GENERATE_NOTES_PR_LINE` | const | 442–443 | no | 0 | `release-notes/takeovers.ts` (L2, retain here now) |
| `TakeoverCreditLookup` | type | 445–449 | yes | 0 | `release-notes/takeovers.ts` (L2, retain here now) |
| `rewriteTakeoverCredits` | function | 461–506 | yes | 2 | `release-notes/takeovers.ts` (L2, retain here now) |
| `ReleaseNotePr` | type | 508–512 | yes | 0 | `release-notes/generated.ts` (L2, retain here now) |
| `ReleaseNoteCategory` | type | 514–517 | yes | 0 | `release-notes/generated.ts` (L2, retain here now) |
| `GENERATED_PR_LINE` | const | 529–530 | no | 0 | `release-notes/generated.ts` (L2, retain here now) |
| `GENERATED_BULLET_LINE` | const | 531–532 | no | 0 | `release-notes/generated.ts` (L2, retain here now) |
| `CHANGELOG_PR_LINE` | const | 533–534 | no | 0 | `release-notes/generated.ts` (L2, retain here now) |
| `SCAFFOLD_HEADINGS` | const | 535–535 | no | 0 | `release-notes/format-constants.ts` (this layer) |
| `parseGeneratedNotes` | function | 537–591 | yes | 2 | `release-notes/generated.ts` (L2, retain here now) |
| `CONVENTIONAL_COMMIT_PREFIX` | const | 598–599 | no | 0 | `release-notes/render.ts` (L2, retain here now) |
| `cleanPrTitle` | function | 601–621 | yes | 2 | `release-notes/render.ts` (L2, retain here now) |
| `scopeLabel` | function | 624–629 | yes | 0 | `release-notes/render.ts` (L2, retain here now) |
| `groupPrsByScope` | function | 632–644 | yes | 0 | `release-notes/render.ts` (L2, retain here now) |
| `renderReleaseNotes` | function | 654–751 | yes | 1 | `release-notes/render.ts` (L2, retain here now) |
| `extractPrNumbers` | function | 754–760 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `extractChangelogPrNumbers` | function | 767–774 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `countPrNumbers` | function | 777–784 | no | 0 | `release-notes/polish.ts` (this layer) |
| `parseSectionHeadings` | function | 787–793 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `validatePolishedSections` | function | 802–827 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `POLISH_SYSTEM_PROMPT` | const | 829–838 | no | 0 | `release-notes/polish.ts` (this layer) |
| `POLISH_REQUEST_TIMEOUT_MS` | const | 840–840 | no | 0 | `release-notes/polish.ts` (this layer) |
| `callChatCompletion` | function | 842–883 | no | 0 | `release-notes/polish.ts` (this layer) |
| `splitPolishInput` | function | 890–905 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `isPolishBaseUrlAllowed` | function | 912–927 | yes | 1 | `release-notes/polish.ts` (this layer) |
| `readStdinOrFile` | function | 929–934 | no | 0 | original |
| `parseFlagArgs` | function | 936–958 | no | 0 | original |
| `main` | function | 960–1229 | no | 0 | original |

## Leaf partition

Move these origin/dev ranges including their comments/spacing: 135–180 and 398–428 → carried (77 lines); 181–397 except 192 → commits (216); 192 and 535 → format-constants (2); 753–928 → polish (176). Total original lines moved = **471**. Export keywords may be added to existing private cross-leaf bindings, but bodies/signatures remain unchanged.

| New leaf | Symbols | Expected lines including imports | Own imports |
|---|---|---:|---|
| `scripts/release-notes/format-constants.ts` | `RENDER_CATEGORY_ORDER`, `SCAFFOLD_HEADINGS` | 4 | none |
| `scripts/release-notes/carried.ts` | `stripCarriedReleaseNotes`, `isEmptyGeneratedNotes`, `hasMeaningfulCarriedNotes`, `hasNonWhitespace`, `joinCarriedPreviewNotes`, `selectNewestCarriedPreviewTag` | 77 | none |
| `scripts/release-notes/commits.ts` | `ReleaseNoteCommit`, `COMMIT_TYPE_CATEGORY`, `isReleasePlumbingCommit`, `sanitizeCommitText`, `renderCommitFallbackNotes`, `extractCommitBulletSections`, `mergeCommitBulletSections`, `parseCommitLog` | 219 | `import { RENDER_CATEGORY_ORDER, SCAFFOLD_HEADINGS } from "./format-constants";` |
| `scripts/release-notes/polish.ts` | `extractPrNumbers`, `extractChangelogPrNumbers`, `countPrNumbers`, `parseSectionHeadings`, `validatePolishedSections`, `POLISH_SYSTEM_PROMPT`, `POLISH_REQUEST_TIMEOUT_MS`, `callChatCompletion`, `splitPolishInput`, `isPolishBaseUrlAllowed` | 176 | none; existing Bun/fetch/Response/URL globals |

Residual expectation: **780** lines = 1,233 − 471 + 18 import/re-export/spacing budget. This is intentionally above 400: **730 / S21 L2 (#b)** moves the remaining 439 original lines, leaving **349** (= 780 − 439 + 8 net binding/spacing budget). Counts are explicit physical-line budgets, not a claim to have generated code; implementation must record actual `wc -l`.

Ordering evidence: format constants have 0 external consumers, carried/polish each have 1 consumer-file union, commits has 2 (the builder uses `sanitizeCommitText`). Remaining takeovers/generated/render have 2; tags has 4 at the module-group level and `compareReleaseTags` has 3. Thus A takes the smallest closed dependency sets first; same-fan-in ties keep the parser/renderer together in B. Private zero-consumer helpers move with their callers, not as pointless individual files.

## Re-export block

Add the following compatibility exports; all not-yet-moved exported declarations remain exactly where they are.

```ts
export { stripCarriedReleaseNotes, isEmptyGeneratedNotes, hasMeaningfulCarriedNotes, hasNonWhitespace, joinCarriedPreviewNotes, selectNewestCarriedPreviewTag } from "./release-notes/carried";
export type { ReleaseNoteCommit } from "./release-notes/commits";
export { isReleasePlumbingCommit, sanitizeCommitText, renderCommitFallbackNotes, extractCommitBulletSections, mergeCommitBulletSections, parseCommitLog } from "./release-notes/commits";
export { extractPrNumbers, extractChangelogPrNumbers, parseSectionHeadings, validatePolishedSections, splitPolishInput, isPolishBaseUrlAllowed } from "./release-notes/polish";
```

Explicit residual local imports (re-exports create no local bindings):

```ts
import { RENDER_CATEGORY_ORDER, SCAFFOLD_HEADINGS } from "./release-notes/format-constants";
import { stripCarriedReleaseNotes, hasMeaningfulCarriedNotes, joinCarriedPreviewNotes } from "./release-notes/carried";
import { renderCommitFallbackNotes, parseCommitLog, extractCommitBulletSections, mergeCommitBulletSections } from "./release-notes/commits";
import { extractPrNumbers, extractChangelogPrNumbers, parseSectionHeadings, validatePolishedSections, splitPolishInput, isPolishBaseUrlAllowed, callChatCompletion } from "./release-notes/polish";
```

The remaining original parser/render/type declarations are local; do not import them from the facade itself.
`callChatCompletion` is a new internal leaf export used by the unchanged CLI, **not** a new compatibility export.

## Module-level state and cycles

`SCAFFOLD_HEADINGS` at origin `scripts/release-notes.ts:535` is the sole top-level Set; owner `scripts/release-notes/format-constants.ts` from L1 onward. `RENDER_CATEGORY_ORDER` (:192) is a read-only-by-convention array, same owner. `COMMIT_TYPE_CATEGORY` (:195–206) belongs only to commits. Regex constants belong to takeovers (:442), generated (:529–534), and render (:598); prompt and timeout constants (:829, :840) belong only to polish. No module-level let, Map, WeakMap, timer, or lock. Function-local Maps/Sets stay per-call, including renderer categories and polish counts; do not hoist them.

The takeovers/generated/render owners above are the final L2 destinations; their declarations remain original during L1. Avoid commits → facade → commits through `SCAFFOLD_HEADINGS`, and (in L2) render → facade → render through `parseGeneratedNotes`: leaves import their dependencies directly, never the original file. Types `ReleaseNotePr`/`ReleaseNoteCategory` remain original in L1 and move to generated in L2; render then imports the type from that leaf, not from the facade. There is no runtime or type-only return edge. Coupling is functional/sequential; immutable-by-convention formatting data is not duplicated. Lazy dynamic imports are not introduced. The CLI `import.meta.main` guard remains on the executable path, with no top-level I/O added to leaves.

## Tests

Exact public-path importer search, `rg -l 'from ".*/release-notes"' src gui/src scripts tests`, returns four files: `scripts/build-release-changelog.ts:20`, `scripts/bump-dev-version.ts:57`, and these two test files:

- `tests/ci-workflows/release-notes.test.ts:27` — unchanged public import and assertions.
- `tests/ci-workflows/release-version-line.test.ts:3` — unchanged public import and assertions.

No test reads `scripts/release-notes.ts` as source. The broad basename-plus-reader intersection also finds `tests/ci-workflows/release-version-line.test.ts` and `tests/ci-workflows/ci-workflows.test.ts`, but those read package/release/workflow inputs, not this implementation. In particular `ci-workflows.test.ts:868` checks a workflow command string. Disposition: unchanged, no retarget-to-leaf and no add-leaf-to-scan-list for existing text oracles. Do not turn the stale-check estimate into a fictitious source reader.

Indirect consumer regression: `tests/ci-workflows/build-release-changelog.test.ts` remains unchanged and must run explicitly because the release builder imports five helpers. Preserve CLI dispatch and `import.meta.main` at origin `scripts/release-notes.ts:1231`; never import `scripts/release.ts` in its place.

Future implementation guards: add named-export equivalence and leaf-no-facade-import assertions to the existing `tests/ci-workflows/release-notes.test.ts` (no new test file/layout mapping). Add each new leaf path to that new scan's explicit list. Drive it red once by removing one compatibility re-export, restore it, then inject one leaf-to-facade import and restore it. Do this only in the future isolated implementation worktree; this docs task ran no guards.

Behavioral guards to drive red: the existing polish missing/repeated-PR assertions at release-notes.test.ts:805 and :830 by temporarily bypassing the matching check in polish; restore unchanged logic.

## Verification

These are future implementation commands, not checks run by this docs-only delegation. Instantiate `002_layer_map.md` → **Per-layer gate** at this layer's exact tip:

```sh
bun run typecheck
bun test tests/ci-workflows/release-notes.test.ts tests/ci-workflows/release-version-line.test.ts tests/ci-workflows/build-release-changelog.test.ts tests/ci-workflows/ci-workflows.test.ts
bun run privacy:scan
wc -l scripts/release-notes/format-constants.ts scripts/release-notes/carried.ts scripts/release-notes/commits.ts scripts/release-notes/polish.ts scripts/release-notes.ts
rg -l 'from ".*/release-notes"' src gui/src scripts tests
git diff --numstat dev...HEAD -- scripts
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-release-notes-a && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

The importer result must remain the same four paths, not just a same-sized replacement set. Inspect named imports separately: the builder defines its own `renderReleaseNotes`; it does not import that identifier. Run explicit-import DFS (including type/re-export edges) over the new leaf paths and facade; zero return paths. No `src/server`, `src/router`, or `src/lib` changes, so the conditional core-Lab test is not activated and its protected roots stay untouched.

Require full remote command exit status and complete retained log, not only the tail: the example pipeline in 002 can hide Bun's failure; use a pipefail-capable remote shell or capture the test status before printing its tail. Verify remote checkout SHA equals this layer's tip. `scripts/AGENTS.md` additionally requires `bun run prepush`; it includes a full suite (`package.json:55`) and therefore must also run on the authorized remote, never locally. No release/publish/network polish operation is a verifier. Obtain explicit release-tooling security review under MAINTAINERS.md:59–71 before review-ready; it is not a permission to publish.

## Accept criteria

1. Every one of the 52 origin declarations has exactly one owner in the inventory; moved bodies/comments match the origin ranges except imports/export markers.
2. Every original value/type export remains importable through `scripts/release-notes.ts`; no leaf imports that facade, even type-only.
3. Four new leaves meet ≤400; the measured residual is recorded against the 780 budget and explicitly assigned to 730 (#b).
4. All public importer paths stay unchanged; focused tests, remote full suite/prepush, typecheck, privacy scan, and negative guard receipts are recorded at the exact head.
5. No command dispatch, ordering, credit, PR-reference validation, exit status, network policy, or release behavior changes; no release is executed.
6. Parent resolves the literal diff-size contradiction before execution; stack bases and required reviews/CI match this layer, with no merge.

## PR

Title: `refactor(scripts): extract carry commit and polish leaves (split S21 L1/4)`
Branch: `codex/split-release-notes-a`.
Base: `dev`.
Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Review only this layer's diff; this is the bottom layer. Stack navigation (only L2 depends on L1; merges require separate authorization):

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S21-L4 | `codex/split-disposable-host-codex-service-composed-acceptance` | `dev` | Fixture owner; sentinel order |
| 3 | #TBD-S21-L3 | `codex/split-test` | `dev` | Environment and selection leaves |
| 2 | #TBD-S21-L2 | `codex/split-release-notes-b` | `codex/split-release-notes-a` | Tags, attribution, PR rendering |
| 1 | #TBD-S21-L1 | `codex/split-release-notes-a` | `dev` | Carry, commit fallback, polish |

Base: dev — no dependency on lower layers; this layer is the parent of 730 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02). No such Git action is part of this docs-only delegation.

# S01 L1/3 — Redaction lexical folding

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Class: C3 boundary planning, docs-only here; the implementation preserves the security-sensitive redaction algorithm verbatim.
- Goal: reduce src/lib/redact.ts from 526 to 353 lines by moving the complete lexical folding owner into src/lib/redact-folding.ts (176 lines).
- Non-goals: no new redaction grammar, normalization, validation, dependencies, public exports, caller migration, or function-body cleanup. Existing long functions are an explicit pure-move exception to the 50-line guideline.
- Verifier: 002_layer_map.md, "Per-layer gate", instantiated in Verification below. No tests were run while drafting this document.
- Stop: one independently verified layer, original import surface intact, exact-head CI green and PR evidence recorded by the parent executor. Never merge.
- Escalation: source drift, any byte/output change, an unlisted oracle, a new cycle, changed source diff over 500 lines, or any required write beyond this layer. Security findings go to ignored scratch, not this public plan.

Basis: docs HEAD 4cc219549; source origin/dev 1362b1a38. The working-tree source has no diff against origin/dev. 000 and 001 record older tips; these ranges use the refreshed source tip. Lane evidence: 016_lane_cli_storage_usage_update_lab_scripts.md:418–431 in the modular-debt-ledger unit.

Structural map before choosing the split: 56 direct importing files across src, gui/src, scripts, tests; examples src/config.ts:62 and src/lib/debug.ts:3. Current module has no imports. Both maskOtherFramingsOnce (src/lib/redact.ts:213) and maskCredentialHeadersOnce (:364) call foldForMatching. Intended direction: unchanged consumers → redact.ts → redact-folding.ts; the leaf imports nothing. Only the existing redaction entry boundary changes internally; blast radius is the lib module and its preserved consumers.

Decision: extract folding and its lookup tables together. Doing nothing leaves 526 lines; deletion/configuration cannot preserve the algorithm; moving frame matchers too adds churn without being needed for the limit. Reusing another owner was rejected after rg for foldForMatching in src/lib found only this definition/call sites. Adjacent convention: domain-named sibling leaves src/lib/debug-settings.ts, src/lib/debug-log-buffer.ts and src/lib/bounded-body.ts, plus src/config/provider-validation.ts. No new index/barrel is introduced. The original implementation keeps all public functions rather than becoming an internal convenience barrel.

## Symbol inventory

All ranges are inclusive origin/dev:src/lib/redact.ts declaration ranges, obtained from rg top-level declaration/closing-line output and line-numbered source inspection. Attached comments are accounted for separately in the move ranges below. Consumer counts mean distinct external importing files containing the exact symbol (rg -l -w); importer candidates come from rg -l redact src gui/src scripts tests, followed by relative-path resolution of static imports, dynamic imports and mocks. Counts are lexical file references, not call counts; private symbols have zero external consumers. Imports are absent. R = residual src/lib/redact.ts; F = src/lib/redact-folding.ts.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| REDACTED_SECRET | const string | 1–1 | yes | 1 | R |
| SENSITIVE_KEY_PATTERN | const RegExp | 8–8 | yes | 1 | R |
| CREDENTIAL_HEADER_LABEL_RAW | const string | 41–41 | no | 0 | R |
| CREDENTIAL_HEADER_LABEL | const string | 43–44 | no | 0 | R |
| COLON_CONFUSABLES | const Set | 50–53 | no | 0 | F |
| INVISIBLE_FORMAT | const RegExp | 63–63 | no | 0 | F |
| NAMED_ENTITY_PLACEHOLDER | const string | 80–80 | no | 0 | F |
| SEPARATOR_ENTITIES | const Map | 87–92 | no | 0 | F |
| LETTER_CONFUSABLES | const Map | 101–115 | no | 0 | F |
| COLON_LABELLED_CREDENTIAL | const RegExp | 128–131 | no | 0 | R |
| OTHER_FRAMED_CREDENTIALS | const tuple array | 141–193 | no | 0 | R |
| maskOtherFramings | function | 204–208 | no | 0 | R |
| maskOtherFramingsOnce | function | 210–241 | no | 0 | R |
| foldForMatching | function | 248–347 | no; leaf-only export after move | 0 | F |
| maskCredentialHeaders | function | 358–361 | no | 0 | R |
| maskCredentialHeadersOnce | function | 363–410 | no | 0 | R |
| SECRET_VALUE_PATTERNS | const tuple array | 412–429 | no | 0 | R |
| HeaderRecord | type | 431–431 | no | 0 | R |
| isPlainObject | function | 433–437 | no | 0 | R |
| isSensitiveKey | function | 439–441 | no | 0 | R |
| redactSecretString | function | 443–449 | yes | 48 | R |
| sanitizeLogMetadataString | function | 452–460 | yes | 7 | R |
| redactSecrets | function | 462–473 | yes | 4 | R |
| redactHeaders | function | 475–487 | yes | 1 | R |
| redactUrlForLog | function | 489–500 | yes | 3 | R |
| USER_HOME_PATH_PATTERNS | const tuple array | 502–507 | no | 0 | R |
| SENSITIVE_SEGMENT_PATTERN | const RegExp | 511–511 | no | 0 | R |
| redactUserPath | function | 519–526 | yes | 5 | R |

## Leaf partition

One new sibling: src/lib/redact-folding.ts.

- Symbols: COLON_CONFUSABLES, INVISIBLE_FORMAT, NAMED_ENTITY_PLACEHOLDER, SEPARATOR_ENTITIES, LETTER_CONFUSABLES, foldForMatching. Only foldForMatching becomes a leaf export, for the production calls in the residual; do not re-export it from the original path.
- Own imports: none; TextEncoder and other standard globals remain globals.
- Exact source chunks including their comments: src/lib/redact.ts:46–115 (70 lines) and :243–347 (105 lines). Join with one blank line; add only the export modifier to foldForMatching. Expected 176 lines.
- Residual: retain all other bytes/declarations, prepend the one import plus one blank line shown below. Expected 526 − 175 + 2 = 353 lines. Total new layout 176 + 353 = 529 (three added layout/import lines).
- Expected source additions/deletions: 178 added and 175 deleted, 353 total before optional formatting; no formatting sweep. No #b part is needed. Lowest-churn extraction has zero existing external symbol consumers; all public consumer paths remain stable.

## Re-export block

Exact added re-export block: empty. No currently exported symbol moves, so no export-from or export-type-from statement is required. Keep the eight current exports as their original declarations: REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecretString, sanitizeLogMetadataString, redactSecrets, redactHeaders, redactUrlForLog, redactUserPath. Adding foldForMatching to that surface would violate this plan.

Exact local import to prepend (followed by one blank line):

    import { foldForMatching } from "./redact-folding";

Re-exporting a helper would not bind it locally. The two residual call sites require this import even if a future layer chooses to re-export it.

## Module-level state and cycles

- One owner each, all private to F: COLON_CONFUSABLES Set (:50), SEPARATOR_ENTITIES Map (:87), LETTER_CONFUSABLES Map (:101). They are initialized once and only read; do not duplicate/export the tables or turn them into per-call factories. INVISIBLE_FORMAT (:63) and NAMED_ENTITY_PLACEHOLDER (:80) move with them.
- Residual state stays together: CREDENTIAL_HEADER_LABEL_RAW (:41), derived CREDENTIAL_HEADER_LABEL (:43), SENSITIVE_KEY_PATTERN (:8), COLON_LABELLED_CREDENTIAL (:128), OTHER_FRAMED_CREDENTIALS (:141), SECRET_VALUE_PATTERNS (:412), USER_HOME_PATH_PATTERNS (:502), SENSITIVE_SEGMENT_PATTERN (:511), REDACTED_SECRET (:1). Global regex lastIndex writes in the masking loops remain with those regex owners; preserve resets at :215 and :365 and the sequential matching order.
- No top-level let, WeakMap, timer, lock or asynchronous initialization. foldForMatching's map, decoder and offsets are invocation-local, not module state.
- Intended graph is acyclic by construction: leaf has zero imports. In particular never import REDACTED_SECRET from the facade into F: the fold does not need it. The two callers retain matching/masking and byte-offset consumption; coupling is functional and sequential, not a shared mutable table API.
- The lab-boundary walker follows the added static edge automatically; no edits to its PROTECTED roots or scan list.

## Tests

Complete direct importing-test rg -l list (including dynamic import), each unchanged:

| test file | import line | disposition |
|---|---:|---|
| tests/lib/redact.test.ts | 8 | unchanged, original path |
| tests/routing/fastwire-observability.test.ts | 6 | unchanged, original path |
| tests/web-search/web-search-backend-union.test.ts | 6 | unchanged, original path |
| tests/providers/github-copilot/github-copilot-oauth.test.ts | 339 | unchanged, dynamic original path |

Discovery: rg -l 'src/lib/redact|lib/redact\.ts|redact\.ts' tests; inspect results for from/import/readFileSync/Bun.file/source. No direct filename-pinned source oracle exists. Transitive source oracle tests/lab/core-lab-boundary.test.ts reads every reachable module with readFileSync at :69, including this file; unchanged, automatically includes src/lib/redact-folding.ts through the new edge. Its direct-root reads at :278/:336 do not pin redact.ts. No retarget-to-leaf or add-leaf-to-scan-list edit is required.

Guards to drive red once during implementation C, then restore and prove green: temporarily replace the leaf's COLON_CONFUSABLES with an empty Set and run tests/lib/redact.test.ts (the colon-confusable guard at :128 must fail). Temporarily introduce a static side-effect import of ../lab/paths into the new sibling leaf, run tests/lab/core-lab-boundary.test.ts (transitive guard :284 must fail), then remove it; never change the PROTECTED list. These are planned controlled mutations, not actions performed in this documentation task. Preserve existing byte/escape checks at redact.test.ts:143, :178, :360, :378 and :401.

## Verification

Future implementation only, at this layer tip in its dedicated worktree; local full suite is prohibited. Instantiate 002 as follows:

    bun run typecheck
    bun test tests/lib/redact.test.ts tests/routing/fastwire-observability.test.ts tests/web-search/web-search-backend-union.test.ts tests/providers/github-copilot/github-copilot-oauth.test.ts
    bun test tests/lib/debug.test.ts
    bun run privacy:scan
    bun test tests/lab/core-lab-boundary.test.ts
    wc -l src/lib/redact.ts src/lib/redact-folding.ts
    rg -n 'from "[^"]*/redact"' src gui/src scripts tests | wc -l
    git diff --check
    git diff --numstat dev...HEAD -- src/lib/redact.ts src/lib/redact-folding.ts

Focused domains: lib, routing, web-search, providers/github-copilot; lab boundary is mandatory. Recorded static-from baseline for the command above: 55 matching lines. Recheck before/after and separately re-run the resolved importer census (56 files including dynamic imports); both must be unchanged. Compare the eight exports before/after and compare the moved function/table bodies with origin/dev, allowing only its export modifier. Verify the leaf has no imports with rg -n '^(import|export).*from|^import ' src/lib/redact-folding.ts (no matches expected); this proves the only new graph edge cannot return to the facade. Typecheck is not itself cycle proof.

Full suite, only on lidge, using the 002 remote checkout procedure and preserving the real test exit status (do not pipe it into tail):

    ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lib-redact && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'

Record remote SHA matching the PR head, complete test result/exit code, and exact-head GitHub CI rollup. The parent owns remote checkout coordination and all execution; this document author did not run these commands.

## Accept criteria

1. Exactly src/lib/redact-folding.ts is added; only the specified chunks move out of src/lib/redact.ts, plus the local import. No consumer/test path changes.
2. Inventory covers 28 declarations; six reside in F, 22 remain in R. All eight original exports remain at the original path; foldForMatching is not added to it.
3. Actual wc counts are at most 400 each (planned F=176, R=353); layer source churn is at most 500 changed lines. Any mismatch is reconciled before PR readiness.
4. Three lookup containers each have one owner; no import back to the facade, Lab, config, adapters or server from the leaf.
5. Focused checks, privacy scan, typecheck and lab boundary exit 0; both deliberate red drives fail for the expected assertion and return green after restoration.
6. Importer census remains 56 and moved bodies/comments are unchanged except export/import plumbing. Remote full suite and full exact-head CI rollup are green, with SHA recorded; no local full-suite run.
7. PR has the exact base and full repository template; no merge or release occurs.

## PR

Title: refactor(lib): isolate redaction lexical folding (split S01 L1/3)

Branch: codex/split-lib-redact. Base: dev. Closes: none.

Fill Summary, Verification, Checklist from .github/PULL_REQUEST_TEMPLATE.md; include this DEV-STACK-03 map, exact-tip results and pure-move thesis. Review this layer's diff only. PR numbers below are intentional pre-publication placeholders.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S01-L3 | upstream retry | codex/split-lib-upstream-retry | dev | wait/body ownership |
| 2 | #TBD-S01-L2 | errors | codex/split-lib-errors | dev | message predicates |
| 1 | #TBD-S01-L1 | redact — this layer | codex/split-lib-redact | dev | folding and offset identity |

Base: dev — no dependency on the layers below; no cascade obligation.

## P stale-check (2026-09-05, wp010)

origin/dev advanced past 445742966; `git diff --stat 445742966 origin/dev -- src/lib/redact.ts tests/lib/redact.test.ts` is empty, so every line range above is still exact. Plan audit (Ptolemy, gpt-6-astra high, 01a06edb-d0d7-7603-bb0d-96ca162c70ad) returned VERDICT: PASS with one citation nit: the first `lastIndex` reset is at redact.ts:214, not :215. Base for this layer is `dev` (S01 is an independent stack, 003 STACK-INDEPENDENCE-01). Executor rule learned at L105: never run `bun run test` or `bun scripts/test.ts` in the layer worktree; use `OCX_TEST_NO_QUEUE=1` for focused runs when another session holds the user test lock.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-010.7Jtzb1/wt` (branch `codex/split-lib-redact`, base origin/dev 4dde2db97). Executor: gpt-6-astra high (Dirac, 01a06f00-86a3-79b2-a538-dd26fe041cc5).
- Commits: 15907c6ff (move: redact-folding.ts 176 lines, redact.ts 353) and 5b253af7f (test: tests/lib/redact.test.ts +12 — folds a colon confusable with aligned offsets; leaf has no import line). Diff: 3 files, +190/−175; non-move diff = 1 import + 1 export modifier + 12 test lines.
- Local gate: typecheck 0; focused (redact, fastwire-observability, web-search-backend-union, github-copilot-oauth, debug) 118 pass / 0 fail; core-lab-boundary 17 pass / 0 fail; privacy scan passed; leaf zero imports.
- Red-drives: (a) empty COLON_CONFUSABLES → redact.test.ts 41 pass / 2 fail (colon look-alike guard + new leaf test), restored 43/0; (b) leaf importing ../lab/paths → core-lab-boundary 13 pass / 4 fail with chain `src/router.ts -> src/lib/redact.ts -> src/lib/redact-folding.ts -> src/lab/paths.ts`, restored 60/0 combined.
- Pushed: origin/codex/split-lib-redact = 5b253af7f.

- Adversarial diff review (Hubble, gpt-6-astra high, 01a06f03-583c-7490-b9e7-7a85ca8b3935): VERDICT: PASS first round (slice diffs empty, exact residual reconstruction, 8 exports preserved, foldForMatching private, test non-tautological, 3 files).
- C receipt at 5b253af7f: typecheck 0, redact+lab-boundary 60 pass / 0 fail, privacy 0, DIRTY 0.
- lidge full suite at 5b253af7f: SUITE_EXIT=0, 18014 pass / 0 fail / 16 skip (/tmp/suite-split-lib-redact.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3559 (base dev, head 5b253af7f). CI rollup at record time: OPEN draft=false 5b253af7f select windows runner:SUCCESS resolve-pr:SUCCESS resolve-pr:SUCCESS label:SUCCESS label:SUCCESS hygiene:SUCCESS hygiene:SUCCESS react-doctor:SUCCESS enforce-target: changes:SUCCESS enforce-target:SUCCESS windows ${{ matrix.shard }}/4:SKIPPED test 1/4:SUCCESS test 2/4: test 3/4: test 4/4: storage policy:SUCCESS api usage:SUCCESS gates:SUCCESS macos 1/2: macos 2/2: macos control:SKIPPED keyring ubuntu: keyring windows:SUCCESS keyring macos: npm-global ubuntu-latest:SUCCESS npm-global windows-latest: npm-global macos-latest: CodeRabbit:

# S14 L2 — CLI provider read handlers and argument parsing

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only delegation. Parent owns orchestration, loop and goal state.
- Goal: reduce `src/cli/provider.ts` below 400 by moving its read-only list/show family and shared argument parsing, leaving mutation validation/save and dispatch intact. Basis: docs `4cc219549`; code `origin/dev = 1362b1a38`, 485 lines. All source ranges below refer to that basis.
- Non-goals: no provider/auth/preset changes, no credential-mask changes, no new argument semantics, no change to save ordering, output, exit status, sync behavior or runtime fallback; no cross-command parser consolidation.
- Verifier: `002_layer_map.md` → **Per-layer gate**, instantiated below; this drafting task runs document checks only.
- Stop: executor records standalone gate evidence and green exact-head CI on an open L2 PR, without merging; this delegation stops at checked docs.
- Escalation: stale source, new oracle coupling, cycle, >400 output or >500 changed source lines requires parent direction. An actual behavior/auth change is outside pure-move scope and needs separate security review. No extra docs or code may be written by this delegated task.

Structural decision: lane 016:584–597 identifies handler-family separation behind the command/validation boundary. Current map: `src/cli/dispatch.ts:657` dynamically imports the one exported `handleProviderCommand`; it dispatches private read and mutation handlers (`provider.ts:447–485`) using config/registry dependencies at 11–20. Intended map: dispatch → retained `provider.ts` → `provider-read.ts` → `provider-args.ts`, with a direct residual → args edge; mutation handlers and `validateAndSave` stay together. Blast radius is one CLI feature. Do nothing/delete/configure cannot preserve required behavior while shrinking 485 lines. Moving all handlers would cost more churn; using the models/account parsers as an owner would introduce cross-command coupling. Concern siblings match `src/cli/provider-runtime.ts`, `models-runtime-subcommands.ts` and `status-oauth.ts`; no new directory or generic helpers module.

## Symbol inventory

Inventory: numbered `git show origin/dev:src/cli/provider.ts` plus ast-grep top-level declaration ranges. Ranges exclude leading comments. Imports are dependencies, not owned declarations. Counts are distinct external importers from `rg -l -w '<symbol>' src gui/src scripts tests`, filtered by resolved module identity. All private declarations have zero external consumers; similarly named functions in `models.ts`, `account.ts` or a UI component are unrelated declarations. The `handleProviderCommand` text in a test fixture is not an import. File fan-in: **1 production dynamic importer, 0 test importers**.

Aliases: `A` = `src/cli/provider-args.ts` (new); `D` = `src/cli/provider-read.ts` (new); `R` = `src/cli/provider.ts` (residual).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| consumeFlag | function | 26–31 | no | 0 | A |
| consumeFlagValue | function | 33–39 | no | 0 | A |
| rejectUnknownArgs | function | 42–52 | no | 0 | A |
| maskSecret | function | 54–57 | no | 0 | D |
| validateAndSave | function | 63–73 | no | 0 | R |
| handleList | function | 79–124 | no | 0 | D |
| ADD_USAGE | const string | 130–130 | no | 0 | R |
| handleAdd | async function | 132–272 | no | 0 | R |
| handleRemove | function | 278–335 | no | 0 | R |
| handleShow | function | 341–377 | no | 0 | D |
| handleSetDefault | function | 383–418 | no | 0 | R |
| PROVIDER_USAGE | const string | 424–445 | no | 0 | R |
| handleProviderCommand | async function | 447–485 | yes | 1 | R |

No #a/#b ordering applies: one layer resolves this file. Both leaves start with zero external consumers, avoiding migration churn; the sole public export remains in place.

## Leaf partition

1. **`src/cli/provider-args.ts` — expected 32 lines, ceiling 400.** Move **22–53** verbatim with comments/separators; export `consumeFlag`, `consumeFlagValue`, `rejectUnknownArgs` for their production callers. Imports: **none**. `process` and `console` remain the existing runtime globals. Preserve mutation of the passed array, missing-value behavior, diagnostics and exit(1).
2. **`src/cli/provider-read.ts` — expected 102 lines, ceiling 400.** Move **54–58, 75–125, 337–378**, i.e. 5 + 51 + 42 = **98 lines**, containing `maskSecret`, `handleList`, `handleShow`. Export only the handlers; `maskSecret` stays private. Add these three import lines and one separator:

   ```ts
   import { hasOwnProvider, loadConfig, sanitizeModelCostsForDisplay } from "../config";
   import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../providers/registry";
   import { consumeFlag, rejectUnknownArgs } from "./provider-args";
   ```

3. **Residual `src/cli/provider.ts` — expected 357 lines, ceiling 400.** Keep all R declarations and original header. Remove `sanitizeModelCostsForDisplay` from import line 11 and `PROVIDER_REGISTRY` from line 14, but retain `getProviderRegistryEntry` for `handleAdd`. All other existing imports remain used. Add the two imports below. Accounting: **485 − (32 + 98) + 2 = 357**; leaves 32 and 98 + 4 = 102. Aggregate 491 = original 485 + 6 wiring lines. No #b needed. Expected source numstat churn is about 270 lines; measure actual diff against L1.

Pre-write owner search: `rg -n 'consumeFlag|consumeFlagValue|rejectUnknownArgs|maskSecret|handleList|handleShow' src/cli` finds private argument functions at `src/cli/models.ts:145,152` and `src/cli/account.ts:68`, not a shared public owner. Keep their behavior untouched; this layer moves only the provider implementation rather than deduplicating commands. The existing config sanitizer remains the owner of display cost normalization (`provider.ts:360`).

## Re-export block

**No re-export statements are required:** the sole current export, `handleProviderCommand`, remains an exported declaration in `src/cli/provider.ts` (old 447–485). There are no current exported types and no moved current exports. Do not invent `export { handleList, handleShow }` on the original path; that would enlarge its public contract.

Exact new local imports in the residual:

```ts
import { consumeFlag, consumeFlagValue, rejectUnknownArgs } from "./provider-args";
import { handleList, handleShow } from "./provider-read";
```

The new leaves expose symbols only to real production callers, not just tests. Keeping the dispatch declaration at the old path preserves the dynamic import at `src/cli/dispatch.ts:657`. No facade wrapper, new index, wildcard, rename, or convenience barrel.

## Module-level state and cycles

No top-level `let`, Map/Set/WeakMap/WeakSet, timer or lock (lane 016:592, checked against declarations). `ADD_USAGE` at 130 and `PROVIDER_USAGE` at 424 are immutable strings; each remains owned once by R. `provConfig` at 170 and `codexSyncSkipped` at 241 are per-call locals, not singletons. A continues to mutate the caller-owned argument array exactly as before.

Potential direct cycle: D importing argument functions from R while R imports D. Avoid it with the lower, import-free A owner; neither leaf imports R. A has no runtime dependency edge; D depends only on A and the existing config/registry owners. Functional coupling replaces lexical locality. Existing mutation sequencing (`validateAndSave` at 225, 315, 409) is retained in R, with no new callback/control flag or shared mutable config owner. Lane 016:593 found no original return cycle; executor repeats method G (relative static/type import/export plus literal dynamic-import resolution) for all changed modules and requires zero return paths. The runtime-command dynamic import at 474 stays untouched; it is existing command dispatch, not a new cycle workaround.

## Tests

`rg -l 'cli/provider["\x27]' tests` returns **no files**. No behavioral test imports this module directly. Its command-level coverage is essential because import-graph selection cannot see CLI subprocess dispatch:

| test file | anchor | disposition |
|---|---|---|
| tests/cli/cli-provider.test.ts | executable path 11; spawn 19; list/show cases 64, 77, 153, 356, 375; strict args 437, 448, 459 | unchanged; execute the real CLI |
| tests/cli/cli-transport-honesty.test.ts | source read 20; provider fixture 98; exit-code checks 106, 111 | unchanged; source owner is dispatch.ts, not provider.ts |

**Oracle discrepancy resolved:** 001's broad `textoracle=1` candidate is a false positive for this file. `tests/cli/cli-transport-honesty.test.ts:20` reads `repoPath("src", "cli", "dispatch.ts")`; line 98 contains `import("./provider")` inside an artificial pre-fix source string. It does not read `provider.ts`. Its additional readers at 129, 291 and 296 read account-family/index files. Basename/qualified-path/split-segment searches find **zero direct provider.ts source readers**, agreeing with lane 016:594. No `retarget-to-leaf` or `add-leaf-to-scan-list` is needed. Do not broaden that dispatch-specific scan to the new leaves.

Guards to drive red once in the later implementation worktree: temporarily make moved `rejectUnknownArgs` accept unknown arguments and observe the existing line-437 and line-459 tests fail; restore. Temporarily remove the moved display sanitizer at old line 360 and observe line-153's secret-shaped-model-cost guard fail; restore. These mutations test already-public behavior, must never be committed, and are not executed during drafting. Existing exit-code oracle and its built-in red-first fixture remain unchanged.

## Verification

Later executor only, in the L2 worktree:

```sh
bun run typecheck
bun test tests/cli/cli-provider.test.ts tests/cli/cli-transport-honesty.test.ts
bun run privacy:scan
wc -l src/cli/provider-args.ts src/cli/provider-read.ts src/cli/provider.ts
rg -n 'import\("\./provider"\)' src/cli/dispatch.ts
rg -l 'cli/provider["\x27]' tests
rg -n '^import|^export .* from ' src/cli/provider-args.ts src/cli/provider-read.ts src/cli/provider.ts
git diff --numstat origin/dev...HEAD -- src/cli/provider.ts src/cli/provider-args.ts src/cli/provider-read.ts
```

The test-import `rg` deliberately exits 1 for zero matches; that is the expected result, not a failing verification. Domain: `tests/cli`. Parent-path importer set remains the one dynamic import; 002's static `from`-only count is insufficient for this file, so retain the dynamic check above. Require the original single-export set and method-G acyclic closure. No server/router/lib source is touched, so 002 does not require `core-lab-boundary`; its protected roots are never edited. If scope changes, escalate.

Full suite only on lidge at the published layer SHA, with remote HEAD compared to that SHA and pipeline status preserved:

```sh
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-cli-provider && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Record exits, negative-control restoration, remote full-suite result and exact-head CI rollup. No local full suite; no tests or live provider operations run in this docs delegation. Review credential-display preservation explicitly per `MAINTAINERS.md:60–61`; extraction is not permission to change masking policy.

## Accept criteria

1. All 13 top-level owned declarations are assigned once; only the named ranges move, retaining comments and function bodies.
2. New/residual sizes ≤400 (expected 32, 102, 357); parent-relative source churn ≤500 or stop for parent re-plan; no #b debt remains.
3. `handleProviderCommand` is the exact original single export, the dispatch import remains unchanged, and no public helper is added to the original path.
4. No A/D → R edge or method-G cycle; mutation validation/save remains in one original owner; no copied state or cross-command parser edits.
5. List/show output, costs/secret display, args, mutation output and exit-code assertions remain unchanged; negative controls fail once and restored focused/typecheck/privacy checks pass.
6. Exact L2 SHA passes remote full suite and required CI independently of L3; PR base is L1 and contains no unrelated source changes. No merge.

## PR

Title: `refactor(cli): isolate provider read handlers and argument parsing (split S14 L2/3)`

Branch: `codex/split-cli-provider`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification and Checklist with actual evidence. DEV-STACK-03 map, replacing placeholders when PRs exist:

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S14-L3> | hub transport / codex/split-client-hub-client | dev | transport and error identity |
| 2 | #<S14-L2> | provider readers / codex/split-cli-provider — this PR | dev | read handlers and argument parsing |
| 1 | #<S14-L1> | status probes / codex/split-cli-status | dev | diagnostic probes and old exports |

Base: dev — no dependency on the layers below; no cascade obligation.

Review only this layer's diff; no reliance on other layers' checks and no merge authorization.

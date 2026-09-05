# S04 L0 — desktop executor contract (105)

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs HEAD: `4cc219549eafbf9cd2efd651482fbfefd88944d5`. Fresh source basis:
`origin/dev = 4457429662bc98279d8b321e6f75d752f77e78e8`.
The seven inspected S04/companion source files are unchanged from `1362b1a38`
(`git diff 1362b1a38 origin/dev -- <seven paths>` returned no delta).
All source ranges below are at the fresh origin/dev basis.

Read: 003_parent_decisions.md TYPE-CYCLE-01 and PURE-MOVE-SIZE-01;
002_layer_map.md rows 105–150. This is the approved prerequisite's
implementation plan, not a claim that its code or PR has merged. The requested
“prerequisite landed as layer 105” pointer in 110 means assigned to this
roadmap layer; actual implementation receipts remain the parent's responsibility.

## Loop spec

- Archetype: **pure-move**; C3 dependency-boundary planning, docs-only delegated mode.
- Goal: remove the provider-type dependency on the desktop executor implementation
  before the five S04 split layers introduce new leaves. Preserve the public type
  at the original import path and preserve its exact five optional properties.
- Non-goals: no executor behavior, shell/spawn/timer/error changes, new runtime
  imports, new validation, new package, extra config type, provider-file split,
  S04 symbol repartitioning, or test implementation in this drafting task.
- Verifier: 002 **Per-layer gate**, instantiated below, as amended by 003:
  pure-move non-move diff ≤150 lines; compare cycle delta, not unrelated baseline
  cycles. S04 depth six is explicitly approved by TYPE-CYCLE-01.
- Stop: the parent has exact-tip export/type-resolution, graph, focused-test,
  privacy and remote full-suite receipts plus green exact-head CI. No merge.
- Escalation: any runtime diff, changed type shape, new cycle, source drift or
  additional companion edit requires parent direction; do not widen this layer.

Structural decision: `src/types/provider.ts:701` currently imports a type
through `native-exec-desktop.ts`, whose type dependency on
`native-exec-tools.ts` (specifier at native-exec-desktop.ts:19) connects back
to tool-definitions via native-exec-tools.ts:25. Move the existing contract to a
dependency-free sibling; both provider and implementation consume that owner.
Rejected: only redirecting tool-naming to types/request, because
types/request.ts:3 still reaches provider; duplicating the interface, because
that introduces a second authority; runtime/lazy imports, because this is an
erased-type dependency and needs no runtime mechanism. Deletion/configuration
cannot preserve the contract. Reuse the exact existing declaration.

Blast radius: one adapter implementation and one provider type-reference field,
plus one new contract. No package API changes. Existing kebab-case siblings
`native-exec-common.ts`, `native-exec-tools.ts`, and `claude-id.ts` establish
the naming/layout convention; no index barrel is added.

## Symbol inventory

Main source: `src/adapters/cursor/native-exec-desktop.ts`, 207 lines.
Inventory covers every owned top-level declaration; imports are dependencies.
Evidence: `git show origin/dev:src/adapters/cursor/native-exec-desktop.ts`
and `ast-grep run --lang typescript --kind <lexical_declaration|interface_declaration|function_declaration> --json=compact src/adapters/cursor/native-exec-desktop.ts`,
filtered to top-level declarations at source column zero (exported declarations
start after the export modifier in AST output). Ranges exclude leading comments.

Counts are distinct external referencing files from
`rg -l -w '<symbol>' src gui/src scripts tests`, excluding the defining file.
Private declarations have zero external bound consumers.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `DEFAULT_DESKTOP_TIMEOUT_MS` | const | 21–21 | no | 0 | native-exec-desktop.ts (residual) |
| `DesktopExecutorConfig` | interface | 28–37 | yes | 1 | desktop-executor-contract.ts |
| `desktopDepsFromConfig` | function | 45–55 | yes | 2 | native-exec-desktop.ts (residual) |
| `runComputerUse` | async function | 57–80 | no | 0 | native-exec-desktop.ts (residual) |
| `runRecordScreen` | async function | 82–111 | no | 0 | native-exec-desktop.ts (residual) |
| `computerUseError` | function | 113–117 | no | 0 | native-exec-desktop.ts (residual) |
| `recordScreenFailure` | function | 119–123 | no | 0 | native-exec-desktop.ts (residual) |
| `runExternalJson` | function | 130–207 | no | 0 | native-exec-desktop.ts (residual) |

Exact `DesktopExecutorConfig` references:

- Definition: native-exec-desktop.ts:28.
- Same-file annotations: :45, :57, :82, :130 (four local consumers).
- Only external consumer: src/types/provider.ts:701, inline import type.
- Zero direct test consumers of that type name.

Companion edit only: the `desktopExecutor` property at src/types/provider.ts:701
inside the existing `OcxProviderConfig` interface (:172–723). Change only its
import specifier; do not move or reinventory unrelated provider declarations.
The two external `desktopDepsFromConfig` consumers are
src/adapters/cursor/live-transport.ts:68 and
tests/providers/cursor/cursor-desktop-exec.test.ts:10.

## Leaf partition

### New `src/adapters/cursor/desktop-executor-contract.ts`

Move native-exec-desktop.ts:23–37 verbatim: five leading documentation lines and
the ten-line exported interface. Expected size **15 lines**, no own imports,
no runtime values, no dependencies, no initialization.

```ts
/**
 * Opt-in external executor for computer-use / record-screen. opencodex is a headless proxy and
 * cannot drive a screen itself; set these commands only when running on a host that can. Each
 * command receives the request as JSON on stdin and must print a JSON result on stdout.
 */
export interface DesktopExecutorConfig {
  /** Command (run via the platform shell) handling computer-use. Receives `{toolCallId, actions}` on stdin. */
  computerUseCommand?: string;
  /** Command handling record-screen. Receives `{mode, toolCallId, saveAsFilename?}` on stdin. */
  recordScreenCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Max time to wait for the external process. Default 30s. */
  timeoutMs?: number;
}
```

### Residual and companion

- `native-exec-desktop.ts`: keep every other body and import. Remove the 15-line
  slice, add the two one-line bindings below: **207 − 15 + 2 = 194 lines**.
  No residual over 400 and no #b layer.
- `src/types/provider.ts`: one line replaced, **723 → 723**. This is an
  explicitly approved companion type-reference edit, not a split target or a
  claim that the provider file's pre-existing size debt is resolved.
- Leaf plus split residual: **15 + 194 = 209**, original 207 plus two glue lines.
  Including companion: **932** total versus 930 before, net +2.
- PURE-MOVE-SIZE-01 accounting: 15 verbatim lines transferred; two added
  import/re-export lines and one removed/one added consumer line give **4 raw
  non-move changed lines**, well below 150. Record actual diff at execution;
  do not count this docs file as runtime source churn.

## Re-export block

Keep every current export importable from native-exec-desktop.ts. The runtime
`desktopDepsFromConfig` declaration remains exported in place.

```ts
export type { DesktopExecutorConfig } from "./desktop-executor-contract";
```

Re-export binds nothing locally. Add the explicit erased local binding for
the four existing annotations; no value import:

```ts
import type { DesktopExecutorConfig } from "./desktop-executor-contract";
```

Exact provider.ts:701 replacement:

```ts
  desktopExecutor?: import("../adapters/cursor/desktop-executor-contract").DesktopExecutorConfig;
```

No field rename, requiredness change, alias type, duplicate interface, exported
runtime object, or consumer change beyond this one inline type specifier.

## Module-level state and cycles

The sole top-level value `DEFAULT_DESKTOP_TIMEOUT_MS` at :21 stays in
native-exec-desktop.ts. There is no top-level let, Map, Set, WeakMap, lock or
timer. stdout/stderr/settled at :140–142 and timer at :143–148 are invocation-local
inside runExternalJson and do not move. The new contract owns only the interface;
provider imports its type, never copies its fields. No lifecycle or state changes.

Read-only resolver evidence, run during this drafting turn:

1. Read files using `git show 4457429662bc98279d8b321e6f75d752f77e78e8:<path>`;
   resolve relative static from/re-export specifiers and literal inline
   `import("...")` type specifiers, including erased types. Resolve exact paths,
   .ts/.tsx/.mts/.mjs and index.ts against the basis tree.
2. Record the baseline provider edge and the tool-definitions return cycle.
3. In memory only, add the contract leaf, its desktop import/re-export and the
   provider specifier replacement. Overlay all eleven leaf imports and moved
   source ranges from docs 110–150; add each facade's exact planned imports and
   re-exports. Conservatively retain baseline facade imports as an edge superset,
   so a missing return path is not caused by dropping an unmodelled old import.
4. Breadth-first traverse from each of the twelve new leaves; fail if an edge
   returns to that starting leaf. Assert provider no longer directly imports
   native-exec-desktop and directly imports the contract instead.

Observed output (resolver exit **0**, no production imports or tests executed):

```text
basis provider->desktop: true
basis cycle: tool-definitions -> types -> provider -> native-exec-desktop -> native-exec-tools -> tool-definitions
overlay provider->desktop: false
overlay provider->contract: true
desktop-executor-contract.ts: no return cycle
tool-naming.ts: no return cycle
tool-schemas.ts: no return cycle
tool-guidance.ts: no return cycle
catalog-data.ts: no return cycle
image-format.ts: no return cycle
image-preparation.ts: no return cycle
tool-budget.ts: no return cycle
protobuf-event-state.ts: no return cycle
protobuf-tool-events.ts: no return cycle
patch-grammar.ts: no return cycle
structured-edit.ts: no return cycle
PASS: 12 planned leaves; provider edge removed; no new leaf closes a type/runtime cycle
```

The in-memory negative control also ran in this drafting turn: restoring only
the old provider specifier produced `tool-naming → types → provider →
native-exec-desktop → native-exec-tools → tool-definitions → tool-naming`.
This establishes that the resolver detects the exact cycle the prerequisite
removes; no source file was mutated for either check.

Before:
`src/types.ts:112 → src/types/provider.ts:701 → native-exec-desktop.ts:19 → native-exec-tools.ts:25 → tool-definitions.ts:3 → src/types.ts`.

After:
`provider.ts:701 → desktop-executor-contract.ts` and
`native-exec-desktop.ts → desktop-executor-contract.ts`; the contract has
zero outgoing edges, so it cannot return to the implementation. The runtime
dependency graph does not change: the interface, export type, import type and
provider inline type are erased. This is plan-overlay evidence, **not** evidence
of code already landed; the layer executor repeats the resolver against the
actual layer tip and each S04 tip. Per TYPE-CYCLE-01, unrelated pre-existing
cycles are baselined rather than repaired in this layer.

## Tests

Commands used for this inventory (read-only):

```sh
rg -n -w DesktopExecutorConfig src gui/src scripts tests
rg -l -w DesktopExecutorConfig src gui/src scripts tests
rg -n 'native-exec-desktop' src gui/src scripts tests
rg -l 'readFileSync|Bun\.file|source\(' tests | xargs rg -n 'native-exec-desktop|types/provider|DesktopExecutorConfig'
```

- `tests/providers/cursor/cursor-desktop-exec.test.ts:10` — **unchanged**,
  the sole direct test importer of native-exec-desktop.ts; it imports
  desktopDepsFromConfig, not DesktopExecutorConfig. Preserve executor result,
  unsupported-default, pipe-error and platform-shell assertions.
- No direct DesktopExecutorConfig test imports; typecheck covers provider.ts:701
  and the four desktop implementation annotations. Preserve the historical
  type re-export as a separate structural/export check, not merely runtime tests.
- No explicitly named text-oracle reader of either touched source was found by
  the source-reader candidate search. No retarget-to-leaf or add-leaf-to-scan-list.
- `tests/lab/core-lab-boundary.test.ts` is **not affected by this layer**:
  its static traversal regex (:50) skips import type/export type, and its
  traversal (:80) skips literal import() edges; its source read at :69 may still
  visit the desktop implementation, but all runtime edges there are unchanged.
  The new dependency-free type-only leaf is unreachable through the new erased
  bindings. No src/server, src/router or src/lib source is changed, so 002's
  conditional local Lab gate is not activated. Do not edit PROTECTED roots or
  add the contract to a runtime scan list. Later S04 move layers retain their
  own Lab checks.
- Guard to drive red once during implementation: in a disposable **in-memory**
  graph overlay, restore provider.ts's old native-exec-desktop type specifier
  while keeping the S04 leaf overlays. The resolver must again report the
  tool-naming return cycle. Restore the contract edge and require zero new-leaf
  cycles. Also assert exactly one DesktopExecutorConfig interface declaration
  and both the compatibility re-export and local type import. No source mutant
  is committed, no new test file/layout entry is required.

## Verification

Implementation-only commands, not run by this drafting delegate. Execute at
the layer's own tip in its dedicated worktree:

```sh
bun run typecheck
bun test tests/providers/cursor/cursor-desktop-exec.test.ts
bun run privacy:scan
wc -l src/adapters/cursor/desktop-executor-contract.ts src/adapters/cursor/native-exec-desktop.ts
rg -n 'interface DesktopExecutorConfig|import type.*DesktopExecutorConfig|export type.*DesktopExecutorConfig|desktopExecutor\?: import' src/adapters/cursor src/types/provider.ts
rg -n 'native-exec-desktop' src/types/provider.ts
git diff -M --stat dev...HEAD
git diff --color-moved=dimmed-zebra dev...HEAD -- src/adapters/cursor src/types/provider.ts
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch -q origin codex/split-cursor-desktop-executor-contract && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test > /tmp/suite-split-cursor-desktop-executor-contract.log 2>&1; rc=$?; tail -15 /tmp/suite-split-cursor-desktop-executor-contract.log; echo SUITE_EXIT=$rc; exit $rc'
```

The negative `rg` for native-exec-desktop in provider.ts must produce **no
matches (exit 1)**; that is expected, not a failed implementation check.
All positive checks must find the exact expected bindings. Run the graph
resolver described above against actual tip sources, and with future S04 leaf
overlays, plus its in-memory negative control. Check interface body equivalence
including comments/optional properties and exactly one definition. Keep the two
desktopDepsFromConfig consumers unchanged; the type consumer deliberately moves
from implementation to contract. A generic importer-count-equal rule must not
reject that explicitly approved one-edge migration.

Require local typecheck/privacy exit 0, focused test 0 failures, remote
SUITE_EXIT=0 with printed SHA equal to this PR head, full remote log retained,
and green exact-head CI rollup. Full suite never locally. Parent verifies remote
checkout ownership before the planned fetch/checkout; no unrelated dirty work
may be overwritten. No merge or push is performed by this delegate.

## Accept criteria

1. desktop-executor-contract.ts contains exactly the original :23–37 slice
   (15 lines), one interface and zero imports/runtime declarations.
2. Native desktop residual is 194 lines, with every runtime declaration and body
   unchanged, both exact erased bindings present and the historical type export
   preserved. Provider companion remains 723 lines; only :701's type path changes.
3. The five properties retain identical optionality and types; all four local
   annotation uses resolve to the sole contract owner.
4. Resolver records provider → desktop absent and provider → contract present;
   all twelve planned leaves have no return cycle. Negative control restores a
   detectable cycle; unrelated baseline cycles stay outside scope.
5. Runtime import edges and Lab protected roots/traversal stay unchanged; no
   source-oracle retarget or runtime scan-list expansion.
6. Non-move source diff ≤150 under PURE-MOVE-SIZE-01; verbatim relocation proved
   with move-aware diff and exactly-once inventory. No opportunistic changes.
7. Exact-tip typecheck, focused test, privacy, remote full-suite and CI receipts
   satisfy 002; no local full suite or unauthorized merge.
8. Six-layer map follows 002: 105 on dev, then 110/120/130/140/150 bottom-up.
   Every split residual/new leaf is ≤400. The provider companion's existing
   723-line file is not counted as a new split residual.

## PR

Title: `refactor(adapters-cursor): isolate desktop executor type contract (split S04 L0/5)`

Branch: `codex/split-cursor-desktop-executor-contract`. Base: `dev`. Closes: **none**.
L0–L5 are six layers; the L0/5 label preserves 002's zero-based prerequisite
numbering and the existing five split-layer titles.

Use every section of .github/PULL_REQUEST_TEMPLATE.md: Summary, Verification,
Checklist. Put the stack map in Summary and link move-aware diff guidance in
Verification per PURE-MOVE-SIZE-01. Replace placeholders with actual PR numbers
only when the parent opens them.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L0 (105)**. Parent: `dev`.
Changes to parent `dev` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.
\n## Execution record (B, 2026-09-05)\n\n- Worktree:  (node_modules symlinked to the primary checkout; the\n  a2c0 app worktree's node_modules lacks bun-types/@bufbuild — noted for\n  every later layer).\n- Executor: gpt-6-astra high (Carson, 01a06edc-7667-7b90-833c-e5562a3e9084).\n- Commit: e950b27138b20cc06e4d7b7a2268b9cf996a08e2 on\n   (base origin/dev 445742966);\n  3 files, +18/−16; leaf 15 lines, residual 194, provider.ts 723.\n- Local gate (main agent re-ran after the symlink fix): error TS2688: Cannot find type definition file for 'bun-types'.
  The file is in the program because:
    Entry point of type library 'bun-types' specified in compilerOptions\n  exit 0; bun test v1.4.0 (34cbb9a40)\n  14 pass / 0 fail; Privacy scan passed passed; On branch codex/260905-modular-debt-ledger-docs
nothing to commit, working tree clean clean.\n- Pushed to origin: .\n

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-105.LalCGy/wt` (node_modules symlinked to the primary checkout; the a2c0 app worktree's node_modules lacks bun-types/@bufbuild).
- Executor: gpt-6-astra high (Carson, 01a06edc-7667-7b90-833c-e5562a3e9084). Incident: a stray `bun scripts/test.ts` from the first executor worktree let the test-runner fixture commit `base.txt`/`seed` onto the branch; the worktree was recreated and the branch reset to e950b2713 before review. Lesson for later layers: executors must not launch `bun run test` at all.
- Commits: e950b2713 (move, 3 files +18/−16) and 97df51515 (regression guard in tests/providers/cursor/cursor-desktop-exec.test.ts: type parity via both paths, contract has no imports, provider.ts points at the contract — driven red once by restoring the old provider specifier: 14 pass / 1 fail, then green 15/15). Required because CI hygiene `missing_regression_test` rejects a src/ change with no test change.
- Local gate at 97df51515: `bun run typecheck` 0; focused 15 pass / 0 fail; `bun run privacy:scan` passed; leaf 15 lines, residual 194.
- Adversarial diff review (Kepler, gpt-6-astra high, 01a06ede-fa7c-7673-8d86-12f5031d6fd4): round 1 GO-WITH-FIXES(1: stray base.txt), round 2 VERDICT: PASS (byte-identical move, export parity, one provider line, no runtime import added, contract zero imports).
- lidge full suite at 97df51515: `SUITE_EXIT=0`, 18013 pass / 0 fail / 16 skip, log `/tmp/suite-split-cursor-desktop-executor-contract.log` on lidge.
- PR: https://github.com/lidge-jun/opencodex/pull/3557 (base dev, head 97df51515). CI rollup at record time: hygiene/enforce-target/gates/storage policy/api usage/keyring ubuntu+windows/npm-global ubuntu+windows/test 1-3 of 4 SUCCESS; test 4/4, macos 1/2, macos 2/2, keyring macos, npm-global macos, CodeRabbit still running. Final rollup to be re-read before the next S04 layer bases on this branch.

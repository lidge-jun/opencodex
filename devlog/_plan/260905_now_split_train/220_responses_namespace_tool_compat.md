# S07 L2/4 — Namespace call restoration

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 structural planning with explicit security-contract review of unchanged alias authorization.
- Goal: separate returned-call restoration and its alias contract from outbound namespace lowering, keeping every existing export at the original path.
- Non-goals: selector/auth policy changes, schema changes, new guards, tool identity renaming, behavior fixes, new dependencies or generic helpers. This delegated task writes only this plan; no code, tests, Git or orchestration actions.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below.
- Stop: a fully checked plan here; implementation later stops at an exact-head green open PR, never merge. L1 readiness remains subject to 210's parent-owned escalation.
- Escalation: any changed authorization/collision outcome, duplicated alias owner, new cycle, >400 leaf/residual, or non-move diff. Do not expand the four-layer stack without parent approval.

Basis: docs HEAD `4cc219549`; source `origin/dev` = `1362b1a38`, `src/responses/namespace-tool-compat.ts` = 435 lines, working tree identical. Lane: `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md:552`.

Structural map: `src/adapters/openai-responses.ts:21`, `src/server/responses/core.ts:382` and one behavioral test -> namespace facade -> `../types` / `./tool-groups`. Intended: same callers -> residual lowering module -> dependency-free restoration/alias leaf. Local Responses-feature blast radius. The shared predicate and type definitions must move down with the restoration leaf to avoid an upward import. Reject a whole-file rename (does not reduce size), or copying the predicate/types (two owners); deletion/configuration cannot deliver this partition.

## Symbol inventory

Inclusive `origin/dev` declaration ranges from ast-grep declaration kinds plus numbered source/anchored `rg`. Imports 1–2 are dependencies, not owned declarations. Consumers count distinct direct importer/re-exporter files that match `rg -l -w SYMBOL`, after resolving this module's literal specifiers in `src gui/src scripts tests`. Private declarations have 0; unrelated homonyms are excluded. Fan-in **3** files.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| RoutedNamespaceToolIdentity | interface | 4–15 | yes | 0 | namespace-tool-restore.ts |
| RoutedNamespaceToolAliases | type | 17–17 | yes | 1 | namespace-tool-restore.ts |
| BUILTIN_FUNCTIONS_NAMESPACE | const | 19–19 | no | 0 | residual namespace-tool-compat.ts |
| isPlainObject | function | 21–23 | no | 0 | namespace-tool-restore.ts |
| namespaceIdentity | function | 25–27 | no | 0 | residual namespace-tool-compat.ts |
| isRepresentableName | function | 34–42 | no | 0 | residual namespace-tool-compat.ts |
| NamespaceGroup | type | 44–48 | no | 0 | residual namespace-tool-compat.ts |
| parseNamespaceGroup | function | 59–72 | no | 0 | residual namespace-tool-compat.ts |
| loweredIdentity | function | 79–83 | no | 0 | residual namespace-tool-compat.ts |
| loweredWireName | function | 85–87 | no | 0 | residual namespace-tool-compat.ts |
| addSelector | function | 89–97 | no | 0 | residual namespace-tool-compat.ts |
| NamespaceRewritePlan | type | 99–104 | no | 0 | residual namespace-tool-compat.ts |
| NamespaceToolCollisionError | class | 107–107 | yes | 1 | residual namespace-tool-compat.ts |
| buildRewritePlan | function | 109–159 | no | 0 | residual namespace-tool-compat.ts |
| rewriteToolList | function | 168–204 | no | 0 | residual namespace-tool-compat.ts |
| hasMalformedNamespace | function | 227–229 | no | 0 | residual namespace-tool-compat.ts |
| rewriteNamedSelector | function | 231–251 | no | 0 | residual namespace-tool-compat.ts |
| rewriteToolChoice | function | 253–267 | no | 0 | residual namespace-tool-compat.ts |
| authorizedAliases | function | 274–320 | no | 0 | residual namespace-tool-compat.ts |
| rewriteInputItem | function | 322–333 | no | 0 | residual namespace-tool-compat.ts |
| rewriteRoutedNamespaceToolsForUpstream | function | 343–377 | yes | 2 | residual namespace-tool-compat.ts |
| restoreRoutedNamespaceCalls | function | 379–414 | yes | 2 | namespace-tool-restore.ts |
| restoreRoutedNamespaceCallsInJson | function | 416–429 | yes | 2 | namespace-tool-restore.ts |
| createRoutedNamespaceCallRestoreRewrite | function | 431–435 | yes | 2 | namespace-tool-restore.ts |

## Leaf partition

One new sibling, `src/responses/namespace-tool-restore.ts`: `RoutedNamespaceToolIdentity`, `RoutedNamespaceToolAliases`, `isPlainObject`, `restoreRoutedNamespaceCalls`, `restoreRoutedNamespaceCallsInJson`, `createRoutedNamespaceCallRestoreRewrite`. Move ranges **4–17, 21–23, 379–435** = **74** existing lines. Two separating blanks = **76 lines**. Its own imports: **none**; standard language/JSON/Map types only. Export `isPlainObject` from the leaf for the residual, but not through the original public path.

Residual: **435 - 74 + 4 = 365 lines**, with four exact wiring lines below; preserve all other source text and both original imports. Combined **76 + 365 = 441 = 435 + 6**. No #b required. Approximate raw diff before formatting: 74 deletions + 80 additions = 154, below 500. Existing sibling naming was checked against `src/responses/{custom-tool-compat,tool-search-compat,tool-groups,provider-opaque-metadata}.ts`; do not introduce a convenience index.

Only the helper's export modifier changes; restore recursion stays in its owner and the types are not copied. The alias contract is colocated with the function that consumes it at the wire boundary rather than creating a type-only micro-file. Keep name/kind filtering in `authorizedAliases` unchanged in the residual.

## Re-export block

Add exactly these public compatibility exports:

```ts
export type { RoutedNamespaceToolIdentity, RoutedNamespaceToolAliases } from "./namespace-tool-restore";
export { restoreRoutedNamespaceCalls, restoreRoutedNamespaceCallsInJson, createRoutedNamespaceCallRestoreRewrite } from "./namespace-tool-restore";
```

Keep the original exported `NamespaceToolCollisionError` and `rewriteRoutedNamespaceToolsForUpstream` declarations in place. Explicit residual local bindings, because the re-exports bind nothing locally:

```ts
import type { RoutedNamespaceToolIdentity } from "./namespace-tool-restore";
import { isPlainObject } from "./namespace-tool-restore";
```

`RoutedNamespaceToolAliases` and restoration functions are not used by the residual; do not add unused local imports for them. Leaf recursion resolves locally. Existing adapter/core/test imports stay unchanged.

## Module-level state and cycles

No top-level `let`, Map, Set, WeakMap, lock or timer. `BUILTIN_FUNCTIONS_NAMESPACE` (`src/responses/namespace-tool-compat.ts:19`) remains a single immutable scalar in residual lowering. Type aliases for Maps are not allocations. Request-local Maps/Sets in `buildRewritePlan` (110–114), `authorizedAliases` (283) and rewrite entry (353) must remain per-call. Returned alias objects retain their identities and lifetime.

Direction: residual -> restoration leaf. Leaf imports nothing, so it cannot create a direct or transitive back edge. In particular, importing alias types or `isPlainObject` from the old facade in the leaf would create a cycle, even if one edge were type-only. Functional coupling only; the existing caller-owned alias map is not a new shared store. Lane 011 found no existing cycle; recheck changed static/type/literal-dynamic edges at implementation HEAD.

## Tests

`rg -l 'responses/namespace-tool-compat["\x27]' tests | sort` returns one direct importer:

```text
tests/responses/namespace-tool-compat.test.ts
```

Disposition: **unchanged**, old-path import at line 7; keep all assertions. Also unchanged, indirect transport coverage: `tests/responses/openai-responses-passthrough.test.ts` exercises lowering/restoration through the adapter/core. No new test file/test-layout change.

Literal basename, full path and segmented `repoPath`/`join` search among source readers found no direct text oracle (lane 011 agrees). Transitive source readers:

| test and exact read | disposition | action |
|---|---|---|
| `tests/lab/core-lab-boundary.test.ts:69` | unchanged | New restoration leaf reached from core through namespace module automatically. |
| `tests/codex-integration/compatibility-manifest.test.ts:61` | unchanged | Same import-graph discovery; no static filename list to extend. |

No retarget-to-leaf or add-leaf-to-scan-list needed. Drive the restoration behavioral guard at `tests/responses/namespace-tool-compat.test.ts:482` red once by temporarily disabling restoration in the new leaf, then restore it and prove green. Preserve the authorization tests at lines 107, 294 and 306; they must not be moved into a weaker direct leaf-only test. For graph guard proof, temporarily inject a forbidden Lab/compatibility edge into the reachable leaf, verify each respective guard fails, remove it and verify green. PROTECTED roots remain byte-identical.

## Verification

Execution plan only; no tests run by this drafter:

```sh
bun run typecheck
bun test tests/responses/namespace-tool-compat.test.ts tests/responses/openai-responses-passthrough.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/responses/namespace-tool-restore.ts src/responses/namespace-tool-compat.ts
rg -n 'from "[^"]*/namespace-tool-compat"' src gui/src scripts tests | wc -l
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-responses-namespace-tool-compat && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused domain: Responses, with reachable-boundary coverage in codex-integration/Lab. Fan-in remains 3; typecheck additionally proves named exports and type identity. Verify zero return edges from the dependency-free leaf; compare moved AST bodies ignoring only export modifiers. Remote tested SHA must equal PR head; retain full output and verify pipeline exit plus 0 failures, never use the tail alone as proof. Full suite remote only; exact-head CI rollup required before readiness.

## Accept criteria

1. All 24 declarations have one owner; all seven current exports remain importable from the old module with unchanged names/signatures and the same error constructor.
2. Leaf <=400 (76 planned); residual <=400 (365 planned); no duplicate predicate or alias interface.
3. Outbound authorization/collision logic is unchanged; recursion, copy-on-change identity, JSON error fallback and alias closure behavior are byte-preserved.
4. One direct test importer and indirect passthrough tests remain unchanged; red-once guard proof is recorded, including graph reachability without editing PROTECTED roots.
5. Typecheck, focused tests, privacy scan, remote exact-head full suite and exact-head CI are green; no new import cycle.
6. PR has the correct parent branch; parent layer's unresolved planning constraint is resolved before claiming stack readiness.

## PR

Title: `refactor(responses): separate namespace call restoration (split S07 L2/4)`

Branch: `codex/split-responses-namespace-tool-compat`. Base: `dev`. Closes: none. Fill every `.github/PULL_REQUEST_TEMPLATE.md` section (Summary, Verification, Checklist). Review this layer's diff only.

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S07-L4 | codex/split-server-responses-collaboration | codex/split-responses-parser | Tool maps, roster rendering, insertion |
| 3 | #TBD-S07-L3 | codex/split-server-responses-agent-task-recovery | dev | Envelope codec ownership |
| 2 | #TBD-S07-L2 | codex/split-responses-namespace-tool-compat — this layer | dev | Restoration and alias contract |
| 1 | #TBD-S07-L1 | codex/split-responses-parser | dev | Private parser leaves; size escalation |

Base: dev — no dependency on the layers below; no cascade obligation.

Merge requires separate user authorization. This delegated task performs no Git or PR mutation.

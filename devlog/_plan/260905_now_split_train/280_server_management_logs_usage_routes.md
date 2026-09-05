# S09 L2/3 — usage summary route extraction

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 module split, docs-only delegation.
- Goal: extract the usage-summary route and its three private helpers, making both new leaf and residual <=400 lines while preserving `handleLogsUsageRoutes` and route behavior.
- Non-goals: no cache-policy or response changes, log/storage rewrites, storage execution, cleanup of inherited unrelated imports, additional dispatch layers, new dependencies or export renames. Do nothing/configure/delete cannot remove the source-size debt; reuse the existing summary/aggregate cache owners.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. This task writes only this plan; no test runs.
- Stop: isolated L2 verified at its own tip, exact-head CI green and PR open against L1, never merged. Parent alone owns orchestration/loop/goal state.
- Escalation: source drift, >500 changed source lines, changed error/cache behavior, unexpected cycles, unavailable remote verification, or additional write scope returns to the parent. `src/server/management/route-registry.ts` owner metadata is a required implementation companion file; if the executor is limited to the original plus leaf, obtain that scope before implementing.

Source basis: `origin/dev` `1362b1a38`, docs HEAD `4cc219549`; numbered working source is identical. Lane 011 in `../260905_modular_debt_ledger/` identifies this seam at lines 363–372 and 820. Core map: `management-api.ts:61` → `handleLogsUsageRoutes` → logs/debug, usage projection caches, storage jobs. Chosen direction adds a direct usage leaf under the same management feature. Rejected: moving all route families into three leaves increases churn unnecessarily; moving just the three helpers leaves the file oversized. Public HTTP contracts and the old handler signature remain stable.

## Symbol inventory

Evidence command: `git show origin/dev:src/server/management/logs-usage-routes.ts | rg -n '^(export )?(async )?function |^}'`; numbered source supplies exact closing lines. Every locally defined top-level declaration is listed (import bindings are dependencies, not definitions). Consumers count distinct importing files via `rg -l` on the module path, followed by symbol checks; private symbols have zero external consumers.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| nextLocalMidnight | function | 86–90 | no | 0 | src/server/management/usage-routes.ts |
| usageSummaryExpiresAt | function | 92–98 | no | 0 | src/server/management/usage-routes.ts |
| refreshedUsageSummary | generic function | 100–103 | no | 0 | src/server/management/usage-routes.ts |
| handleLogsUsageRoutes | async function | 105–569 | yes | 1: src/server/management-api.ts:61 | residual; move only 169–320 body branch into handleUsageRoutes |

No top-level type, class, variable, enum or state declaration is hidden below the handler. The new `handleUsageRoutes(ctx: ManagementContext): Promise<Response | null>` is a production extraction wrapper, not an additional export from the old path.

## Leaf partition

New `src/server/management/usage-routes.ts`, following sibling `routing-analytics-routes.ts` and `request-history-routes.ts`. Search `rg -n 'handleUsageRoutes|usageSummaryExpiresAt|nextLocalMidnight|refreshedUsageSummary' src` confirms the three definitions live in the current source and no `handleUsageRoutes` exists. The existing `usage-summary-cache.ts` / `usage-aggregate-cache.ts` remain the storage owners; do not absorb or clone them.

- Symbols: private `nextLocalMidnight`, `usageSummaryExpiresAt`, `refreshedUsageSummary`; exported leaf-only `handleUsageRoutes` enclosing the complete original `if` branch at 169–320, then `return null`.
- Move 86–104 (19 lines including separator) and 169–321 (153 lines including separator). Expected **185 lines** = 172 moved + eight import/blank lines + five wrapper lines (signature, destructuring, separator, fallback, closing brace).
- Own imports, each on one line for the estimate:

```ts
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey } from "../../usage/log";
import { USAGE_RANGES, USAGE_SURFACES, parseRange, parseUsageSurface, rangeWindow, type UsageRange, type UsageSummary, type UsageSurface } from "../../usage/summary";
import { userCostOverlayVersion } from "../../usage/user-cost-overlays";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { discardUsageSummaryCacheEntry, getUsageSummaryCacheEntry, setUsageSummaryCacheEntry } from "./usage-summary-cache";
import { getFilteredUsageAggregate, getUsageAggregate } from "./usage-aggregate-cache";
```

Residual `src/server/management/logs-usage-routes.ts`: expected **388 lines** = 569 − 172 moved − 13 moved-only import lines (48–52, 54, 70, 79–84) + four import/delegation lines. Keep log/debug dispatch at original 108–167 first; replace the usage block at its original position with the three-line delegation below; keep storage dispatch at 322–566 after it and the final null. Leave unrelated inherited unused imports alone. No #b follows, no residual exceeds 400. Reformatting must respect the measured limit rather than rely on this estimate.

Required metadata move: `src/server/management/route-registry.ts:204`, **only** the GET `/api/usage` row's `module` changes from `server/management/logs-usage-routes` to `server/management/usage-routes`. Keep method, path, mutates and exemptions unchanged. This is necessary for owner-source reconciliation, not a public endpoint change. Estimated move-inclusive source diff is <400 lines before small assertions; the hard publishing check remains <=500.

## Re-export block

The exact additional `export { ... } from ...` / `export type { ... }` block is **empty**: none of the original exported declarations moves. Retain exactly the existing declaration `export async function handleLogsUsageRoutes(ctx: ManagementContext): Promise<Response | null>` at the original path. Do not re-export the newly introduced private-feature handler or expose the three former private helpers.

Explicit local import and delegation, since an export would not bind a local name:

```ts
import { handleUsageRoutes } from "./usage-routes";
```

```ts
  const usageResponse = await handleUsageRoutes(ctx);
  if (usageResponse) return usageResponse;

```

The leaf starts by destructuring `{ req, url, config } = ctx`, uses the original positive `/api/usage` + GET guard unchanged, and returns null for all other requests. No parent call-site or public export migration is needed.

## Module-level state and cycles

No top-level let, Map, Set, WeakMap, lock, timer or flight exists in the original. Every variable at 106–567 is invocation-local. `usage-summary-cache.ts` and `usage-aggregate-cache.ts` retain their own singleton lifetimes; moving imports must not create a second cache, reset it, or introduce a warm-loop owner in the leaf.

Functional direction: facade → usage route → existing cache/usage owners and auth response helper. `ManagementContext` remains owned by `context.ts`; no leaf import from `logs-usage-routes.ts`, `shared.ts` for convenience, or `management-api.ts`. This avoids the wrapper→leaf→wrapper cycle. Retain the original imported dependency semantics; no eager Lab edge or changed auth gate.

Temporal invariants at `src/server/management/logs-usage-routes.ts:169–320`: capture `now` once, bypass cache for filters, validate identity/read-size/overlay/timezone/freshness, invalidate before rebuilding, publish all range/surface cache entries only after aggregate consistency checks, return the same `read_failed` fallback. These statements move verbatim; extraction does not rename data fields, retry, parallelize or add catches.

## Tests

Direct-import search `rg -l 'from .*logs-usage-routes|import\(.*logs-usage-routes' tests --glob '*.ts'`: **empty**. Basename mentions in comments (`management-route-registry.test.ts:156`, helper lines 11/24) are not imports. Tests reach the function through `handleManagementAPI`.

- `tests/server/api-usage.test.ts` — unchanged runtime assertions through management API; cache-module imports at 16–17 must stay on existing owners. Preserve filters, TTL/midnight, revision/read limits, timezone/overlay, concurrent aggregation and failure response coverage.
- `tests/server/api-key-attribution.test.ts` and `tests/server/server-auth.test.ts` — unchanged indirect route consumers; run relevant domains remotely and preserve the auth/attribution contract.

Every identified source oracle and its read site:

| test / exact read site | disposition |
|---|---|
| `tests/server/management-route-registry.test.ts:63,93,115` calls `scanRoutes`; actual source read is `tests/helpers/management-route-scan.ts:112` | add-leaf-to-scan-list **automatically**: sibling discovery at test 47–50 includes `src/server/management/usage-routes.ts`; no weakening or scanner implementation change |
| `tests/server/management-route-registry.test.ts:81` reads `src/${route.module}.ts` | retarget-to-leaf `src/server/management/usage-routes.ts` for GET `/api/usage` via the exact registry row change at 204; other rows unchanged |
| `tests/codex-integration/compatibility-manifest.test.ts:61`, roots 182–190 | unchanged; automatic static graph traversal includes the new leaf through management-api |
| `tests/lab/core-lab-boundary.test.ts:69`, direct reads 278/336 | unchanged; protected graph and mounting assertions retain original roots |

No direct basename source read exists; the lane's “none found” does not exempt generic scanner reads. The unrelated CLI headless-parity scanner reads only `gui/src` at `tests/cli/cli-headless-parity.test.ts:216–218`, so it does not require a retarget for this extraction.

Drive red once during implementation C: leave `/api/usage`'s owner on the old module after moving the guard and require the registry owner/count tests to fail, then apply the metadata retarget and pass; change the moved GET guard to POST and require focused usage assertions to fail, then restore. Do not weaken unknown-method handling, count reconciliation or the three PROTECTED roots. Avoid adding a new test file unless necessary; if one is added, both layout manifests are required scope.

## Verification

Future gate at L2 tip (not executed while drafting):

```sh
bun run typecheck
bun test tests/server/api-usage.test.ts tests/server/api-key-attribution.test.ts tests/server/management-route-registry.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/server/management/usage-routes.ts src/server/management/logs-usage-routes.ts
rg -n 'from "[^"]*/logs-usage-routes"' src gui/src scripts tests | wc -l
git diff --check
```

Focused domains: server usage/registry/attribution, codex-integration graph and Lab boundary. Original importer count remains **1** and original export count **1**. Diff-check the original usage body against the leaf; inspect relative static, type and literal-dynamic edges from the moved imports for no new SCC/back-edge (a successful typecheck alone is insufficient).

Full suite only remotely: `ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-server-management-logs-usage-routes && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'`. In that dedicated checkout verify HEAD equals the exact recorded PR tip; retain full test log and actual test exit status. Capture exact-head CI rollup independently; no local full suite. Confirm L2 contains the latest L1 tip and PR base is L1, not dev.

## Accept criteria

1. Three private definitions move once; original handler and its signature remain exported at the same path with its sole importer unchanged.
2. One leaf <=400, residual <=400 (expected 185/388); measured layer source additions plus deletions <=500, otherwise escalate.
3. All `/api/usage` response fields, error fallbacks, cache ownership and sequencing are identical; log/debug precede it and storage routes follow it.
4. Exactly one registry owner row retargets; scanner automatically sees the leaf; stale-owner and route-method mutations fail before restored guards pass.
5. No cycle, no duplicated state, no new Lab reachability and no changes to protected roots or authorization behavior.
6. Typecheck, focused tests, privacy scan, exact-tip remote full suite and exact-head CI pass with recorded evidence; security-sensitive management-boundary review is explicit before review-ready status.
7. Correct L1 ancestry/base, complete template and map, and an open unmerged L2 PR.

## PR

Title: `refactor(server): isolate usage summary route dispatch (split S09 L2/3)`

Branch: `codex/split-server-management-logs-usage-routes`. Base: `codex/split-server-system-env`. Closes: none.

Use every Summary, Verification and Checklist section of `.github/PULL_REQUEST_TEMPLATE.md`. DEV-STACK-03 map (replace PR-number placeholders when published):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S09-L3 | lab-routes | codex/split-server-management-lab-routes | dev | public evidence route boundary |
| 2 | #TBD-S09-L2 | logs-usage-routes — this PR | codex/split-server-management-logs-usage-routes | codex/split-server-system-env | usage summary dispatch |
| 1 | #TBD-S09-L1 | system-env | codex/split-server-system-env | dev | shell snapshot/hook ownership |

Depends on #TBD-S09-L1 (`codex/split-server-system-env`) only. Review this layer's diff only. Cascade and re-verify this layer after its real parent `codex/split-server-system-env` changes; independent L3 has no cascade obligation. Bottom-up merging of this dependency chain needs separate authorization; this train never merges.

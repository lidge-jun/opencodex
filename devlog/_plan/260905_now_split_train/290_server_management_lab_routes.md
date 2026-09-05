# S09 L3/3 — optional Lab public-evidence route boundary

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 module-boundary planning under a docs-only delegation.
- Goal: separate public-evidence routes from query dispatch, preserving the optional mount and every existing HTTP/error contract; all resulting files <=400 lines.
- Non-goals: no new Lab activation, public-evidence validation changes, query changes, parser unification, weakened body limit, eager import from core, exported handler rename, security fixes or merge. Do nothing/configure/delete cannot meet the size target. Reuse current query/public services and `ManagementContext`; introduce no generic helper framework.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; not executed in this drafting task.
- Stop: standalone L3 with exact-head green evidence and an open PR against L2, never merge. Parent owns loop/goal/orchestration; this delegation writes only its assigned plan.
- Escalation: changed input/error behavior, a new import cycle, >500 changed source lines, source drift, non-green gate, or scope expansion goes to the parent. Registry metadata changes specified below are necessary companion implementation scope; do not silently skip them if only the original and leaves are authorized.

Basis: docs HEAD `4cc219549`, code `origin/dev` `1362b1a38`; all ranges are origin/dev ranges and working source is identical. Lane 011 in `../260905_modular_debt_ledger/` records this file at 374–384 and optional mounting at 782. It has **562 newline characters, 563 physical lines**: its final `}` is not newline terminated.

Structural decision: management-api's namespace-gated dynamic import at `src/server/management-api.ts:123–132` leads to one Lab route module with query parsing and public writes. Chosen: retain query dispatch in that boundary, extract public handling plus a small shared error-mapping leaf. Rejected: a public leaf importing errors from the original creates a facade↔leaf cycle; duplicating error mapping creates two owners. All new dependencies stay inside the optional Lab management feature; no new package or convenience index.

## Symbol inventory

Collected with `git show origin/dev:src/server/management/lab-routes.ts | rg -n '^(export )?(async )?(function|const|let|type|interface|class) |^}'` and numbered end-line inspection. Locally defined top-level declarations only; imported bindings are listed under own imports below. Consumers are distinct external importing files from `rg -l`, filtered to actual symbol uses; same-name helpers elsewhere are not consumers. `public` = `src/server/management/lab-public-routes.ts`; `errors` = `src/server/management/lab-route-errors.ts`; residual = original file.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| parseQueryInt | function | 59–65 | no | 0 | residual |
| errorResponse | function | 67–74 | no | 0 | errors; internal leaf export |
| projectionErrorResponse | function | 76–87 | no | 0 | errors; internal leaf export |
| parseLimit | function | 89–112 | no | 0 | residual |
| parseRange | function | 114–131 | no | 0 | residual |
| parseLayer | function | 133–140 | no | 0 | residual |
| parseVerdict | function | 142–149 | no | 0 | residual |
| parseEventKind | function | 151–158 | no | 0 | residual |
| parseOutcome | function | 160–167 | no | 0 | residual |
| parseExecutionMode | function | 169–176 | no | 0 | residual |
| rejectUnsafeId | function | 178–186 | no | 0 | residual |
| decodePathSegment | function | 188–194 | no | 0 | residual |
| paginatedEnvelope | generic function | 196–202 | no | 0 | residual |
| MAX_PUBLIC_REQUEST_BYTES | const number | 204–204 | no | 0 | public |
| readBoundedPublicJson | async function | 206–243 | no | 0 | public |
| publicEventIds | function | 245–258 | no | 0 | public |
| publicBundleValue | function | 260–269 | no | 0 | public |
| publicErrorResponse | function | 271–281 | no | 0 | public |
| handleLabRoutes | async function | 283–563 | yes | 1: src/server/management-api.ts:131–132 (dynamic) | residual; 287–350 branch group moves to handleLabPublicRoutes |

## Leaf partition

Sibling filenames deliberately follow existing `src/server/management/{routing-analytics-routes,storage-log-guard-routes,body}.ts`. `rg -n 'lab-public-routes|lab-route-errors|handleLabPublicRoutes' src` finds no existing owners; `errorResponse`/`projectionErrorResponse` remain Lab-specific rather than being folded into unrelated generic response helpers. No new subfolder, because the route scanner discovers direct `.ts` siblings only.

1. `src/server/management/lab-route-errors.ts`: `errorResponse` (67–74) and `projectionErrorResponse` (76–87), unchanged bodies, exported only for production use by the facade and public leaf. Move 67–87 (21 lines). Expected **25 lines** with these three imports and a blank:

```ts
import { InvalidCursorError, LabProjectionIncompatibleError, LabProjectionUnavailableError } from "../../lab/query";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
```

2. `src/server/management/lab-public-routes.ts`: `MAX_PUBLIC_REQUEST_BYTES`, `readBoundedPublicJson`, `publicEventIds`, `publicBundleValue`, `publicErrorResponse` (204–281, 78 lines), and new leaf-only `handleLabPublicRoutes(ctx: ManagementContext): Promise<Response | null>` containing original 287–350 (64 lines). Keep the GET community branch and complete POST group, including its unknown-path `return null`. Add a final null for other methods. Expected **160 lines** = 142 moved + 13 import/blank lines + five wrapper lines; formatting allowance must remain under 400. Own imports (preserve original nine-line public import block at 47–55):

```ts
import {
  exportLocalPublicEvidence,
  importCommunityEvidenceValue,
  listCommunityEvidenceContext,
  parseStrictPublicJson,
  previewLocalPublicEvidence,
  summarizePublicEvidenceVerification,
  PublicEvidenceValidationError,
} from "../../lab/public";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { errorResponse, projectionErrorResponse } from "./lab-route-errors";
```

Residual `src/server/management/lab-routes.ts`: expected **389 newlines / 390 physical lines** before optionally normalizing its final newline (then 390/390). Accounting: 562 − 22 (67–88) − 79 (204–282) − 65 (287–351) − 9 (47–55 public imports) − 3 (30–32 error-class imports) + 5 (two imports, two delegation statements and one blank). Keep constants/query imports needed for reads, `jsonResponse`, `ManagementContext`, query validators, prefix check, GET narrowing and all query branches. No #b and no residual over 400.

At original 287, after the unchanged prefix gate and before the unchanged `req.method !== "GET"` gate, replace the moved public group with the two delegation statements below plus a separator. The public wrapper destructures `{ url, req, config } = ctx`; it does not modify ctx or reparse a consumed request body. All original route guards, validation statements and catches move verbatim.

Required metadata retarget in `src/server/management/route-registry.ts`: GET `/api/lab/public/community` at 185 and POST `/api/lab/public/community/import`, `/api/lab/public/export`, `/api/lab/public/preview`, `/api/lab/public/verify` at 189–192 get `module: "server/management/lab-public-routes"`. The eleven query/regex route owners stay on `server/management/lab-routes` (eight literal reads at 180–184 and 186–188, three regex reads at 319–321); methods, paths, mutation flags, mechanisms, exemptions and owner docs do not change. Estimated source additions plus deletions <400; actual gate remains <=500.

## Re-export block

The exact additional `export { ... } from ...` / `export type { ... }` block is **empty**: `handleLabRoutes` is the only existing export and its implementation/signature stay at the original path. Keep `export async function handleLabRoutes(ctx: ManagementContext): Promise<Response | null>` unchanged. Do not expose the new public handler or error helpers from the compatibility boundary.

Required local imports:

```ts
import { errorResponse, projectionErrorResponse } from "./lab-route-errors";
import { handleLabPublicRoutes } from "./lab-public-routes";
```

Replacement at original 287–351:

```ts
  const publicResponse = await handleLabPublicRoutes(ctx);
  if (publicResponse) return publicResponse;

```

These are direct imports, not re-exports masquerading as bindings. Unknown public POST requests still fall through to the existing non-GET return-null; GET requests still reach original query dispatch after public community handling. No change to management-api's import string or automation-first ordering.

## Module-level state and cycles

`MAX_PUBLIC_REQUEST_BYTES` at `src/server/management/lab-routes.ts:204` is an immutable scalar, owned solely by the public leaf. There is **no** top-level let, Map, Set, WeakMap, lock, timer or flight in the original. Streaming `chunks`, `total`, `reader` and `offset` at 220–240 remain request-local; no body bytes or request state become shared.

Graph: namespace gate → dynamic `lab-routes` → `lab-public-routes` → `lab-route-errors`; residual also → `lab-route-errors`; both leaves → existing Lab query/public services and auth response helper. Neither leaf imports `lab-routes.ts` or `management-api.ts`, including via type imports. `ManagementContext` stays in `context.ts`. Error mapping is functional coupling, not a shared mutable error registry.

Preserve existing optional boundary at `management-api.ts:123–132` exactly. Static imports between these Lab-only modules are acceptable only behind that existing dynamic gate. Never add these leaves to the eager core chain or change `tests/lab/core-lab-boundary.test.ts` PROTECTED roots. No new lazy import is introduced to conceal a cycle.

Preserve transport validation at its current boundary: 2 MiB length and streamed-byte limits (204–243), reader cancellation, strict JSON parser identity, exact top-level body keys (245–269), error-class identity and retry header (271–280). Do not relocate these checks into services or add duplicate validation.

## Tests

Direct-import query `rg -l 'from .*management/lab-routes|import\(.*management/lab-routes' tests --glob '*.ts'` finds **no executed import**. `tests/lab/core-lab-boundary.test.ts:333` contains a quoted sample dynamic import to test the scanner, not an actual module load. Actual production importer is management-api at 131.

Indirect runtime tests, all unchanged and exercised through `handleManagementAPI`:

- `tests/lab/lab-public-api-json.test.ts:2` — strict/duplicate-key JSON, declared and streamed size limits.
- `tests/lab/lab-public-surfaces.test.ts:18` — public preview/export/verify/community/import and file effects within fixtures.
- `tests/lab/lab-read-surfaces.test.ts:43` — query endpoints, range/cursor validation, errors and read-only contract.
- `tests/lab/lab-passive-production-surfaces.test.ts:10` — production signal query validation.

Source oracles (the lane's basename-only “none found” misses the generic route scanner):

| test / exact read site | disposition |
|---|---|
| `tests/server/management-route-registry.test.ts:63,93,115`; helper `tests/helpers/management-route-scan.ts:112` reads each route file | add-leaf-to-scan-list automatically via sibling enumeration at test 47–50: `src/server/management/lab-public-routes.ts` and `src/server/management/lab-route-errors.ts`; errors leaf must yield zero routes |
| `tests/server/management-route-registry.test.ts:81` reads declared owner file | retarget-to-leaf `src/server/management/lab-public-routes.ts` for precisely five public rows through registry metadata; all original query owners unchanged |
| `tests/lab/core-lab-boundary.test.ts:69,278,336` graph/direct reads; quoted sample at 333 | unchanged; no retargeting PROTECTED. Optional-module name remains a non-direct-Lab-import example; the real mounting gate remains dynamic |
| `tests/codex-integration/compatibility-manifest.test.ts:61`, roots 182–190 | unchanged; walker deliberately skips dynamic edges at 68, so the public leaf must remain outside the eager traversal |

Keep the positive public guard strings and the outer POST guard together: the scanner narrows method by brace context. Keep original residual non-GET early return before read-path guards. No hand-entered scan exemptions, concatenated whole-repo text or dropped per-module count checks.

Guards to drive red once in implementation C: keep one moved public row's old owner and require registry owner/count failure, then restore the specified owner; reduce the public body bound or bypass duplicate-key parsing in a temporary mutation and require the existing JSON/body-limit test to fail, then restore; add a temporary direct Lab import in a protected graph and observe boundary failure without editing PROTECTED. Record red/green outputs; do not ship mutations. No new test-file registration is needed unless coverage proves insufficient, in which case scope includes both layout manifests.

## Verification

Future layer-tip gate, not commands run in this documentation task:

```sh
bun run typecheck
bun test tests/lab/lab-public-api-json.test.ts tests/lab/lab-public-surfaces.test.ts tests/lab/lab-read-surfaces.test.ts tests/lab/lab-passive-production-surfaces.test.ts tests/server/management-route-registry.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/server/management/lab-route-errors.ts src/server/management/lab-public-routes.ts src/server/management/lab-routes.ts
rg -n 'import\("\./management/lab-routes"\)' src/server/management-api.ts
git diff --check
```

Focused domains: Lab public/read surfaces, server registry and codex-integration graph. The ordinary 002 `from`-only importer command reports zero here because the real import is dynamic; the specialized command above must retain exactly one real production import. Original export count remains one. Audit direct, type and literal-dynamic edges from both leaves for no new SCC/back-edge; keep query/public/error import direction explicit, not inferred from typecheck success.

Full suite only on `lidge`: `ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-server-management-lab-routes && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'`. Confirm the dedicated remote checkout's HEAD equals the recorded local/PR tip; save actual exit code and full log. Record exact-head CI, verify L2 ancestry and PR base separately. No local full suite and no merge.

## Accept criteria

1. Every one of nineteen original definitions has exactly one owner; only `handleLabRoutes` remains public at the old path, with its single dynamic consumer unchanged.
2. Two leaves <=400 and residual <=400 (expected 25/160/390 physical lines); measured move-inclusive source changes <=500 or escalate.
3. Namespace/automation gating, GET narrowing, unknown-route nulls, HTTP status/body/header shapes, strict JSON and body bounds are unchanged.
4. Exactly five public registry owner fields retarget; eleven query/regex owners stay; per-module scanner counts and method resolution remain strict, with recorded red/green evidence.
5. No duplicated state, no new import cycle, no eager core→Lab edge and no PROTECTED root edits.
6. Typecheck, focused tests, privacy scan, exact-tip remote full suite and exact-head CI pass with recorded evidence; explicit security-boundary review precedes review-ready status.
7. L3 includes the current L2 tip, targets the L2 branch, carries complete PR template/map, and remains open and unmerged.

## PR

Title: `refactor(server): isolate Lab public evidence routes (split S09 L3/3)`

Branch: `codex/split-server-management-lab-routes`. Base: `dev`. Closes: none.

Use `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification and Checklist in full, including explicit security review. DEV-STACK-03 map (PR-number placeholders are replaced at publication):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S09-L3 | lab-routes — this PR | codex/split-server-management-lab-routes | dev | public evidence route boundary |
| 2 | #TBD-S09-L2 | logs-usage-routes | codex/split-server-management-logs-usage-routes | codex/split-server-system-env | usage summary dispatch |
| 1 | #TBD-S09-L1 | system-env | codex/split-server-system-env | dev | shell snapshot/hook ownership |

Base: dev — no dependency on the layers below; no cascade obligation.

Review only this layer's diff. Merging requires separate authorization; this train never merges.

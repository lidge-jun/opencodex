# S08 L2/2 — Claude Messages transport and replay leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 module-boundary planning with C4-level scrutiny of unchanged credential forwarding. Parent owns orchestration, loop and goal state; this task only writes its assigned documents.
- Goal: preserve every exported symbol and both Anthropic endpoint contracts while moving the 1,092-line `src/server/claude-messages.ts` into five implementation leaves and a small original-path entry/facade.
- Non-goals: changing admission, credentials, image normalization, routing, replay, budgets, timeout defaults, usage, error mapping, SSE ordering, or exported signatures; no implementation or tests during this task.
- Verifier: `002_layer_map.md`, **Per-layer gate**, instantiated below. The reference to 003 in 000 is stale; use 002.
- Stop: after the parent resolves the layer-size conflict, implementation ends only with its own exact-tip gates and an open PR; never merge. This delegated task stops after documentation consistency checks.
- **Escalation — implementation blocked on changeset size:** 002 gives this file one layer and requires ≤500 changed source lines. Reducing 1,092 to ≤400 requires removing at least 692 lines from the original even before adding any leaves. Thus no pure-move partition can satisfy both limits in this assigned L2. The complete endpoint partition below is a proposed diff, not a claim that this conflict is resolved. Parent must explicitly approve a move-only size exception, or revise the layer map with additional #a/#b parts. Do not silently reinterpret changed lines as only novel logic, invent an unassigned #b, or leave a >400 residual without a scheduled owner.
- Basis: docs HEAD `4cc219549`; code `origin/dev = 1362b1a38`, byte-equal to the working tree for this source. All source coordinates are origin/dev coordinates. Read `000_plan.md`, `001_stale_check.md`, S08 rows and gate in `002_layer_map.md`, and the `src/server/claude-messages.ts` subsection of `devlog/_plan/260905_modular_debt_ledger/011_lane_server_responses.md`.

Structural decision: the existing file combines request reading, credential-gated native transport, bounded bodies, translated replay, and token counting. No-op/configuration cannot meet the size gate, and deleting code changes behavior. Choose declaration-only extraction at those existing seams; reject splitting the 364-line replay function into new state-passing stages, because that introduces closure/control-flow changes unnecessary for a pure move. Keep its body intact and budget its imports to stay ≤400. The five same-directory leaves use `src/server/claude-messages/`, following the facade/subdirectory pattern at `src/server/responses.ts:1–13`, not a new internal index barrel.

Current map: `src/server/index.ts:178` and five behavioral tests consume this module. Its dependencies include inbound translation (`:13`), outbound (`:20–26`), auth-cors (`:38–43`), decompression (`:33`), logging (`:34–36`), responses replay (`:37`), routing (`:29–31`), image handling (`:11–12`), and request-scoped budgets (`:47–52`). Intended direction: original facade → replay → count-tokens/native/request-context; count-tokens → native/request-context; native → body/request-context; body → request-context; request-context → existing inbound/outbound/decompression owners. No leaf imports the facade. Public boundaries remain the same two routes and original TypeScript import path. Blast radius: one server feature. Runtime/transport context: `structure/01_runtime.md:10`, `structure/04_transports-and-sidecars.md:1407`.

## Symbol inventory

Every top-level owned declaration is listed (imports at 9–61 are listed per destination below). Exact ranges come from `sg run --lang ts --kind function_declaration --json=compact` plus lexical/type/interface kinds, checked against `git show origin/dev:src/server/claude-messages.ts | nl -ba`. Declaration ranges exclude leading comments.

Consumers = distinct external files among the verified `rg -l '/claude-messages["\x27]' src gui/src scripts tests` importers, counted with `rg -l -w '<symbol>' <importer-files>`. Private declarations are zero, rather than accidental matches for common names elsewhere. Fan-in: **6 files = 1 source + 5 tests**. Leaf names below are under `src/server/claude-messages/`; `R` means the original residual file.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| Rec | type | 63–63 | no | 0 | request-context.ts |
| decodeClaudeFastSelector | function | 73–79 | no | 0 | request-context.ts |
| isRec | function | 81–83 | no | 0 | request-context.ts |
| buildClaudeReplayConfig | function | 86–98 | yes | 1 | request-context.ts |
| claudeInboundDisabled | function | 100–105 | no | 0 | request-context.ts |
| readAnthropicBody | async function | 107–114 | no | 0 | request-context.ts |
| PASSTHROUGH_STRIP_HEADERS | const Set | 124–128 | no | 0 | native.ts |
| singleCredentialToken | function | 130–141 | no | 0 | native.ts |
| hasAnthropicNativeCredential | function | 143–148 | no | 0 | native.ts |
| wantsNativePassthrough | function | 150–168 | no | 0 | native.ts |
| shouldForwardNativeHeader | function | 170–176 | no | 0 | native.ts |
| uuidFromHex | function | 179–182 | no | 0 | request-context.ts |
| anthropicUsageToOcx | function | 184–201 | no | 0 | body.ts |
| PassthroughBodyGuard | interface | 204–211 | yes | 0 | body.ts |
| PassthroughCloseReason | type | 213–213 | no | 0 | body.ts |
| tapAnthropicSseForLog | function | 224–364 | yes | 1 | body.ts |
| anthropicNativePassthrough | async function | 366–459 | no | 0 | native.ts |
| DEFAULT_BODY_STALL_SEC | const number | 461–461 | no | 0 | body.ts |
| DEFAULT_BODY_MAX_BYTES | const number | 462–462 | no | 0 | body.ts |
| resolvePassthroughBodyGuard | function | 469–483 | yes | 1 | body.ts |
| BoundedPassthroughBody | type | 485–489 | no | 0 | body.ts |
| readBoundedPassthroughBody | async function | 497–552 | yes | 1 | body.ts |
| HeaderDeadlineFetchResult | type | 566–569 | yes | 0 | native.ts |
| fetchWithHeaderDeadline | async function | 571–589 | yes | 2 | native.ts |
| handleClaudeMessages | async function | 591–608 | yes | 4 | R |
| handleClaudeMessagesWithBudget | async function | 610–973 | no | 0 | replay.ts |
| estimateBase64AttachmentTokens | function | 978–983 | no | 0 | count-tokens.ts |
| estimateClaudeRequestTokens | function | 995–1035 | yes | 1 | count-tokens.ts |
| handleClaudeCountTokens | async function | 1037–1092 | yes | 1 | count-tokens.ts |

## Leaf partition

Counts are expected ceilings including moved comments and new import/export glue, to be measured during implementation. All five new leaves and the residual fit ≤400 without changing any function body. This is one proposed oversized pure-move layer, subject to the explicit size escalation above; no hidden #b is included.

| new file | symbols | origin slices incl. attached comments | expected lines |
|---|---|---|---:|
| `src/server/claude-messages/request-context.ts` | Rec, decodeClaudeFastSelector, isRec, buildClaudeReplayConfig, claudeInboundDisabled, readAnthropicBody, uuidFromHex | 63–114 + 178–182 = 57 | 70 |
| `src/server/claude-messages/body.ts` | anthropicUsageToOcx, PassthroughBodyGuard, PassthroughCloseReason, tapAnthropicSseForLog, DEFAULT_BODY_STALL_SEC, DEFAULT_BODY_MAX_BYTES, resolvePassthroughBodyGuard, BoundedPassthroughBody, readBoundedPassthroughBody | 184–364 + 461–552 = 273 | 285 |
| `src/server/claude-messages/native.ts` | PASSTHROUGH_STRIP_HEADERS, singleCredentialToken, hasAnthropicNativeCredential, wantsNativePassthrough, shouldForwardNativeHeader, anthropicNativePassthrough, HeaderDeadlineFetchResult, fetchWithHeaderDeadline | 116–176 + 366–459 + 554–589 = 191 | 210 |
| `src/server/claude-messages/count-tokens.ts` | estimateBase64AttachmentTokens, estimateClaudeRequestTokens, handleClaudeCountTokens | 975–1092 = 118 | 135 |
| `src/server/claude-messages/replay.ts` | handleClaudeMessagesWithBudget | 610–973 = 364 | 399 |

Residual original expected **45 lines**: keep header 1–8 and public wrapper 591–608 (26 source lines) plus up to 19 glue lines. Original 1,092 = 1,003 moved lines + 26 retained lines + 63 old import/spacing lines. Planned maximum footprint: 1,099 leaf lines + 45 residual = 1,144; 115 replacement glue lines versus 63 original import/spacing lines. Existing comments move, not disappear to game the limit. Replay gets ≤35 import/spacing lines; named imports from one module can share a line as existing source already does at :13/:34. If formatting expands it beyond 400, stop for a new partition decision rather than deleting comments or minifying the body.

`request-context.ts` is request-boundary policy and normalization, not a runtime context/state object. Export its seven declarations only as needed by real callers; the facade re-exports only buildClaudeReplayConfig. Own imports:

```ts
import type { OcxConfig } from "../../types";
import { AnthropicRequestError, resolveInboundModel } from "../../claude/inbound";
import { anthropicErrorResponse } from "../../claude/outbound";
import { readJsonRequestBody } from "../request-decompress";
import { isTranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
```

`body.ts` exports its existing public functions/type plus `anthropicUsageToOcx` and `PassthroughCloseReason` directly for native.ts; keep BoundedPassthroughBody private (as today, inferred through the exported function). Own imports:

```ts
import { sseFieldValue } from "../../lib/sse-decoder";
import { idleDeadline } from "../../lib/abort";
import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import { isRec, type Rec } from "./request-context";
```

`native.ts` exports its existing public type/function plus wantsNativePassthrough and anthropicNativePassthrough to count/replay, not through the facade. Own imports:

```ts
import { enforceAnthropicImageLimits } from "../../adapters/anthropic-image-guard";
import { normalizeAnthropicImages } from "../../adapters/anthropic-image-normalize";
import { resolveInboundModel } from "../../claude/inbound";
import { anthropicErrorResponse } from "../../claude/outbound";
import { clearableDeadline } from "../../lib/abort";
import type { OcxConfig } from "../../types";
import { addFinalRequestLog, type RequestLogContext } from "../request-log";
import { isApiAuthRequired, isDataPlaneAdmissionSecret, isProxyAdmissionSecret, type RequestPolicyView } from "../auth-cors";
import { isRec, type Rec } from "./request-context";
import { anthropicUsageToOcx, tapAnthropicSseForLog, resolvePassthroughBodyGuard, readBoundedPassthroughBody, type PassthroughCloseReason } from "./body";
```

`count-tokens.ts` keeps the two exported functions and nested sanitizeBlock/sanitizedMessages closures intact. Own imports:

```ts
import { sniffImageDimensions } from "../../adapters/anthropic-image-guard";
import { AnthropicRequestError, extractOcxRouteDirective, resolveInboundModel } from "../../claude/inbound";
import { stripOneMillionMarker } from "../../claude/context-windows";
import { captureClaudeInbound } from "../../claude/inbound-debug";
import { anthropicErrorResponse } from "../../claude/outbound";
import { estimateTokens } from "../../lib/token-estimate";
import { createTranslatorBudget } from "../../lib/translator-budget";
import type { OcxConfig } from "../../types";
import type { RequestPolicyView } from "../auth-cors";
import { parseFastOnlyRowId } from "../fast-row";
import { claudeInboundDisabled, readAnthropicBody, decodeClaudeFastSelector, type Rec } from "./request-context";
import { wantsNativePassthrough, anthropicNativePassthrough } from "./native";
```

`replay.ts` exports handleClaudeMessagesWithBudget for the original wrapper. Its body is moved whole, including its existing two dynamic imports (not converted to eager imports). Own static imports, grouped one line per existing owner:

```ts
import { FORWARD_HEADERS } from "../../adapters/openai-responses";
import { AnthropicRequestError, anthropicToResponsesTranslation, extractOcxEffortDirective, extractOcxRouteDirective, resolveInboundModel, type ClaudeCacheKeySource } from "../../claude/inbound";
import { resolveDesktop3pAlias } from "../../claude/desktop-3p";
import { recordDesktopRequest } from "../../claude/desktop-health";
import { stripOneMillionMarker } from "../../claude/context-windows";
import { captureClaudeInbound } from "../../claude/inbound-debug";
import { anthropicErrorBody, anthropicErrorResponse, collectAnthropicMessage, responsesJsonToAnthropicMessage, responsesSseToAnthropicSse } from "../../claude/outbound";
import { isTransientUpstreamStatus } from "../../lib/upstream-retry";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { NoEligiblePolicyCandidateError, routeModel } from "../../router";
import { evidenceFromBody } from "../../routing/request-evidence";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import type { OcxConfig } from "../../types";
import { addFinalRequestLog, httpStatusForRequestLogTerminal, recordFirstOutput, type RequestLogContext, type RequestLogEntry } from "../request-log";
import { conversationIdFromClaudeMetadata } from "../request-log-conversation";
import { responseWithDeferredRequestLog } from "../relay";
import { handleResponses } from "../responses";
import type { RequestPolicyView } from "../auth-cors";
import type { AdmissionLease } from "../../lib/admission";
import { tryClaimNativeMainProfileForTurn } from "../../codex/native-main-admission";
import { CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE } from "../../codex/auth-context";
import { isTranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
import { parseRequestEffortRowId, type ParsedEffortRowId } from "../effort-row";
import { parseSyntheticRowId, type ParsedFastRowId } from "../fast-row";
import { claudeInboundDisabled, readAnthropicBody, decodeClaudeFastSelector, isRec, uuidFromHex, buildClaudeReplayConfig, type Rec } from "./request-context";
import { wantsNativePassthrough, anthropicNativePassthrough } from "./native";
import { estimateClaudeRequestTokens } from "./count-tokens";
```

Dynamic path-only rewrites inside the otherwise unchanged body: origin `:761`, `import("./effort-policy")` → `import("../effort-policy")`; origin `:787`, `import("../codex/main-account")` → `import("../../codex/main-account")`. Their await position and gating stay identical. The existing parseRequestEffortRowId binding at origin :54 is unused by this function; retain or remove only as import bookkeeping, never substitute it for the current parseSyntheticRowId behavior.

## Re-export block

Add these exact lines at the original `src/server/claude-messages.ts` path:

```ts
export { buildClaudeReplayConfig } from "./claude-messages/request-context";
export { tapAnthropicSseForLog, resolvePassthroughBodyGuard, readBoundedPassthroughBody } from "./claude-messages/body";
export type { PassthroughBodyGuard } from "./claude-messages/body";
export { fetchWithHeaderDeadline } from "./claude-messages/native";
export type { HeaderDeadlineFetchResult } from "./claude-messages/native";
export { estimateClaudeRequestTokens, handleClaudeCountTokens } from "./claude-messages/count-tokens";
```

`handleClaudeMessages` remains an exported local declaration with exactly its current signature/body. All **10** original exported identifiers are preserved (eight values and two types). Do not expose handleClaudeMessagesWithBudget or formerly private helpers through the facade.

Explicit local imports needed by the retained wrapper (re-exports bind nothing):

```ts
import type { OcxConfig } from "../types";
import type { RequestLogContext } from "./request-log";
import type { RequestPolicyView } from "./auth-cors";
import type { AdmissionLease } from "../lib/admission";
import { createTranslatorBudget, finalizeTranslatorBudgetResponse } from "../lib/translator-budget";
import { handleClaudeMessagesWithBudget } from "./claude-messages/replay";
```

## Module-level state and cycles

- `PASSTHROUGH_STRIP_HEADERS`, origin `src/server/claude-messages.ts:124–128`: exactly one Set owner, native.ts. Keep the names and membership checks unchanged; no second header filter or copied Set in count/replay.
- `DEFAULT_BODY_STALL_SEC` (`:461`) and `DEFAULT_BODY_MAX_BYTES` (`:462`): sole owner body.ts, values unchanged. No other top-level let, Map, WeakMap, mutable store, lock, or timer exists.
- The SSE decoder, buffer, usageAcc, reader, settled/bodyBytes/controller, idle deadline and abort listener are closure-owned inside tapAnthropicSseForLog (`:230–309`), which moves whole to body.ts. Do not hoist them to module scope or duplicate settlement ownership.
- Native `logged` and finalize closure (`:378–383`) move whole with anthropicNativePassthrough. Replay's nativeLogged/finalizeNativeLog (`:818–823`) stay together in replay.ts. These are distinct per-request paths, not one shared module flag.
- readBoundedPassthroughBody's stalled/aborted flags and idle deadline (`:504–521`) move with its body/finally. The public wrapper still creates the TranslatorBudget (`:598`), finalizes returned responses, and disposes on thrown errors (`:604–607`); the count endpoint keeps its separate budget/finally (`:1046–1052`). No additional owner is introduced.
- Cycle trap: native needs body guard types/functions and usage conversion; putting these in the facade would create native → facade → replay → native. They live in body.ts instead. Body's Rec/isRec dependencies point only to request-context, not native or the facade. Request-context imports existing inbound, not the server entry.
- Another cycle trap: replay calls estimateClaudeRequestTokens (`:753`). Count-tokens may call native/request-context but must not import replay. The estimator and count endpoint can coexist in one leaf because that edge remains one-way.
- Lane 011 reported no literal-graph cycle. Preserve dynamic credential/effort edges and verify no new static, type-only or literal-dynamic return path. Existing request-context/logCtx passing is unchanged functional/sequential coupling; first-wins finalization is temporal coupling retained within its closure. This plan neither adds a global state container nor performs credential-policy cleanup.

## Tests

Exact behavioral importer list from `rg -l '/claude-messages["\x27]' tests` (sorted). All **unchanged** at the original path:

| test file | import/use line | disposition |
|---|---:|---|
| `tests/claude-integration/claude-messages-endpoint.test.ts` | 17–24 | unchanged |
| `tests/claude-integration/claude-sidecar-override.test.ts` | 3 | unchanged |
| `tests/providers/cursor/cursor-effort-rows.test.ts` | 13 | unchanged |
| `tests/routing/routing-policy-surface-parity.test.ts` | 122 dynamic import | unchanged |
| `tests/server/fetch-header-timeout.test.ts` | 173 dynamic import | unchanged |

Direct text oracles: **none found** by `rg -n 'claude-messages|claude-messages.ts' tests` and full/segmented-path read inspection, consistent with lane 011. In particular fetch-header-timeout imports the function; it does not read this source text. The comment in `tests/codex-integration/codex-auth-context.test.ts:2169` and comments in `tests/providers/deepseek-inbound-wire.test.ts:215` / `tests/providers/xai/xai-transport.test.ts:644` are not source reads. Do not invent a retargeting patch based on 001's coarse “1” textoracle summary.

Transitive source oracle: `tests/codex-integration/compatibility-manifest.test.ts:61`, `readFileSync(current, "utf8")`, reached through its server/index root at :184 and `src/server/index.ts:178`. **Unchanged**: the import/re-export walker automatically discovers native/body/count/replay/request-context. No `retarget-to-leaf` or `add-leaf-to-scan-list` is needed. Guard sensitivity during implementation: temporarily add a static named re-export from `../../compatibility/manifest` in `src/server/claude-messages/replay.ts`; this test must fail with the forbidden chain. Remove the probe and rerun green. Do not commit it.

`tests/lab/core-lab-boundary.test.ts:69` reads its protected reachable graph; :355 separately reads server/index for activation-order checks. The inspected PROTECTED roots do not reach claude-messages, so this is a mandatory server gate, not a direct source oracle to retarget. Leave PROTECTED and activation ordering untouched. Run existing boundary self-tests; do not add this facade to PROTECTED to manufacture coverage.

Drive existing behavior guards red once after moves, then restore and obtain green: remove native.ts's deadline.clear() (origin :587) to trigger `tests/claude-integration/claude-messages-endpoint.test.ts:354`; alter body.ts's overflow comparison (origin :333) to trigger the A2 test at :468. Credential, native-main enrichment, fast/effort, count estimates, and cache provenance remain covered by the unchanged endpoint suite (:639, :767, :819, :888, :1180–1300) and the routing/cursor suites. No test is executed by this docs task. If new tests become necessary, the executor must account for both test-layout registries and request scope expansion rather than silently adding files.

## Verification

**Do not execute this layer until the changeset-size escalation is resolved.** Then run only in the dedicated layer worktree, based on the current L1 tip. Domains: claude-integration, server, providers/cursor, routing, codex-integration, lab. Instantiated 002 gate:

```sh
bun run typecheck
bun test tests/claude-integration tests/server/fetch-header-timeout.test.ts tests/providers/cursor/cursor-effort-rows.test.ts tests/routing/routing-policy-surface-parity.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/server/claude-messages.ts src/server/claude-messages/request-context.ts src/server/claude-messages/body.ts src/server/claude-messages/native.ts src/server/claude-messages/count-tokens.ts src/server/claude-messages/replay.ts
rg -n '/claude-messages["\x27]|from "./claude-messages"' src gui/src scripts tests
git diff --check
git diff --numstat codex/split-claude-inbound...HEAD -- src
```

Compare the six original-path importer identities before/after, not merely a static `from` count that misses dynamic test imports. New leaf imports are additional dependencies, not a reason to accept missing public consumers. Verify the exact re-export set and both dynamic path rewrites. Scan each leaf's imports and compare the reachable graph for new cycles, including type/dynamic edges; typecheck is not a substitute. No standalone cycle tooling installation is authorized by this docs task.

Full suite is **never local**. Parent-approved remote checkout and exact layer branch:

```sh
ssh lidge 'set -e; cd ~/ocx-ci/opencodex; git fetch origin codex/split-server-claude-messages; git checkout -q FETCH_HEAD; git rev-parse HEAD; bun install --frozen-lockfile >/dev/null; bun run test'
```

Match the printed remote SHA with the recorded PR head; retain the actual test exit status rather than letting 002's illustrative `| tail -15` mask it. Save focused test counts, sensitivity red/green results, typecheck/privacy statuses, file sizes, full remote result, actual diff size and the authorized exception/revised map, plus exact-head CI rollup. No gates were run during planning; this document records instructions, not successful implementation. Fresh read-only Node/ast-grep checks on 2026-09-05 confirmed nine ordered headings, all 29 exact declaration ranges, 10 public identifiers, all named test paths present, 71 relative import/re-export paths resolving to existing or explicitly planned files, and no trailing whitespace (exit 0).

## Accept criteria

1. Parent explicitly resolves the incompatibility between one L2 and the 500-changed-source-line cap. Without recorded authorization/revised topology, this plan is not executable or review-ready.
2. Exactly the five proposed leaves contain the 28 moved declarations; handleClaudeMessages alone remains as the original local declaration. Every one of the 29 inventoried declarations has one owner.
3. Every new file and residual is ≤400 lines; expected residual 45 and replay ceiling 399. No undeclared #b remains and no body/comment compression is used to force the size gate.
4. All 10 original exported identifiers, parameter defaults, error-class identity, and six original importer files are preserved; internal-only names are not added to the facade.
5. Credential checks, dynamic import timing, request-policy propagation, budget ownership/disposal, log-tap placement, cancellation/timeout first-wins behavior, image normalization and token-estimation bodies remain unchanged.
6. No leaf imports the original facade; no new static/type/literal-dynamic cycle exists, no optional Lab/catalog dependency enters a protected runtime path, and PROTECTED is unchanged.
7. The transitive oracle still reads moved leaves and its temporary negative probe fails once; restored source passes the instantiated gates, remote full suite and CI at the exact layer head. Local full suite is never run.
8. PR base is codex/split-claude-inbound, its commits contain the current lower-layer tip, all template sections and the full two-layer map are filled, and no merge is performed.

## PR

Title: `refactor(server): separate Claude transport from translated replay (split S08 L2/2)`

Branch: `codex/split-server-claude-messages`. Base: `codex/split-claude-inbound`. Closes: none.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. The Summary must disclose the parent-approved size exception or revised layer topology; do not claim compliance before it exists. Review only this layer's diff.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S08-L2 | server Claude messages ← this layer | `codex/split-server-claude-messages` | `codex/split-claude-inbound` | native/body/count/replay ownership |
| 1 | #TBD-S08-L1 | inbound | `codex/split-claude-inbound` | `dev` | option leaves and stable inbound exports |

Depends on #TBD-S08-L1. Parent owns any cascade after an L1 edit and must renew exact-head evidence. DEV-STACK-04 merge authorization is separate; this delegated task performs no Git mutation, push, PR creation, or merge.

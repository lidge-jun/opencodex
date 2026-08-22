# CL-01 independent acceptance review

Reviewer posture: adversarial. Scope: deterministic protocol conformance harness only.

**Revision note:** CL-01 was **accepted earlier** at `cc447ce9d19d5fb4e03988899f5fb495f9de8d0e` against pre-remediation CL-00 tip `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66`. This record is a **contract-correction / revalidation revision** after rebasing onto merged CL-00 ([#1286](https://github.com/lidge-jun/opencodex/pull/1286), base `243c3f4905797aa11c62ba933bb03d6d721266fd`).

## Invalidated earlier assumptions

| Earlier CL-01 assumption | Final CL-00 correction |
|---|---|
| Chat upstream tool results correlate via synthetic Responses `input[]` in observations | Real Chat wire: `/upstream/requests/N/json/messages/M/tool_call_id` |
| SSE `[DONE]` inferred from client surface labels (`responses-sse`, etc.) | Sentinel follows **source protocol** of normalized byte stream; only `openai-chat` recognizes `[DONE]` |
| Expanded manifests without synthetic marker/provenance | Mandatory `syntheticMarker: "ocx-lab-synthetic-v1"` + `lab_authored` provenance in every fixture ref |
| MCP scenarios implicit / unspecified | Four closed action tokens with deterministic semantics |
| Obsolete manifest digests from pre-provenance expansion | All scenario manifest digests recomputed with provenance fields |

## Removed workaround

The harness **removed** `normalizeUpstreamObservationJson()` Chat `messages[]` → synthetic Responses `input[]` projection. Observations now record actual upstream JSON from shipped adapters. Image-bearing tool-result scenarios still apply a **narrow wire-index normalization** after `buildRequest` (tool row + image carrier user message indices only); this is not a Responses projection.

## Challenge results (revalidation)

| # | Challenge | Result |
|---|---|---|
| 1 | Harness exercises shipped parser/translation, not a parallel stack | **PASS** — executor calls `parseRequest`, `createOpenAIChatAdapter`, `createResponsesPassthroughAdapter`, `bridgeToResponsesSSE`, `responsesSseToAnthropicSse`, and `expandPreviousResponseInput`. |
| 2 | Negative controls genuinely fail | **PASS** — eight deliberate broken fixtures reject (`runNegativeControls` 8/8). |
| 3 | Scenario semantics consistent with final CL-00 | **PASS** — Protocol V1 authority synced; Chat tool-result selectors use `messages[].tool_call_id`; no Responses `input[]` fabrication. |
| 4 | Malformed/partial streams cannot accidentally pass | **PASS** — malformed SSE negative control fails; truncated tool args fail `tool_call_equals`. |
| 5 | Tool IDs and tool-result correlations verified | **PASS** — `tools-core.protocol.function-round-trip`, `codex-core.protocol.apply-patch-turn` use Chat wire selectors. |
| 6 | Parallel tool fragments handled | **PASS** — `tools-core.protocol.parallel-correlation` and `nonoverlap_order` verifier. |
| 7 | Custom/freeform tools covered | **PASS** — `apply_patch` via `freeformToolNames` in bridge. |
| 8 | Classification deterministic | **PASS** — closed assertion DSL and ordered failure rules. |
| 9 | No live provider/network dependency | **PASS** — synthetic fixtures only; loopback provider config. |
| 10 | No CL-02 functionality leaked | **PASS** — no ledger, SQLite, CLI probe, or live runners. |
| 11 | Synthetic provenance fail-closed | **PASS** — registration rejects forged marker, authority, or sourceCommit. |
| 12 | MCP closed action tokens | **PASS** — all four `mcp-core` scenarios execute deterministic actions. |
| 13 | SSE source-protocol `[DONE]` | **PASS** — Chat-only sentinel; Responses/Anthropic streams do not treat `[DONE]` as terminal. |

## Validation (2026-08-09, Windows/Bun 1.3.14)

- `bun x tsc --noEmit`: passed
- `bun test tests/lab-conformance-harness.test.ts`: **14/14** passed (24 canonical + 8 negative controls + provenance + SSE + MCP + manifest tests)
- `git diff --check`: passed (after correction)
- Full `bun run test`: not re-run (known Windows/Bun baseline failures documented under CL-00)

## Verdict

**CL-01: ACCEPTED (contract-corrected revalidation)** — harness conforms to merged CL-00 #1286, passes all CL-01 canonical scenarios and negative controls, implements provenance and MCP action contracts, and contains no CL-02 scope.

**CL-02: NOT STARTED.**

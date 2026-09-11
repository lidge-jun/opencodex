# wp1: Go compatibility residuals

Historical phase record. Delivery is complete; see [071](071_delivery.md) and [072](072_final_proof.md) for terminal evidence.

Depends on wp0. C3 with independent boundary review. Source PR #3838 head `d84e5a80a5e40a65462a0466d82cdcec463a847e`; baseline dev `9e1468d4b7a41b498ed2aca98507ada2c741afea`. #3942 already landed the generic array agent-message normalizer. Reimplement the remaining Go behavior on current owners; do not restore the removed `opencode-go.ts` or duplicate namespace logic.

## Main decisions

Carry Go additional-tools placement and the canonical preset's stateless intent. Retain current all-parts readable/fail-closed agent-message behavior; the old lossy mixed-content hunk is deliberately declined because successful transport alone does not prove complete task content. Original PR disposition must name that decision rather than claim every historical hunk landed. Custom renamed providers retain explicit configuration semantics; no destination-based configuration migration is added.

## File changes

- NEW `src/adapters/opencode-go-additional-tools.ts`: export a small immutable placement helper taking body and base URL. Match HTTPS `opencode.ai`, standard port, exact `/zen/go/v1` (optional terminal slash); reject credentials/query/fragment and other paths. For valid `additional_tools` array wrappers append their already-normalized tools to top-level tools and remove the wrapper. Preserve unrelated input and supported nameless hosted tools. Non-array malformed wrappers remain unchanged; no valid wrappers returns the original body. Existing namespace/custom owners perform identity lowering and dedupe before this pass.
- MODIFY `src/adapters/openai-responses.ts`: import helper; invoke only inside non-forward dispatch after existing namespace/custom/search lowering around baseline line 2455, before code-mode/compaction and later hosted-tool pruning. Response alias maps stay owned by prior normalization.
- MODIFY `src/providers/registry.ts`: canonical `opencode-go` entry gains `statelessResponses: true`. Existing derive logic seeds/backfills only absent values; explicit false remains authoritative.
- MODIFY `tests/providers/opencode-go-grok46-responses.test.ts`: replace the old expected private wrapper with promoted tools; cover duplicate containers, distinct namespace same-name children, custom/function handling, hosted Luna search versus Go Grok denial, tool_choice none/allowed list, tool_search_output activation, forward/Zen/lookalike/wrong-port exclusion and immutable replay.
- MODIFY `tests/providers/opencode-go-luna-wire.test.ts`: cover seed/backfill/false, full-history continuation with synthetic reasoning and paired tool results; assert previous_response_id removed, store false, call pairing/history retained. Cover stateless orphan and reasoning-summary interactions through existing focused suites. No new test file is required if these current owners remain reviewable.
- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md` and `structure/04_transports-and-sidecars.md`: record Go wrapper placement and canonical stateless default with explicit override and full-history limits. Update only contradicting translated statements.

## Before / after flow

Before: namespace normalization leaves valid declarations inside `input.additional_tools`; strict Go receives a private wrapper. After: the same normalized declarations appear in `tools`, and valid wrappers are removed. Before: canonical Go may forward previous_response_id with replay history. After: existing stateless normalization strips the stored-continuation parameters and sends complete history.

## Activation and observable coverage

Use production adapter fixtures, not a duplicate normalizer oracle. Namespace alpha.lookup and beta.lookup must both remain callable; duplicate wire identities follow the existing canonical owner. Nameless hosted tools must survive placement until provider/model pruning. Malformed wrapper, unapproved destination and forward controls stay byte-identical. Seed false must differ from default true. A two-turn synthetic continuation must preserve meaningful reasoning/tool history while removing stored-state references. Inspect existing stateless orphan repair and summary tests; extend any missing Go model coverage without weakening assertions.

Hosted verification: PR CI covers changed runtime and provider suites, with final full dispatch before integration. Local product tests/install/typecheck/build are NOT RUN. Preserve original PR account-linked Co-authored-by credit; resolve identity from GitHub before commit. The full source investigation is in ignored `.tmp/bug6-01a07e9d/go-xai-plan.md`; it is not public implementation proof.

## wp1 P refresh

Previous wp0 D directs Go residual implementation. During live refresh dev advanced to c15662855 (#3975), changing only tests/codex-integration/codex-prompt-text-probe.test.ts. Hook-disabled merge incorporated that unrelated probe fixture correction before B; Go owners and this design are unchanged. The initial A narrative said unchanged dev based on the pre-fetch snapshot; this entry corrects it.

## C audit foldback and repair plan

Independent review at 9b42c1a80 found two blockers. F1 accepted: the stateless flag enables content-to-summary output normalization, but the continuation cache records original output; full-history overlap then fails. The adapter-only full-history fixture bypassed the affected server boundary. F2 accepted: baseUrl-only matching misses split/endpoint-inclusive configurations and can affect an overridden non-Go resource. Neither finding conflicts with preserving opaque items or existing fail-closed policy.

Repair F1: MODIFY `src/server/responses/core.ts` at `rememberPassthroughResponseChecked` only. After current namespace/custom/function restoration, apply existing `rewriteReasoningSummaryInJson` under the same `hideThinkingSummary !== true && routeUsesContentChannelReasoning(provider, model)` condition as client output, then record that representation. Preserve item content and IDs under the existing opaque-item rule; do not weaken overlap comparison or use ID-only matching. This aligns stored output with the actual client serialization for SSE and JSON. Extend the current Go server fixture to send actual full-history plus previous_response_id and assert each prior call/message occurs exactly once; retain delta replay and hiding/opaque controls. The shared callback is an explicit narrow scope expansion required by this newly activated path, not unrelated state refactoring.

Repair F2: the helper now accepts the final resolved Responses request URL already built by the adapter. Match exact origin and `/zen/go/v1/responses`, rejecting userinfo/query/fragment. Positive fixtures cover normal base, endpoint-inclusive base and split custom path; negative fixtures cover an override resolving to Zen/non-Go and assert both actual request URL and body. Update destination wording in docs and preserve all prior host/port/immutability controls.

Re-review the repaired diff with the same implementation auditor; retain CI failures and repair evidence. No local product commands are authorized.

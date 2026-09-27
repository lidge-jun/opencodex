# 040 — acceptance and rollout (PF-12)

## Rollout order

1. Existing execution is the default. Every `protocols.rollout.*` switch is off.
2. `shadowPlan` on: the Chat and Messages ingresses record the dispatch-basis plan input at their
   entry mark (`src/protocols/shadow-plan.ts`); at finalize the pure planner runs on it and the
   plan for the settled route is compared with the observed trace (`src/protocols/shadow.ts`); a
   disagreement sets `planMismatch: true` on the trace. No second request is ever sent.
3. Per-target opt-in: `nativeChatCombos`, `managedMessagesNative`, `directEncoders`, then
   `managedMessagesNativeOAuth`.
4. A switch's default flips only after its scenarios below have recorded evidence on a merged
   head, in a separate reviewed change.
5. `unrepresentable: "reject"` is an operator policy, not a rollout step; it stays opt-in.

## Acceptance scenarios

Status vocabulary, per row: **implemented behind switch** (code on this stack, reachable only with
the named switch on), **default path** (what runs with every switch off, unchanged by this unit),
**not implemented** (the target shape does not exist yet), **test written (not run)** (unit tests
on this stack name the behavior; none were executed by the packet that wrote them unless its PR
says so), **pending live evidence** (no fixture or live run has been recorded against a merged
head). No row has recorded evidence. Test files are named so a reviewer can run them; naming a
file is not a claim that it passed.

| Scenario | Accepted when | Status |
|---|---|---|
| Chat → Chat, `n=2` / `logprobs` | every choice and logprobs survive; direct and combo give the same upstream body; every choice terminal is honoured | direct: default path (native Chat lane). Combo: implemented behind `nativeChatCombos`. Test written (not run): `tests/responses/chat-native-combo.test.ts`. Pending live evidence |
| Chat → Responses, `n=2` | under `reject`, refused before any send with `unsupported_feature`; never reduced to one choice and never emulated with extra calls | implemented behind `unrepresentable: "reject"` for direct routes; combos only with `nativeChatCombos` on. Test written (not run): `tests/responses/protocol-ingress-guard.test.ts`, `tests/responses/protocol-guard.test.ts`. Pending live evidence |
| Messages → Messages (managed key) | source blocks and declared options (`top_k`, `cache_control`, `thinking`) survive; caller-forward, managed key and OAuth stay separate authority cases | managed key: implemented behind `managedMessagesNative`. OAuth: not implemented on this stack (PF-10). Test written (not run): `tests/claude-integration/messages-native.test.ts`, `tests/adapters/anthropic/anthropic-messages-passthrough.test.ts`, `tests/responses/messages-native-eligibility.test.ts`. Pending live evidence |
| Messages → Chat | role order and tool pairing preserved; unsupported fields follow policy | default path only (legacy bridge through the existing translators); the direct `messages,ir,chat` codec is not implemented. Pending live evidence |
| Chat → Messages | function definitions/results map to content blocks; stop reason and usage mapped | default path only (legacy bridge); the direct `chat,ir,messages` codec is not implemented. Response side: implemented behind `directEncoders`, test written (not run): `tests/responses/protocol-direct-encoders-messages.test.ts`. Pending live evidence |
| Responses → Chat / Messages | continuation and compaction unchanged | default path; this unit does not change the Responses ingress. Pending live evidence |
| Mixed combo failover | every attempt built from the source envelope; send budget shared; affinity kept; ineligible candidates skipped with a recorded reason; no resend after partial stream output | implemented behind `nativeChatCombos` (Chat only). Known gap: a native child's zero-output in-band failure does not hop (inventory below). Test written (not run): `tests/responses/chat-native-combo.test.ts`. Pending live evidence |
| `stream: false` / `true` | correct envelope, error frames, terminal, chunk boundaries, backpressure, cancellation, timeout, memory budget | native lanes: default path (Chat) and behind `managedMessagesNative` (Messages). Encoders: implemented behind `directEncoders`. Test written (not run): `tests/responses/protocol-direct-encoders-chat.test.ts`, `tests/responses/protocol-direct-encoders-messages.test.ts`, `tests/server/inference-client-encoder-delivery.test.ts`. Pending live evidence |
| Unknown extension or media | never silently dropped on a translated path without a recorded effect | declared features only: effects recorded on the trace (default path) and refused under `reject`. Undeclared fields have no feature name and record no effect (managed Messages allowlist). Test written (not run): `tests/responses/protocol-trace.test.ts`, `tests/responses/protocol-features.test.ts`. Pending live evidence |
| Dashboard and remote runtime | stale/unknown/unsupported distinguished; per-request trace; policy-revision mismatch visible; hash state survives Back/Forward | per-request trace, preview with its policy revision, and deep links: implemented (PF-02, PF-03, PF-11). `planMismatch` is recorded but not rendered by the dashboard. Remote runtime: not exercised. Test written (not run): `tests/usage/request-log-protocol-trace.test.ts` and the PF-11 GUI tests. Pending live evidence |
| API disable migration | `/v1/messages` and `count_tokens` agree; upgrade, old-UI writes and rollback never reopen a closed surface | implemented (PF-04, default path). Test written (not run): `tests/claude-integration/messages-surface-matrix.test.ts`, `tests/server/protocol-settings-route.test.ts`. Pending live evidence |
| Shadow plan | disagreement between the dispatch plan and the trace is marked; no second request; switch off changes nothing; a failing comparison never affects the log row | implemented behind `shadowPlan` for the Chat and Messages ingresses. Test written (not run): `tests/responses/protocol-shadow-plan.test.ts`. Pending live evidence |
| CLI parity | every protocol management route has a CLI verb; `ocx api policy` writes only when a setting flag is given | implemented (`ocx api protocols`, `explain`, `policy`). Test written (not run): `tests/cli/cli-api-protocols.test.ts`, `tests/cli/cli-capabilities.test.ts` |

Verification runs in isolated fixtures with no access to a user's home, credentials or services.
Live provider probes happen only with a consenting operator's keys and budget and are recorded
separately from fixture results.

## Not-migrated inventory

Kept current by each packet that migrates something. Checked against the code on the PF-12
branch (`feat/pf12-protocol-rollout`); PF-10 is developed in parallel and is not on this stack.

| Path | State after this unit |
|---|---|
| Chat/Messages request decode | still produces a Responses-shaped body before the IR (`responses-internal`) on every non-native path; `src/protocols/codecs/*` are named entry points over the existing translators (`chatCompletionsToResponsesBody`, `anthropicToResponsesTranslation`), not direct codecs |
| Chat ↔ Messages direct codecs | not implemented: `chat,ir,messages` and `messages,ir,chat` are baseline targets only; both pairs travel `responses-internal` |
| Chat/Messages response encode (PF-09) | migrated behind `directEncoders` only where `directEncodersApply` and `clientEncoderForDelivery` both agree: one concrete, non-Responses-wire route in the streaming adapter delivery, giving response path `[upstream, ir, client]` while the request path stays the bridge path. Still through `responses-internal`: combo and policy children (`comboAttempt`, `routeKind` combo/policy), routed compaction, run-turn adapters (Cursor, Devin, coding-agent CLIs, CodeBuddy), sidecar turns, the buffered `parseResponse` branch (unused by these ingresses, which always stream internally), and every route while the switch is off. Responses-wire upstreams keep their existing codec path |
| Policy-route children | not migrated (PF-07): `routeModel` evaluates the policy and returns one concrete candidate, so a policy request never reaches the combo child loop and keeps the Chat bridge |
| Chat combos with `nativeChatCombos` off | bridge for every candidate, and not judged per candidate under `reject` (the ingress guard also skips combos) |
| Chat combos reached through an effort row | bridge (PF-07): the row's effort lives only on the Responses body, so the native source is not supplied |
| Native Chat combo child, streamed, zero-output in-band failure | no hop (PF-07): the child's 200 is committed without `preflightComboStreamResponse`, so a failure frame before any output reaches the client instead of the next target; the bridge child would have hopped |
| Messages combos and policies | bridge: `nativeMessagesDeclineReason` returns `combo-or-policy-route`; not judged per candidate under `reject` |
| Sidecars (web search, vision, image generation) | Responses pipeline only |
| Responses-only features on Chat/Messages | `previous_response_id`, `store`, `background`, compaction stay on the bridge |
| Non-public-wire adapters (`other`) | translated through the IR; no feature claims |
| OAuth native Chat | not planned in this unit |
| Messages → key-auth Anthropic | native behind `managedMessagesNative` (PF-08); bridge while off. Caller `anthropic-beta` passes only through the PF-10 allowlist (`interleaved-thinking-2025-05-14` to `api.anthropic.com`, nothing to a compatible host); a dropped value is traced as `anthropic-beta-dropped`, never by value. Top-level fields outside the allowlist are dropped with no feature effect |
| Messages → Anthropic OAuth | native behind `managedMessagesNativeOAuth` (PF-10) for the unpooled `anthropic` provider on `api.anthropic.com`; bridge while off |
| Messages → pooled Anthropic OAuth | not migrated (PF-10): `anthropicAccountPool.enabled` or two usable stored accounts decline with `oauth-account-pool`, because rotation, session affinity and quota ranking live in the Responses transport |
| Opaque thinking state on the native lane | signatures and `redacted_thinking` reach `api.anthropic.com` only; elsewhere removed and traced as `opaque-state-stripped` (reason code, not a feature effect: a same-wire hop has no degraded disposition), refused before any send under `reject` |
| Messages native lane, translated-only steps | a pinned route effort, blocked-skill elision, the web-search sidecar and vision preprocessing keep the request on the bridge (`bridge-only-policy` / `vision-preprocessing`); `stabilizePromptCache` is a recorded gap — the native lane does not apply it |
| Shadow plan coverage | Chat and Messages ingresses only; the Responses ingress records no shadow input. The response path is not compared (the planner does not model `directEncoders`); caller-forward Messages passthrough and compatibility rejects are not compared. The planner cannot see body-dependent Messages decline rules (skill elision, web search), so those surface as `planMismatch` rather than being predicted. The Claude fast-selector decode used by the ingress is not applied by the snapshot. The dashboard does not render `planMismatch` |

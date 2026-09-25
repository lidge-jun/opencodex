# Protocol Paths

How a request on one public inference API reaches an upstream wire, in shared vocabulary. The
transport behavior of each ingress stays owned by [Inbound Compatibility Surfaces](inbound-compat.md)
and [Responses transport](../transports/responses.md); this doc owns the names, the declared
feature dispositions and the baseline those docs are measured against.

## Vocabulary and leaf modules

`src/protocols/contract.ts` defines the three public protocols (`responses`, `chat`,
`messages`), the upstream wires (the protocols plus `other` for every adapter whose body is none
of them), path hops (`ir` for `OcxParsedRequest`/`AdapterEvent`, `responses-internal` for
Responses JSON/SSE produced only as an internal bridge), the delivery modes and a closed list of
reason codes. A path containing `responses-internal` is `legacy-bridge`; a two-hop path with the
same wire at both ends is `native`; any other path is `translated`; `blocked` means refused
before any send and has no path.

Existing spellings keep their names and map through explicit functions in the same file: routing
`InboundWire` "anthropic" is `messages`, adapters `openai-responses` / `openai-chat` /
`anthropic` are the three protocol wires, and Lab identities `openai-responses` / `openai-chat`
/ `anthropic-messages` map one to one. Persisted rows are not rewritten.

`nativeChatDeclineReason` in `src/server/chat-native-eligibility.ts` names, as one of these
reason codes, the first rule that keeps a Chat request off the native Chat lane;
`isNativeChatRouteEligible` is defined as "no reason", so the lane decision and the reason a plan
or trace reports cannot disagree. `nativeMessagesDeclineReason` in
`src/server/messages-native-eligibility.ts` does the same for the managed native Messages lane
(below).

`contract.ts`, `src/protocols/features.ts`, `src/protocols/baseline.ts`,
`src/protocols/path.ts`, `src/protocols/dto.ts`, `src/protocols/plan.ts` and `src/protocols/guard.ts` are leaf modules: the dashboard imports them directly, so they import
nothing but each other and the type-only compatibility vocabulary in
`src/compatibility/manifest.ts`. `tests/responses/protocol-contract.test.ts` reads their import
specifiers and fails on anything else.

`src/protocols/path.ts` turns an ingress lane (`native` or `bridge`) and the final adapter's
upstream wire into the request and response paths. The observed trace and the planner both
call it, so a preview and the log of the same request apply one rule.

## Feature dispositions

`src/protocols/features.ts` lists the request features whose survival depends on the path, the
protocols that can express each, and a declared disposition for every cross-wire hop, reusing
the compatibility-manifest vocabulary (`passthrough`, `translated`, `degraded`, `unsupported`).
Same-wire hops are passthrough. A hop into `other` has no entry, and an absent entry is how
unknown is spelled — never as a fifth disposition. `featureEffectsForPath` reports, for the
features a request carries, the worst disposition met along its path, keeping a loss declared on
a known hop even when a later hop is unknown.

The current-code claims follow the translators: `chatCompletionsToResponsesBody` in
`src/chat/inbound.ts` copies an explicit field list without `n`, `logprobs`, `logit_bias`,
`seed`, `audio` or `prediction`, and `src/claude/inbound.ts` drops `top_k` and maps a thinking
budget to an effort tier. `tests/responses/protocol-features.test.ts` pins them. These are
declared claims, not Lab evidence, and never imply a verified verdict.

## Baseline

`src/protocols/baseline.ts` holds eighteen cells — three ingresses, three protocol upstreams,
streaming on and off — each with the path an eligible single-provider route takes today and the
path the protocol-first-class work targets. Today Chat to Chat and Responses to Responses are
native, Chat and Messages reach a Responses upstream through their codec directly, and every
other Chat or Messages pair (including Messages to a proxy-managed Anthropic key) travels through
`responses-internal`; every routed Chat or Messages path streams internally and folds for a
non-streaming client. No target cell contains `responses-internal`. `current` describes the
default configuration, with every rollout switch off.
`tests/responses/protocol-baseline.test.ts` pins both sides.

## Plan and trace shapes

`src/protocols/dto.ts` defines `ProtocolPlanV1` (a prediction: one candidate per route target,
features guaranteed by every eligible candidate, features only some preserve) and
`ProtocolTraceV1` (an observation: final mode and paths, reason codes, feature effects, one entry
per physical attempt). Both carry only the closed vocabulary and identifiers the server already
exposes, within fixed limits, and both validators reject anything that is not exactly version 1.

## Observed trace

`src/protocols/trace.ts` is server side and is not a leaf. The Chat Completions ingress
(`src/server/chat-completions.ts`) marks the lane it chose, the reason code that declined the
native lane, and the request's features; the Messages ingress (`src/server/claude-messages.ts`)
marks caller-forward passthrough and the managed native lane as native, the translated path as
the bridge, and a disabled surface or a compatibility reject as blocked. The Responses ingress needs no mark: its
path follows the final adapter's wire. Marks live in WeakMaps keyed by the request log context
and the live attempt objects, and no mark function throws into the request.

`addFinalRequestLog` derives one `ProtocolTraceV1` through `path.ts`: a blocked mark wins with
empty paths; otherwise each attempt gets the lane-derived path (or an explicit attempt mark),
the final attempt sets the row's mode and paths, a reason implied by the path is appended to the
entry's reasons, and feature effects come from `featureEffectsForPath`. No attempt and no native
or blocked mark yields no trace; nothing is guessed. The usage row persists the trace and every
read re-validates it with `parseProtocolTraceV1`, so an older or corrupt row hydrates without
one. `/api/logs` spreads the entry and accepts `protocolMode`
(`native | translated | legacy-bridge | blocked | none`) in `src/server/request-log-filter.ts`;
an unknown value matches nothing. The dashboard renders it with
`gui/src/components/protocols/` (a row badge and a detail-dialog section) and filters by mode
client-side in `gui/src/pages/logs-filter.ts`. `tests/responses/protocol-trace.test.ts` and
`tests/usage/request-log-protocol-trace.test.ts` pin derivation, persistence and the filter.

## Planner and preview

`planProtocol` in `src/protocols/plan.ts` is pure: given a snapshot of the settled route (inbound,
selector, route kind, candidates with their final adapter and whether the ingress would take its
native lane, requested features, surfaces, settings, policy revision) it computes each candidate's
paths through `path.ts`, its feature effects, and whether `reject` would refuse it
(`feature-unrepresentable`). Features preserved by every eligible candidate are guaranteed; those
preserved by only some are partial. A disabled surface blocks every candidate with
`surface-disabled`; an unroutable selector has no candidates and reports `unknown-model`. The
planner never selects a provider. `tests/responses/protocol-plan.test.ts` covers it.

`buildProtocolPlanSnapshot` in `src/protocols/plan-snapshot.ts` builds that snapshot from config
without side effects. Combo and policy selectors are expanded from their configured targets through
`routeConcreteModel` rather than `routeModel`, which would advance round-robin state or run the
policy evaluator; every other selector goes through `routeModel`'s deterministic branches. Each
candidate's wire is settled the way the ingress settles it (`captureRouteStaticPolicy` for the
original inbound, then `resolveWireProtocolOverride`), and a Chat candidate's native lane is judged
by `nativeChatDeclineReason` against a structural body built from the requested features. With
`nativeChatCombos` on, a combo's candidates are judged as the concrete routes they are, as the
combo loop judges them; policy candidates keep `combo-or-policy-route`. With
`protocols.rollout.managedMessagesNative` on, a Messages candidate is judged the same way by
`nativeMessagesDeclineReason`; with it off Messages candidates carry no decline reason, exactly as
before the lane existed. Messages
caller-forward passthrough depends on the caller's own credential, so it is reported as
`caller-credential-required` and never assumed. The OpenCode Go session-lane transport is not
modelled. `tests/responses/protocol-plan-snapshot.test.ts` pins the no-side-effect property against
combo selection state.

## Source envelope, codecs and guard

`src/protocols/envelope.ts` (server side; it charges the translator budget) wraps the body an
ingress parsed. It keeps that body by reference for the request only, scans its features on the
first `features()` call and caches them, and hands out `freshBody()` copies, each a
`structuredClone` charged under `request_copies`, so a consumer that rewrites its body cannot
leak the rewrite into another consumer's input.

`src/protocols/codecs/{chat,messages,responses}.ts` are named entry points over the existing
translators — `chatToResponsesBody` is `chatCompletionsToResponsesBody`,
`messagesToResponsesTranslation` is `anthropicToResponsesTranslation`, `responsesToIr` is
`parseRequest` — plus each protocol's feature scanner. They add no behavior; the Chat and
Messages ingresses call the bridge through them.

`checkRepresentable` in `src/protocols/guard.ts` judges a request path the caller computed with
`path.ts`: under the `legacy` policy it always passes; under `reject` it refuses the features
`featureEffectsForPath` finds `unsupported`, with reason `feature-unrepresentable`. A hop into
`other` has no disposition and never refuses by itself, but a loss declared on an earlier known
hop (the internal Responses body) still does.

Only when `resolveProtocolSettings(config).unrepresentable === "reject"` do the Chat and Messages
ingresses build an envelope and run the guard, after the route and its wire settle and before the
request is sent: Chat on the native path when the native lane was chosen, otherwise on the
bridge path to the settled adapter's wire; Messages on the native path when the managed native
lane was chosen, otherwise on the bridge path. Combo and policy routes
and an unroutable model are not judged at ingress; with `nativeChatCombos` on, a Chat combo's
candidates are judged one by one inside the combo loop (below). A refusal answers 400 in the ingress's own
error shape (Chat `invalid_request_error` / `unsupported_feature`; Anthropic
`invalid_request_error`) naming feature keys only, marks the trace blocked, and writes the
final log row with no upstream send. Under the default `legacy` policy nothing is built and the
would-be loss appears only as the trace's `featureEffects`. The Messages envelope's features are
fixed at the bridge entry mark, before an effort override rewrites `thinking`.
`tests/responses/protocol-envelope.test.ts`, `tests/responses/protocol-guard.test.ts` and
`tests/responses/protocol-ingress-guard.test.ts` pin them.

## Direct client encoders

`src/protocols/encoders/` turns `AdapterEvent` streams into the Chat Completions and Anthropic
Messages wires without the internal Responses SSE. It is server side and not a leaf.
`adapter-events.ts` is the driver: it ports the item state machine of `bridgeToResponsesSSE`
(item boundaries, signature grouping, hidden and redacted reasoning envelopes, tool naming and
argument gating, the integral-float repair, every terminal with its usage and durability rule,
the wire-silence heartbeat and stall watchdog, pull-based stepping, cancellation) and calls one
`ClientWireWriter` method wherever the bridge would emit a frame a client converter reads.
`chat.ts` (`encodeChatCompletionSse`, `foldChatCompletion`) and `messages.ts`
(`encodeAnthropicMessageSse`, `foldAnthropicMessage`) are the writers. They reuse the
converters' own helpers, exported from `src/chat/outbound.ts` and `src/claude/outbound.ts`
(ids, chunk and frame builders, usage mapping, `chatCompletionsStreamErrorPayload`,
`chatCompletionsFailedResponse`, `chatCompletionsIncompleteOutcome`,
`anthropicIncompleteOutcome`, `anthropicFailedStatus`, the message snapshot, the web-search pair),
so the frames a client receives are the converters' frames. A fold is the encoded stream read by
the existing collector.

Deliberate equivalences, pinned by the parity tests: a Chat function call is delivered as one
complete tool-call chunk when it completes, as the converter always did; Messages streams
`input_json_delta` fragments; custom and tool-search calls and server-side search activity have
no Chat representation; a Messages thinking block is buffered until its item closes. The one
behavior that differs is backpressure: the Messages converter read the bridge eagerly, while the
encoder steps one event per pull.

The server side is `src/server/inference/client-encoder-delivery.ts`, described with the
[Responses transport](../transports/responses.md#direct-client-encoders). A directly encoded
attempt is traced with `markAttemptProtocolPath`: the request path is still the bridge path
(`[inbound, "responses-internal", "ir", upstream]`, mode `legacy-bridge`) because the request
side still decodes through the Responses projection, and the response path is
`[upstream, "ir", inbound]`.

## Native Chat candidates in combos

With `protocols.rollout.nativeChatCombos` on, the Chat ingress hands a combo route its source
envelope, and `src/server/responses/core-combo-native.ts` sends each candidate that passes
`isNativeChatRouteEligible` on the native Chat lane from its own `freshBody()` copy, marking that
attempt `native` with `markAttemptProtocolPath`; other candidates keep the bridge and its
lane-derived path. The request's entry mark still says `bridge` with `combo-or-policy-route`,
because that is the lane the ingress chose; the final mode and paths follow the last attempt.
Under `reject` a candidate whose path cannot carry a requested feature is skipped before any send
and `feature-unrepresentable` is added to the entry mark; if every enabled candidate is skipped the
combo returns the ingress refusal and a blocked trace. With the switch off, combos are not judged
per candidate. Policy routes select a single candidate in the router and stay on the bridge. The
transport side (send budget, failover, logging) is in
[Responses transport](../transports/responses.md#native-chat-candidates-in-combos).

## Managed native Messages

Behind `protocols.rollout.managedMessagesNative` (default off). A Messages request whose settled
route is a direct, key-auth `anthropic` provider is sent as Messages instead of replaying through
Responses. `nativeMessagesDeclineReason` names the first rule that keeps a route off the lane:
`rollout-disabled`, `cross-wire-ir` (another adapter), `auth-mode-not-native` (OAuth, which is
PF-10, or `forward`), `combo-or-policy-route`, `effort-row` / `fast-row` (synthetic rows need the
adapter's wire rewrite), `vision-preprocessing` (an image for a model declared unable to read
it), and `bridge-only-policy` when operator policy that only the translated path applies would
engage: a pinned reasoning effort for the route (`resolvePinnedEffort`, read with the translated
body's model id as the bridge reads it), a blocked-skill bundle the translator would elide
(`anthropicBodyElidesBlockedSkill` in `src/claude/inbound.ts`), or a `web_search*` server tool the
web-search sidecar could serve (not excluded by `tool_choice`, sidecar not disabled in the Claude
replay config; backend credentials are decided at dispatch, so this errs toward the bridge). The
ingress, `count_tokens` and the planner all ask it. The planner can judge only the config-and-route
parts: skill elision and web search depend on body content no feature describes.

With the switch on, a declined route re-marks its bridge entry with the decline reason (after
any `effort-row` / `fast-row`), so the trace says why the bridge was taken; with it off nothing is
added. `claudeCode.stabilizePromptCache` is not a decline rule: it is a Claude-app cache
optimization rather than routing policy, applies only on the translated path, and is a recorded
gap of the native lane.

`src/server/claude-messages.ts` decides the lane after the route and its wire settle and after the
managed-client steps already applied to the body (alias/modelMap resolution, `ocx-route`, effort
directives). The caller-forward passthrough is decided earlier, on the caller's own credential,
and returns before this point; the two branches share no credential and no header. The body sent
is `envelope.freshBody()` when a source envelope exists, otherwise the ingress's own body.
`src/server/messages-native.ts` is imported lazily, only for an eligible route.

`buildAnthropicMessagesPassthroughRequest` in `src/adapters/anthropic/passthrough.ts` builds the
request from that body: the top-level allowlist (`model, messages, system, max_tokens, metadata,
stop_sequences, stream, temperature, top_p, top_k, tools, tool_choice, thinking, output_config,
service_tier`), the wire model, and the URL, `anthropic-version`, client identity and key placement
the Anthropic adapter uses (`resolveAnthropicMessagesUrl`, `anthropicBaseRequestHeaders`,
`applyAnthropicKeyAuth`), plus the provider's configured headers. No caller header is read, so the
caller's `Authorization`, `x-api-key` and `anthropic-beta` never reach the provider; a beta
allowlist is PF-10. A dropped field has no name in the feature vocabulary, so it records no
feature effect.

`handleNativeMessages` mirrors native Chat on the shared pieces: `beginInferenceAttempt`,
`createFinalRequestLog`, the request spend tracker charged per physical send, proactive key
selection, 401 and 429 key-pool rotation, same-target 429 replay, the reset/transient retry
policy and `sendWithConnectionPolicy`. Before sending it runs the image normalizer, the image
guard and the tool-call-id repair the caller-forward passthrough runs. A streaming caller gets the
upstream SSE relayed through `tapAnthropicSseForLog`, which records usage and the
terminal and applies the body stall and size guards; a non-streaming caller gets the upstream JSON
(or a folded stream). Either way `model` is rewritten to the selector the client sent, as the
translated lane answers (`message_start.message.model` on a stream, found within the first 64 KiB;
everything else is relayed as is). Upstream errors answer in Anthropic shape with the translated lane's status
policy (transient 5xx as 529, replay refusals kept non-retryable). `count_tokens` estimates the
body the builder would send when the route is eligible, and sends nothing.
`tests/adapters/anthropic/anthropic-messages-passthrough.test.ts`,
`tests/responses/messages-native-eligibility.test.ts`,
`tests/responses/messages-native-bridge-policy.test.ts`,
`tests/claude-integration/messages-native.test.ts` and
`tests/claude-integration/messages-native-decline-trace.test.ts` pin the builder, the rule, the
lane and the decline trace.

## Settings

`resolveApiSurfaceSettings` and `resolveProtocolSettings` in `src/protocols/settings.ts` are the
only readers of the `apiSurfaces` and `protocols` config keys. Responses and Chat Completions are
always served. The Messages surface uses an explicit `apiSurfaces.messages.enabled` boolean when
present, closes when that value is present but malformed, and otherwise inherits
`claudeCode.enabled !== false`. The unrepresentable policy defaults to `legacy` and every
`protocols.rollout` switch defaults off; the OAuth native-Messages switch is effective only with
the key-auth one. The Chat and Messages ingresses read the unrepresentable policy (above);
`directEncodersApply` reads `directEncoders` on both; the Chat ingress reads `nativeChatCombos`
for combo routes (above); `managedMessagesNative` is read through `nativeMessagesDeclineReason`
by the Messages ingress, `count_tokens` and the planner (below). No request path reads the
other rollout switches yet.

`claudeInboundDisabled` in `src/server/claude-messages.ts` is the Messages ingress reader: both
`/v1/messages` and `/v1/messages/count_tokens` call it, so the two routes cannot disagree, and a
closed surface answers 403 before the body is read. `buildApiAccessEndpoints`
(`src/server/management/api-access.ts`) reports the resolved `surfaces` in the keys payload and
keeps `claudeCodeEnabled` for older dashboards, set from the resolved Messages state rather than
from `claudeCode.enabled`.

`PATCH /api/protocols/settings` is the one writer. `src/server/management/protocol-settings-patch.ts`
validates the body strictly and applies it in memory; the route persists through
`saveConfigPreservingClaudeCode` and restores the pre-patch snapshot when the save throws, so the
live config never serves a state the file does not hold. Closing Messages writes
`apiSurfaces.messages.enabled = false` and `claudeCode.enabled = false` in one save, through
`commitClaudeCodeBlock` (`src/claude/claude-code-block.ts`, shared with the Claude settings routes
and responsible for the auth-mode migration sentinel); a binary older than `apiSurfaces` reads only
`claudeCode.enabled`, so a downgrade after a close stays closed. Opening writes only the explicit
surface value, so after a downgrade the older reader decides, and it errs closed. The resulting
upgrade/rollback matrix is `tests/claude-integration/messages-surface-matrix.test.ts`; the route
contract is `tests/server/protocol-settings-route.test.ts`.

`src/config/schema/config-schema.ts` keeps `apiSurfaces` raw on purpose: degrading a mistyped
`enabled` to absence would turn it into "inherit" and could reopen a surface, so the resolver
fails closed instead. `protocols` is a strict optional object that degrades to absence when
malformed, which is safe because each of its defaults is the conservative one.
`tests/config/protocol-settings.test.ts` covers both.

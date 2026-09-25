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
or trace reports cannot disagree.

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
non-streaming client. No target cell contains `responses-internal`.
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
marks caller-forward passthrough as the native lane, the translated path as the bridge, and a
disabled surface or a compatibility reject as blocked. The Responses ingress needs no mark: its
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
by `nativeChatDeclineReason` against a structural body built from the requested features. Messages
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
bridge path to the settled adapter's wire; Messages on the bridge path. Combo and policy routes
and an unroutable model are not judged at ingress. A refusal answers 400 in the ingress's own
error shape (Chat `invalid_request_error` / `unsupported_feature`; Anthropic
`invalid_request_error`) naming feature keys only, marks the trace blocked, and writes the
final log row with no upstream send. Under the default `legacy` policy nothing is built and the
would-be loss appears only as the trace's `featureEffects`. The Messages envelope's features are
fixed at the bridge entry mark, before an effort override rewrites `thinking`.
`tests/responses/protocol-envelope.test.ts`, `tests/responses/protocol-guard.test.ts` and
`tests/responses/protocol-ingress-guard.test.ts` pin them.

## Settings

`resolveApiSurfaceSettings` and `resolveProtocolSettings` in `src/protocols/settings.ts` are the
only readers of the `apiSurfaces` and `protocols` config keys. Responses and Chat Completions are
always served. The Messages surface uses an explicit `apiSurfaces.messages.enabled` boolean when
present, closes when that value is present but malformed, and otherwise inherits
`claudeCode.enabled !== false`. The unrepresentable policy defaults to `legacy` and every
`protocols.rollout` switch defaults off; the OAuth native-Messages switch is effective only with
the key-auth one. The Chat and Messages ingresses read the unrepresentable policy (above); no
request path reads the rollout switches yet.

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

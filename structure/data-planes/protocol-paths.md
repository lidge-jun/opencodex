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
`src/protocols/path.ts` and `src/protocols/dto.ts` are leaf modules: the dashboard imports them directly, so they import
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

## Settings

`resolveApiSurfaceSettings` and `resolveProtocolSettings` in `src/protocols/settings.ts` are the
only readers of the `apiSurfaces` and `protocols` config keys. Responses and Chat Completions are
always served. The Messages surface uses an explicit `apiSurfaces.messages.enabled` boolean when
present, closes when that value is present but malformed, and otherwise inherits
`claudeCode.enabled !== false`. The unrepresentable policy defaults to `legacy` and every
`protocols.rollout` switch defaults off; the OAuth native-Messages switch is effective only with
the key-auth one. No request path reads these settings yet.

`src/config/schema/config-schema.ts` keeps `apiSurfaces` raw on purpose: degrading a mistyped
`enabled` to absence would turn it into "inherit" and could reopen a surface, so the resolver
fails closed instead. `protocols` is a strict optional object that degrades to absence when
malformed, which is safe because each of its defaults is the conservative one.
`tests/config/protocol-settings.test.ts` covers both.

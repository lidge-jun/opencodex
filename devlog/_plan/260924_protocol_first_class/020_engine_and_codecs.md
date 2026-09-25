# 020 — execution, codecs and encoders (PF-05 to PF-10)

The execution owner stays single. Native lanes and the Responses pipeline share the same
primitives for budgets, attempts, cancellation, final logging and client-wire identity; the
Responses-only state (`previous_response_id`, compaction, response-state retention, Codex
specifics) stays in `src/responses/*` and `src/server/responses/*` and is reached through hooks,
not moved.

## PF-05 shared inference primitives

New directory `src/server/inference/` (inside the already-documented `src/server/` area).

| File | Exports | Replaces |
|---|---|---|
| `context.ts` | `createInferenceSendBudget(req, logCtx)` — the one construction of `createRequestExecutionBudget(undefined, undefined, attachRequestSpendTracker(req, logCtx))` | the inline construction in `src/server/responses/core.ts` `handleResponses` and the native Chat equivalent |
| `final-log.ts` | `createFinalRequestLog(logIds, logCtx)` returning `{ finish(status, meta), finished() }`; finish-once | the `finalizeNativeLog` / `finishLog` / `nativeLogged` closures repeated in `chat-completions.ts`, `chat-native.ts`, `claude-messages.ts` |
| `attempt.ts` | `beginInferenceAttempt(logCtx, { provider, model, adapter })` → `{ attempt, seal(accountLabel?), finish(status, usage?) }`; wraps `beginRequestAttempt`, `activeAttempt`, `activeAttemptStartedAt`, `attempts.push`, `sealRequestAttemptIdentity`, `finishRequestAttempt` | the hand-rolled attempt opening in `chat-native.ts` and the combo child |
| `client-wire.ts` | `markClientWire(response, protocol)`, `clientWireOf(response)` (WeakMap on `Response`) | nothing yet; PF-07 and PF-09 use it so an ingress can tell a body already in its client wire from a Responses body |

Rules:

- Behavior-preserving. Every moved statement keeps its order relative to the sends it guards.
- `src/server/responses/core.ts` must shrink (it is at its file-size cap); PF-07 needs a few
  lines of headroom there.
- Split `handleNativeChatCompletions` in `src/server/chat-native.ts` into
  `runNativeChatAttempt(execution, attemptHandle)` — send loop, key failover, 429 replay,
  relay, usage — and the existing wrapper that opens the attempt and owns the final log. The
  split is what lets a combo child run a native attempt whose final log belongs to the parent.
- No new behavior, no new config reads.

## PF-06 source envelope and guard

| File | Role |
|---|---|
| `src/protocols/envelope.ts` | `createProtocolEnvelope({ inbound, body, translatorBudget })` → `{ inbound, features(), freshBody() }`. The source body is retained for the request lifetime only; `features()` is computed once lazily; `freshBody()` returns a structured clone charged to the translator budget (`request_copies`). Server-side module (may import `src/lib/translator-budget`). |
| `src/protocols/codecs/chat.ts`, `codecs/messages.ts`, `codecs/responses.ts` | thin, named entry points over the existing translators (`chatCompletionsToResponsesBody`, `anthropicToResponsesTranslation`, the Responses parser) so ingress code calls one codec surface. No translator behavior changes. |
| `src/protocols/guard.ts` | `checkRepresentable({ inbound, requestPath, features, policy })` → `{ ok: true } \| { ok: false, features, reasonCodes }` using `featureEffectsForPath` and `unrepresentableFeatures`. Pure. |

Wiring (only when `resolveProtocolSettings(config).unrepresentable === "reject"`):

- `src/server/chat-completions.ts`: after the route settles and before the Responses projection
  is built, compute the path the request will take (native Chat path when native-eligible;
  otherwise the bridge path for the settled route's adapter). Unknown-adapter hops never block.
  A refusal returns HTTP 400 in Chat error shape, `type: "invalid_request_error"`,
  `code: "unsupported_feature"`, message naming the feature keys only, marks the trace blocked
  (`feature-unrepresentable`) and logs the request with no upstream send.
- `src/server/claude-messages.ts`: the same after route settlement, Anthropic error shape.
- Combo and policy routes are checked per candidate in PF-07; at ingress they are not refused.
- `legacy` policy: no behavior change; the would-be refusal is still reflected in the trace's
  `featureEffects`.

Native Chat's in-place effort normalization (`chatEffortSnapshots`) keeps working; PF-07 moves
combo children onto `freshBody()` so no candidate inherits another's rewrite.

## PF-07 native Chat candidates in combos

Behind `protocols.rollout.nativeChatCombos`.

- `HandleResponsesOptions` (`src/server/responses/core-options.ts`) gains
  `protocolSource?: { inbound: "chat"; envelope; dispatchNativeChild(input) }`, supplied only by
  `src/server/chat-completions.ts` for combo routes when the switch is on.
- In `src/server/responses/core-combo.ts`, where each child is dispatched through
  `requestDispatchers.handleResponses`, a child whose concrete route passes
  `isNativeChatRouteEligible(targetRoute, envelope.freshBody(), config)` is dispatched through
  `protocolSource.dispatchNativeChild` instead. That runs `runNativeChatAttempt` on the attempt the
  combo already opened, with the combo's `targetSendBudget`, abort signal and turn lease. It
  returns a Chat-wire `Response` marked with `markClientWire(response, "chat")`.
- A marked child response skips `preflightComboStreamResponse` (native Chat reports pre-stream
  failures by status before any byte). Non-OK native responses go through the existing
  `consumeComboFailure` path unchanged.
- `src/server/chat-completions.ts` returns a response whose `clientWireOf` is `chat` without the
  Responses-to-Chat conversion, still wrapped by the deferred request log.
- Policy routes: migrate only if their child dispatch goes through the same combo loop;
  otherwise record them as not migrated in [040](040_acceptance_and_rollout.md).
- `n > 1` is never emulated with multiple inferences. A candidate whose path cannot carry a
  requested feature is skipped under `reject` policy with reason `feature-unrepresentable`.
- Each native child records its attempt path with `markAttemptProtocolPath` (PF-02) as native.

## PF-08 managed native Messages

Behind `protocols.rollout.managedMessagesNative`.

| File | Role |
|---|---|
| `src/adapters/anthropic/passthrough.ts` | `buildAnthropicMessagesPassthroughRequest(provider, modelId, body, config)` → `{ url, headers, body }`. URL is the provider's Messages endpoint as the existing adapter (`src/adapters/anthropic.ts`) computes it; auth headers from the provider's key exactly as that adapter injects them; `anthropic-version` pinned as the adapter pins it. Body = the source Messages body with `model` replaced by the wire model and a field allowlist (`model, messages, system, max_tokens, metadata, stop_sequences, stream, temperature, top_p, top_k, tools, tool_choice, thinking, output_config, service_tier`). |
| `src/server/messages-native.ts` | `isNativeMessagesRouteEligible(route, body, config)` and `handleNativeMessages(...)`, modelled on the native Chat lane and built on PF-05 primitives: attempt, key failover and 429 replay (`src/providers/key-failover.ts`), spend reservation, SSE relay with the existing Anthropic log tap, JSON for non-streaming callers. |

Eligibility: adapter `anthropic`, `authMode` key (OAuth is PF-10), not combo/policy, no vision
preprocessing required, no synthetic effort/fast row, switch on.

Wiring in `src/server/claude-messages.ts`: after route settlement and after the managed-client
steps that already ran on the Anthropic body (alias/modelMap resolution, `ocx-route`, effort
directives), an eligible route goes native. The caller-forward passthrough (the caller's own
Anthropic credential) stays a separate branch with separate authority.
`handleClaudeCountTokens` counts the body the native lane would send when the route is eligible.

## PF-09 direct client encoders

Behind `protocols.rollout.directEncoders`.

| File | Role |
|---|---|
| `src/protocols/encoders/chat.ts` | `encodeChatCompletionSse(events, opts)` and `foldChatCompletion(events, opts)` from `AdapterEvent` |
| `src/protocols/encoders/messages.ts` | `encodeAnthropicMessageSse(events, opts)` and `foldAnthropicMessage(events, opts)` from `AdapterEvent` |

- `HandleResponsesOptions` gains `clientEncoder?: { protocol: "chat" \| "messages"; stream: boolean }`,
  set by the two ingresses when the switch is on.
- In `src/server/responses/adapter-delivery.ts`, when `clientEncoder` is set, the guarded event
  stream is encoded directly instead of through `bridgeToResponsesSSE`. Effects keep parity: the
  events are also collected (charged to the translator budget) and, at the terminal, folded with
  `buildResponseJSON` so `rememberResponseState`, `notifyResponseComplete`,
  `commitReasoningReplayServingRoute` and the key-usage binding run exactly as before.
- The returned response is marked with `markClientWire`; the ingress passes it through.
- Encoders preserve chunk indexes, one role frame, finish/stop reasons, tool-call identity and
  argument streaming, usage, error frames and cancellation. Passthrough (Responses upstream)
  and native lanes are unaffected.
- The attempt's `responsePath` becomes `[upstream, "ir", client]`; the request path is still the
  bridge until the codecs decode to IR directly, and the trace says so.

## PF-10 auth and opaque state

- `src/adapters/anthropic/beta-allowlist.ts`: the `anthropic-beta` values a managed native
  Messages request may forward, per provider class (first-party vs Anthropic-compatible). Others
  are dropped and recorded as a degraded feature, never forwarded blind.
- OAuth native Messages behind `managedMessagesNativeOAuth`: eligibility extends to Anthropic
  OAuth accounts, credentials resolved through the existing OAuth account selection; the account
  chosen is the one the router/pool already chose. No refresh or selection happens in planning.
- `src/protocols/opaque-state.ts`: thinking signatures and `redacted_thinking` blocks are
  forwarded only to first-party Anthropic destinations on the native lane; for any other
  destination they are removed from the fresh body and recorded as a degraded feature (blocked
  under `reject`). A fallback to a different provider or credential domain rebuilds from the
  envelope and applies the same rule.

## Not migrated after this unit

Recorded and maintained in [040](040_acceptance_and_rollout.md#not-migrated-inventory).

# 261014 Antigravity direct protocol translators

Issue: #7079. Branch: `feat/antigravity-direct-protocols`.

## Goal

Give Google Antigravity (`google` adapter, Cloud Code Assist mode, wire `other`) a direct
translator per client protocol, with no internal Responses body between the client wire and the
IR the Google wire compiler reads. Rotation, errors, usage and effort policy keep their owners.

## Earlier records this mirrors

| Record | What it did | What this unit reuses |
|---|---|---|
| PF series, `devlog/_plan/260924_protocol_first_class/` | protocol vocabulary, trace, planner, guard, encoders; inventory row "Chat/Messages request decode still produces a Responses-shaped body" | the lane/trace/plan vocabulary; this unit closes that row for Chat -> Antigravity |
| #5918 (batch 6) | native `/v1/chat/completions` reset replacement | native Chat lane shape |
| #6559 | native Claude Messages through pooled dispatch (`messages-native*.ts`, decline reasons, `protocol-paths.md`) | a pure decline-reason function shared by ingress and planner; documented recorded gaps |
| #6562 | native pool preference with explicit opt-out precedence | rollout switch semantics: off by default, explicit value wins |
| #6790 | JEV initial effort on native Chat combo dispatch, asserted on the native lane | assert the lane in the trace, not just the answer |
| PF-09 (`src/protocols/encoders/`) | AdapterEvent -> Chat/Messages encoders behind `directEncoders`, golden parity against the bridge | the response half; parity-test style for the request half |

## References (studied, not dependencies)

- router-for-me/CLIProxyAPI @ `bf9341629ef2300ac9d846a2e80fe2756f63a671`: pairwise translators
  registered per (client, upstream) in `internal/translator/antigravity/{openai/chat-completions,claude,openai/responses}`
  (`sdk/translator/registry.go`). Chat and Claude build the Antigravity request directly; Responses
  delegates through its Gemini translator. Chat streaming drops thought signatures; replayed tool
  calls get `skip_thought_signature_validator`.
- Wei-Shaw/sub2api @ `4d9ac3e482106d2da3a39fe3e546d8d6801f1cc1`: Anthropic Messages is the pivot.
  Messages -> v1internal is direct (`backend/internal/pkg/antigravity/request_transformer.go`);
  Chat goes Chat -> Responses -> Anthropic -> Gemini
  (`backend/internal/service/antigravity_gateway_compat.go`). Signature-400 recovery downgrades
  thinking to text; no failover after bytes are written.

In OpenCodex the IR is already the pivot and `src/adapters/google.ts` already owns signature
replay, sanitizing and the envelope, so the direct translators target the IR and the adapter is
unchanged.

## Route map (eligible concrete Antigravity route)

| Inbound | Before | After (`antigravityDirect`, on by default) |
|---|---|---|
| Responses | `responses -> ir -> other`, answer `other -> ir -> responses` | unchanged; already direct (`parseRequest`, `bridgeToResponsesSSE`) |
| Chat | `chat -> responses-internal -> ir -> other`; answer `other -> ir -> responses-internal -> chat` (`other -> ir -> chat` only with `directEncoders`) | `chat -> ir -> other`; answer `other -> ir -> chat` |
| Messages | `messages -> responses-internal -> ir -> other`; answer `other -> ir -> responses-internal -> messages` (`other -> ir -> messages` only with `directEncoders`) | `messages -> ir -> other`; answer `other -> ir -> messages` |

## Design

The core reads many fields of the Responses body before and after `parseRequest`
(`request-prepare.ts`), but on a concrete Antigravity Chat route the ones that read the
conversation are Codex-only, combo/policy-only, hosted-tool or other-wire consumers. So the lane
splits the bridge body: settings go to the core on `chatSettingsToResponsesBody` (one
`applyChatSettings` builds both bodies), and the conversation is decoded straight into the IR by
`chatConversationToIr` and applied at the parse seam. A restore hook puts the bridge conversation
back if the final route leaves Antigravity. The structure contract is
`structure/data-planes/protocol-paths.md#antigravity-direct-lane`.

Parity is the safety argument: the lane's parsed request must equal
`parseRequest(chatCompletionsToResponsesBody(body))` (`tests/responses/protocol-chat-ir-parity.test.ts`),
and the end-to-end test requires the same Antigravity wire body on both lanes.

## Follow-ups

- Messages -> Antigravity direct decode: done in the follow-up PR (`messages-ir.ts`,
  `src/server/messages-antigravity-direct.ts`). The lane is planned before translation on the
  settings-only body (resolved model, prompt-cache key) against a route preview, reproduces
  blocked-skill elision, cache stabilization, envelopes and the native replay map, and declines
  hosted web search, vision preprocessing, the shadow intercept and core-rewritten text. The same
  PR turns `antigravityDirect` on by default for both lanes; an explicit `false` turns it off.
- Claude-on-Antigravity thinking continuity: the Google adapter sends assistant thinking parts
  nowhere today; only call-bound `thoughtSignature`s survive. Carrying Claude thinking blocks as
  `thought: true` parts (as CLIProxyAPI does) is an adapter change for both lanes, not part of
  the decode work.
- Combos whose candidates are Antigravity routes stay on the bridge, like PF-07 before
  `nativeChatCombos`.

# 000 — DeepSeek Responses API: what is already wired, and what is wrong

## Upstream fact base

DeepSeek shipped a Responses API public beta on 2026-07-31.

- `POST https://api.deepseek.com/responses`, `Authorization: Bearer <DEEPSEEK_API_KEY>`,
  OpenAI Responses-compatible shape.
  Source: <https://api-docs.deepseek.com/guides/responses_api/>
- Supported model today: `deepseek-v4-flash` only (release label
  `DeepSeek-V4-Flash-0731`). `deepseek-v4-pro` is announced for early August.
  Source: <https://api-docs.deepseek.com/updates/>
- **Stateless.** No `previous_response_id`, no conversation state, no background
  mode, no `metadata`. Every turn must resend the full history.
- Supports text input, streaming, function tools, server-side web search, and a
  Codex-compatible `apply_patch` custom tool.
- Chat Completions and the Anthropic-compatible interface are unchanged and remain
  first-class. The Responses API is an addition, not a migration.

Verified against the reference page itself (<https://api-docs.deepseek.com/api/create-response/>),
not search snippets:

- Route is `POST /responses`. The page header states it verbatim.
- Statelessness, quoted: *"The API is stateless: responses and conversations are not
  stored on the server. For multi-turn conversations, the client needs to send the
  full conversation history in `input` on each request."* The sample response carries
  `"store": false` and `"previous_response_id": null`.
- `model` accepts exactly `deepseek-v4-flash`; the page says `deepseek-v4-pro` "is not
  supported yet".
- `reasoning.effort` accepts `none|minimal|low|medium|high|xhigh|max`.
- Accepted input item types: `message`, `function_call`, `function_call_output`,
  `reasoning`, `web_search_call`. Other types are **ignored**. Roles `user`,
  `assistant`, `system`, `developer` (developer treated as system).
- Image and file inputs are unsupported: `input_image` parts do not error but are
  replaced with placeholder text — consistent with the existing `noVisionModels`
  entry for this model.
- Tools: `function` plus the server-side `web_search`; other built-in tool types are
  ignored.

## What our tree already had

`e743660fc` (zhouxun, 2026-07-31 15:08 +0800) added to the `deepseek` registry entry:

```ts
modelWireDefaults: { "deepseek-v4-flash": "openai-responses" },
```

So V4 Flash already leaves the provider-wide `openai-chat` adapter and rides the
native Responses passthrough. The feature is NOT missing. Two defects sit on top
of it.

## Defect 1 — the wire default is inbound-blind

`resolveWireProtocolOverride()` (`src/server/adapter-resolve.ts`) is called from all
three inbound surfaces:

| Caller | Inbound protocol | Client |
|---|---|---|
| `src/server/responses/core.ts` | Responses | Codex CLI / App / SDK |
| `src/server/claude-messages.ts` | Anthropic Messages | Claude Code |
| `src/server/chat-completions.ts` | Chat Completions | OpenAI-compatible clients |

`providerModelWireDefault()` receives only `(providerName, provider, modelId)`. It
cannot see which surface asked, so it returns `openai-responses` for all three.
Current behaviour:

- Codex → Responses upstream: zero translation hops. Correct.
- Claude Code → Anthropic Messages parsed, then re-emitted as Responses. One hop,
  through our *newest* upstream path.
- Chat client → Chat parsed, then re-emitted as Responses. One hop, same problem.

Both non-Codex surfaces pay a translation hop to reach a wire the client never
asked for, when DeepSeek natively accepts Chat Completions — the wire our
Anthropic↔Chat and Chat↔Chat paths have carried for every other DeepSeek model
since the provider was added.

### Decision: minimise translation hops, inbound-first

A per-model wire default expresses "this model prefers wire W" but the useful
question is "given the client already speaks wire C, and upstream supports both
C and W natively, which costs fewer hops?" Answer: stay on C.

So `modelWireDefaults` becomes inbound-scoped. The Responses default applies only
when the inbound request is itself a Responses request; Anthropic and Chat inbound
keep the provider adapter (`openai-chat`).

Rejected alternatives:

- *Force Responses everywhere for consistency.* Buys nothing — the wire is an
  implementation detail invisible to the client — and routes the two least-tested
  DeepSeek surfaces through the newest upstream contract.
- *Force Chat everywhere and drop the Responses default.* Throws away the real win:
  Codex speaks Responses natively, and DeepSeek explicitly ships an `apply_patch`
  custom tool for it. Tool-call and reasoning round-tripping is exactly where the
  translation layer is most fragile (cf. issue #78 `reasoning_content` replay).
- *A provider-level `preferredInboundWire` flag.* Same effect, but pushes the
  decision into provider config where a future provider could set it inconsistently
  with its declared adapter. Keeping it on the existing per-model map is narrower.

## Defect 2 — stateless upstream keeps stateful parameters

`stripPreviousResponseId()` (`src/adapters/openai-responses.ts`) strips
`previous_response_id` when the proxy expanded the input, or when `authMode` is
`forward`. Its docstring states the API-key branch deliberately keeps the field:

> API-key mode keeps the field on unexpanded requests: the platform `/v1/responses`
> supports real server-side storage.

That premise is false for DeepSeek, which is stateless. An unexpanded replay miss
(proxy restart, unrecorded prior turn) forwards `previous_response_id` to an
upstream that documents no support for it.

`fish2lab/DSCodex` (MIT, read as reference only — the clone is gitignored and never
enters this history) strips the same family in `buildDeepSeekBody()`:
`previous_response_id`, `conversation`, `background`, `metadata`, `service_tier`,
plus `reasoning.summary` / `generate_summary` / `context`, and forces `store: false`.
That list is consistent with the documented stateless contract and is the useful
signal to take from it.

Our tree already handles parts of this generically: `stripUnsupportedReasoningParams`,
`stripUnsupportedReasoningSummaryDelivery`, and `stripItemIdsWhenUnstored` cover the
reasoning-summary and item-id cases. The gap is the top-level stateful set.

Note on effort: DSCodex folds every requested effort into `high` or `max`. That is a
product choice for its two-entry picker, not an upstream constraint — the reference
page accepts the full `none|minimal|low|medium|high|xhigh|max` range, which is what
`DEEPSEEK_THINKING_EFFORTS` already exposes. We do not copy the fold.

## Defect 3 — the Responses URL is wrong for this provider (most severe)

`createResponsesPassthroughAdapter()` builds the key-mode URL as:

```ts
if (provider.responsesPath === undefined) {
  const base = provider.baseUrl.replace(/\/v1\/?$/, "");
  url = `${base}/v1/responses`;
}
```

The `deepseek` registry entry sets `baseUrl: "https://api.deepseek.com"` and no
`responsesPath`, so the adapter targets `https://api.deepseek.com/v1/responses`
while the documented route is `https://api.deepseek.com/responses`.

Live probing cannot discriminate the two without a key: `api.deepseek.com` answers
`401` for `/responses`, `/v1/responses` **and** `/v1/nonexistent-xyz` alike, so auth
precedes routing and a 401 proves nothing about path validity. The reference page is
therefore the evidence, and it states `POST /responses`.

This makes the existing wire default effectively dead on the API-key path: Codex
would reach an unrouted URL. It also explains why this defect survived review —
nothing in the tree exercises it.
## Scope boundary

In scope: `src/providers/registry.ts`, `src/server/adapter-resolve.ts`, its three
callers, `src/adapters/openai-responses.ts`, plus focused tests.

Out of scope: the RSS-retention work already dirty in this worktree
(`src/server/relay.ts`, `src/server/relay-eager.ts`, `tests/relay-eager.test.ts`,
`tests/sse-failed-tail.test.ts`, `tests/sse-inspector-bounds.test.ts`) — untouched.
No `deepseek-v4-pro` wiring until upstream ships Responses support for it.

# 230 Umans wire protocol and custom adapter research

## Goal

Investigate whether issue #18 can be explained by routing Umans models through the wrong wire
adapter, and decide whether opencodex needs a custom-provider path for Anthropic Messages-style
providers in addition to the existing OpenAI Chat Completions path.

Issue anchor:

- https://github.com/lidge-jun/opencodex/issues/18

## External evidence

### Umans official docs

Source: https://app.umans.ai/offers/code/docs

Findings:

- Umans Code exposes an Anthropic-compatible endpoint:
  - `POST https://api.code.umans.ai/v1/messages`
  - Auth header: `x-api-key`
  - Requires `anthropic-version: 2023-06-01`
  - Streamed responses use Anthropic Messages SSE.
- Umans Code also exposes an OpenAI-compatible endpoint:
  - `POST https://api.code.umans.ai/v1/chat/completions`
  - Auth header: `Authorization: Bearer ...`
  - Streamed responses use Chat Completions-style chunks.
- Umans recommends `umans-kimi-k2.7` for hard coding tasks. Kimi K2.7-Code always reasons before
  answering, so reasoning output is expected.
- Umans documents reasoning output by protocol:
  - `/v1/messages`: `thinking` content blocks / `thinking_delta` stream events.
  - `/v1/chat/completions`: `reasoning_content` on messages and streamed deltas.
- Umans documents Claude Code manual configuration with:
  - `ANTHROPIC_BASE_URL=https://api.code.umans.ai`
  - `ANTHROPIC_AUTH_TOKEN=sk-your-umans-api-key`

### models.dev provider metadata

Sources:

- https://models.dev/providers/umans-ai/
- https://models.dev/providers/umans-ai-coding-plan/
- https://models.dev/api.json

Findings:

- Both `Umans AI` and `Umans AI Coding Plan` are listed as `@ai-sdk/openai-compatible`.
- API base is `https://api.code.umans.ai/v1`.
- `umans-kimi-k2.7`:
  - family: `kimi-k2`
  - reasoning: true
  - reasoning_options: empty array
  - tool_call: true
  - structured_output: true
  - temperature: false
  - interleaved reasoning field: `reasoning_content`
  - regular plan output limit: 32,768
  - coding plan output limit: 262,144
- `umans-coder` currently routes to Kimi K2.7-Code and has the same Kimi-like constraints.
- `umans-glm-5.2` supports reasoning effort values `high` and `max`.
- `umans-flash` / Qwen-like models support `low`, `medium`, `high` efforts.

### Related ecosystem signal

Source: https://newreleases.io/project/github/can1357/oh-my-pi/release/v16.0.1

Findings:

- Another coding-agent stack recently added Umans AI Coding Plan API-key login support.
- The same release fixed OpenAI-compatible Chat Completions streams whose tool arguments arrive as
  object-shaped fragments and need deep-merge behavior instead of naive replacement. This is not
  direct evidence that Umans emits that exact shape, but it is a useful warning that modern
  OpenAI-compatible coding gateways do not always behave like simple scalar-delta streams.

## opencodex local evidence

### Router

File: `/Users/jun/Developer/new/700_projects/opencodex/src/router.ts`

Routing behavior:

- `umans/umans-kimi-k2.7` will use provider `umans` only if `config.providers.umans` exists.
- The upstream model id becomes `umans-kimi-k2.7`.
- The provider's configured `adapter` controls the wire protocol.

Local config check during this investigation:

```json
{
  "defaultProvider": "opencode-go",
  "umans": null
}
```

So the reporter's `umans` provider is not present in this local machine's
`~/.opencodex/config.json`; conclusions about its exact adapter must be verified against the
reporter's config.

### OpenAI Chat adapter

File: `/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts`

Behavior:

- Always sends to `${provider.baseUrl}/chat/completions`.
- Sends `max_tokens` for output cap.
- Sends `reasoning_effort` if `mapReasoningEffort(...)` returns a value.
- Sends `temperature`, `top_p`, and penalties unless the provider/model is listed in the relevant
  no-parameter config arrays.
- Streams only scalar `choices[0].delta.content` and `choices[0].delta.reasoning_content` as
  append-only deltas.
- Tracks one current tool call id/name, not a full index-keyed map of parallel or interleaved tool
  call chunks.

Issue #18 implication:

- If Umans Chat Completions emits cumulative or overlapping content snapshots rather than strict
  append-only deltas, opencodex will append them and live output can duplicate partial text.
- If Umans emits tool-call arguments as object fragments, cumulative snapshots, or id-less indexed
  chunks, the current parser can lose or corrupt tool-call state. That can explain commentary
  streaming successfully but the turn stalling before Codex receives a file-change/tool event.
- If a custom `umans` provider lacks Kimi model constraints, opencodex can send unsupported or
  poorly matched params (`temperature`, `top_p`, `reasoning_effort`, `tool_choice`) to
  Kimi-family models.

### Anthropic Messages adapter

File: `/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts`

Behavior:

- Sends to `${baseUrlWithoutV1}/v1/messages`.
- For API-key providers, uses `x-api-key`.
- Sets `anthropic-version: 2023-06-01`.
- Maps Codex reasoning to Anthropic `thinking`.
- Parses `thinking_delta`, `text_delta`, and `input_json_delta` into opencodex `AdapterEvent`s.

Issue #18 implication:

- Since Umans officially implements `/v1/messages`, opencodex can already target the Messages path
  by configuring:

```json
{
  "providers": {
    "umans": {
      "adapter": "anthropic",
      "baseUrl": "https://api.code.umans.ai",
      "apiKey": "sk-...",
      "defaultModel": "umans-coder",
      "models": ["umans-coder", "umans-kimi-k2.7", "umans-glm-5.2", "umans-flash"]
    }
  }
}
```

- This route may be safer for Claude/Codex-style tool and thinking semantics than the Chat
  Completions route, because Umans' own docs present it as Anthropic-compatible and Claude Code
  setup uses the Anthropic base/auth variables.

### Dashboard / custom provider surface

Files:

- `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/AddProviderModal.tsx`
- `/Users/jun/Developer/new/700_projects/opencodex/src/providers/derive.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`

Current behavior:

- The custom provider preset defaults to `adapter: "openai-chat"`.
- The Add Provider modal already lets a user choose:
  - `openai-responses`
  - `openai-chat`
  - `anthropic`
  - `google`
  - `azure-openai`
- `/api/providers` accepts any `provider.adapter` and `provider.baseUrl`; it then calls
  `enrichProviderFromCatalog(name, prov)`.

Gap:

- The UI does not teach users that providers such as Umans may have two valid protocols, and that
  the Messages path may be safer for coding-agent/tool-call stability.
- There is no first-class Umans preset in `PROVIDER_REGISTRY`, so users are likely to add it via
  Custom and leave the default `openai-chat` adapter.

## Working hypotheses for issue #18

### H1: wrong protocol selection for Umans custom provider

Evidence:

- Custom providers default to `openai-chat`.
- Umans offers both OpenAI-compatible and Anthropic-compatible endpoints.
- Claude Code setup in Umans docs uses Anthropic-style base URL and auth token.
- Issue #18 happens in coding-agent turns where tool/file-change semantics matter.

Risk:

- If the reporter's `umans` provider uses `openai-chat`, opencodex goes through
  `/v1/chat/completions`.
- That may still be officially supported, but it may be the less stable path for Codex's
  Responses-to-tool-call bridge.

Falsification:

- Capture the reporter's `~/.opencodex/config.json` provider entry with secrets redacted.
- Run the same prompt with:
  - `adapter: "openai-chat", baseUrl: "https://api.code.umans.ai/v1"`
  - `adapter: "anthropic", baseUrl: "https://api.code.umans.ai"`
- If duplication/stall disappears only on `anthropic`, protocol selection is implicated.

### H2: OpenAI-compatible stream is not strict scalar-delta compatible

Evidence:

- Issue #18 live text examples look like append duplication.
- `openai-chat.ts` assumes every `delta.content` / `delta.reasoning_content` string is append-only.
- Related ecosystem release notes warn about object-shaped tool argument fragments in
  OpenAI-compatible streams.

Falsification:

- Record raw upstream SSE for a short Umans stream.
- Check whether `delta.content`, `delta.reasoning_content`, or `tool_calls[].function.arguments`
  are append-only strings or cumulative/object fragments.

### H3: missing model capability flags for Kimi-family Umans models

Evidence:

- models.dev marks `umans-kimi-k2.7` and `umans-coder` as `temperature: false` and
  `reasoning_options: []`.
- Existing Kimi registry entries in opencodex have explicit no-temperature/no-top-p/no-penalty and
  auto-tool-choice-only settings.
- A custom Umans provider will not inherit those Kimi constraints unless catalog enrichment covers
  this provider id or the user config includes them.

Falsification:

- Inspect `enrichProviderFromCatalog("umans", prov)` behavior for this provider name.
- Add/verify a first-class `umans` registry entry with model constraints and compare request bodies.

## Patch options

### Option A: first-class Umans provider presets

Add registry entries:

- `umans` or `umans-ai`
  - label: `Umans AI`
  - adapter: `anthropic`
  - baseUrl: `https://api.code.umans.ai`
  - authKind: `key`
  - dashboardUrl: `https://app.umans.ai/offers/code/docs`
  - defaultModel: `umans-coder`
  - models: `umans-coder`, `umans-kimi-k2.7`, `umans-glm-5.2`, `umans-flash`, possibly
    `umans-glm-5.1`
- `umans-openai` optional advanced preset
  - adapter: `openai-chat`
  - baseUrl: `https://api.code.umans.ai/v1`
  - note: OpenAI-compatible route; use only if a tool specifically requires Chat Completions.

Reasoning:

- Make the safer coding-agent path the obvious default.
- Keep Chat Completions available for users who need it.

### Option B: custom provider protocol helper

Improve the custom provider modal:

- Add an adapter explainer:
  - `openai-chat`: base URL should end in `/v1`; opencodex calls `/chat/completions`.
  - `anthropic`: base URL should be provider root or `/v1`; opencodex calls `/v1/messages`.
- Add a preset-like "Umans Messages" row so users do not accidentally keep `openai-chat`.
- Optionally warn when a base URL contains `api.code.umans.ai` and adapter is still `openai-chat`:
  "Umans also supports Messages; use Anthropic adapter for Codex-style tool stability."

### Option C: harden OpenAI Chat streaming parser

Add tests and parser support for:

- id-less tool-call indexed chunks.
- multiple tool-call indexes even when `parallel_tool_calls=false`.
- object-shaped or cumulative tool arguments if observed in raw stream.
- optional duplicate/cumulative text detection only if raw Umans evidence proves it; do not guess.

### Option D: raw stream capture debug mode

Add a temporary or gated debug facility:

- Log upstream SSE frames for a selected provider/model with secrets stripped.
- Include request adapter, URL path, and model params.
- Use it to prove whether duplication comes from upstream frames, opencodex bridge, or Codex
  mobile renderer.

## Recommendation

Do not treat #18 as a generic stall timeout issue. It is likely a wire-protocol / event-contract
problem.

Immediate next implementation cycle should:

1. Add first-class Umans presets, defaulting to `adapter: "anthropic"` / `/v1/messages`.
2. Add documentation for when custom providers should use `anthropic` instead of `openai-chat`.
3. Add an A/B repro plan for Umans `openai-chat` vs `anthropic`.
4. Add raw-stream capture tests before changing duplicate suppression logic.
5. Harden `openai-chat` tool-call parsing only from observed raw stream evidence.

## Evidence status

- Umans protocol support: sufficient. Confirmed from official Umans docs and models.dev metadata.
- Reporter config: insufficient. Local machine does not have `providers.umans`.
- Root cause of #18: partial. Strong hypotheses exist, but raw upstream SSE capture is required before
  changing streaming parser behavior.

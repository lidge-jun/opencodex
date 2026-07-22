# ADR 0006: Provider output defaults and web-search replay privacy

## Status

Accepted

## Context

Codex clients may omit Responses `max_output_tokens`. OpenAI-compatible chat
providers then inherit their own default `max_tokens`, which can be much smaller
than the model supports. This is especially visible on reasoning-heavy coding
models where the default budget covers both thinking and visible output.

Routed providers also receive expanded Responses history. Historical
`web_search_call` output items are internal evidence that a prior hosted search
cell was rendered, but they do not contain a paired result payload that a routed
adapter can replay safely.

## Decision

[Decision Log]
- 목적과 의도: Allow operators to set honest provider/model output-token fallbacks without changing explicit caller requests, and prevent internal web-search replay markers from becoming model-visible text.
- 기존 구현 및 제약 조건: `openai-chat` only sent `max_tokens` from request `max_output_tokens`; provider config already had input/context metadata but no output fallback. Historical `web_search_call` replay was converted to `[web search performed: ...]` assistant text, which could be echoed when no sidecar plan was available.
- 검토한 주요 대안: Force a global `max_tokens`; add provider-only defaults; add provider plus model-specific defaults; filter the marker from final output; convert replayed hosted search cells into synthetic tool calls.
- 선택한 방식: Resolve `max_tokens` in the `openai-chat` adapter with precedence explicit request, model-specific provider config, provider default, then omit. Validate both config fields as positive integers and thread them through registry/derive/router plumbing. Drop replayed hosted search cells from assistant-visible history instead of post-filtering output.
- 다른 대안 대신 이 방식을 선택한 이유: Adapter-time resolution preserves passthrough behavior and keeps the field closest to the OpenAI Chat wire. Model-specific defaults cover providers with mixed ceilings. Hiding replay cells at parse time removes the leak source without claiming a current search ran or altering the active sidecar loop.
- 장점, 단점 및 영향: Long routed turns can opt into larger budgets while existing configs remain byte-for-byte compatible when unset. Historical search cells no longer create echoable sentinel text; the tradeoff is that routed models do not receive a separate text hint that a prior search cell existed when no actual search result payload is available.

## Consequences

- Existing configs continue omitting `max_tokens` unless they add
  `defaultMaxOutputTokens` or `modelMaxOutputTokens`.
- Explicit Responses `max_output_tokens` remains authoritative.
- Registry defaults can be added later without changing adapter behavior.
- The active web-search sidecar still emits real `web_search_call` cells only
  when a sidecar executes a search.

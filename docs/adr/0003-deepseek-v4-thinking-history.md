# ADR 0003: DeepSeek V4 thinking history is model-scoped metadata

## Status

Accepted

## Context

DeepSeek V4 thinking mode returns assistant `reasoning_content` and expects that
field to be passed back in later multi-turn and tool-call requests. If the
gateway drops that history, DeepSeek can reject the next request with a 400 that
says the `reasoning_content` from thinking mode must be passed back.

opencodex already has a provider flag for OpenAI-compatible chat models that
require reasoning history replay: `preserveReasoningContentModels`.

## Decision

DeepSeek V4 thinking models are marked in the provider registry with:

- model-scoped Codex reasoning levels
- `xhigh` to upstream `max` reasoning effort mapping
- `preserveReasoningContentModels`

This is not enabled for every OpenAI-compatible provider or for the legacy
`deepseek-reasoner` preset.

## Consequences

- Existing saved `deepseek` configs receive the new metadata at route time.
- DeepSeek V4 tool-call/subagent turns keep `reasoning_content` on assistant
  history messages, including messages that also carry `tool_calls`.
- The older DeepSeek reasoner behavior remains unchanged.

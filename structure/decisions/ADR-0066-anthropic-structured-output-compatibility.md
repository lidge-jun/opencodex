# ADR-0066 — Anthropic structured-output compatibility

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#anthropic-structured-output-compatibility)

## Decision record

- 목적과 의도: Preserve schema-constrained output when OpenAI-shaped Responses or Chat Completions requests route to Anthropic Messages.
- 기존 구현 및 제약 조건: The parser retained the requested schema, but the Anthropic adapter dropped it; forwarding the OpenAI schema unchanged fails when it includes constraints outside Anthropic's supported subset.
- 검토한 주요 대안: Keep tool-call emulation; forward the raw schema; depend on the full Anthropic SDK; maintain a local compatibility transform based on the SDK.
- 선택한 방식: Merge Anthropic `output_config.format` into compatible adaptive-thinking configuration, mirror the SDK transform locally with strict `unknown` narrowing, move unsupported constraints into descriptions, and preserve root `$defs` before returning a root `$ref`.
- 다른 대안 대신 이 방식을 선택한 이유: Native structured output avoids synthetic tools, raw forwarding produces upstream 400s, and importing the full SDK only for a small wire transform would duplicate the adapter's direct HTTP ownership.
- 장점, 단점 및 영향: Both OpenAI-shaped input surfaces gain native Anthropic schema enforcement and unsupported intent remains visible to the model; the copied subset must track upstream SDK changes, description-carried constraints are guidance rather than hard validation, and the root-reference fix is an intentional divergence to keep definitions reachable.

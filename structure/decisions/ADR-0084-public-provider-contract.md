# ADR-0084 — Public provider contract

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#public-provider-contract)

## Decision record

- 목적과 의도: Let public Responses clients use the Codex-login route without one unsupported prompt-cache extension failing the whole turn.
- 기존 구현 및 제약 조건: Parsing already preserves unknown top-level fields in `_rawBody`, and the canonical backend rejects `prompt_cache_options`; API-key and custom providers may accept the same field.
- 검토한 주요 대안: Add the field to the Zod schema; strip it for every Responses provider; translate it to a legacy retention hint; remove it only at the canonical destination boundary.
- 선택한 방식: Keep parser passthrough unchanged and strip the caller field only after `isCanonicalOpenAiForwardProvider` succeeds.
- 다른 대안 대신 이 방식을 선택한 이유: Schema admission does not change `_rawBody`, global stripping would remove supported public API behavior, and translation would invent cache policy.
- 장점, 단점 및 영향: VS Code and other public-shape clients avoid the canonical backend rejection while API-key/custom routes retain their wire options; canonical callers cannot request this cache option through OpenCodex.

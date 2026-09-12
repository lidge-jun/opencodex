# ADR-0026 — decision recorded under "Ultra reasoning level"

- Contract owner: [catalog.md](../catalog.md#ultra-reasoning-level)

## Decision record

- 목적과 의도: bare `defaultModel` selectors that route into third-party providers must keep their
  adapter-owned effort ladder; only true ChatGPT-native requests should receive the mock-max repair.
- 기존 구현 및 제약 조건: `nativeEffortClamp` already needed the original request id because
  routing strips `provider/`, but bare third-party selectors like `glm-5.2-fast-preview` still look
  native after that strip.
- 검토한 주요 대안: (1) infer nativeness from the bare slug prefix alone, (2) gate clamping by the
  resolved provider identity, (3) disable the clamp for all off-snapshot slugs.
- 선택한 방식: request-time clamp entry is allowed only when the resolved route is the canonical
  built-in OpenAI/Codex forward provider and the original request id is still bare.
- 다른 대안 대신 이 방식을 선택한 이유: provider identity is the only durable signal that
  distinguishes true native ChatGPT traffic from third-party `defaultModel` routes when both share a
  bare model id shape.
- 장점, 단점 및 영향: preserves `gpt-5.5 max -> xhigh` repair for native traffic, removes false
  clamps for bare routed models, and keeps adapter-specific effort mapping as the single source of
  truth for third-party providers.

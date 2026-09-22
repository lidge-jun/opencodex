# ADR-0355 — decision recorded under "Chat structured-output compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#chat-structured-output-compatibility)

## Decision record

- 목적과 의도: Bound the request amplification a Moonshot `$ref` inlining can produce without
  weakening the tool schema beyond what the wire forces.
- 기존 구현 및 제약 조건: The normalizer walks depth-, node-, and expansion-bounded, but a small
  input can name a large boolean `properties` map from many nodes, so each bound can pass while
  the serialized output still repeats the map hundreds of times. The adapter sits on the request
  path, so amplification is user-facing latency and payload size.
- 검토한 주요 대안: (1) Keep only the three existing budgets. (2) Measure the final serialized
  request and reject it over a size cap. (3) Charge each inlined target its serialized JSON bytes
  against a shared byte budget before copying it.
- 선택한 방식: (3). Each expansion measures the referenced schema's serialized size once per
  target object, charges it against one 1 MiB allowance shared by every tool in the request,
  and a reference that would exceed the remaining allowance stays a bare `$ref`.
- 다른 대안 대신 이 방식을 선택한 이유: (1) leaves the demonstrated amplification reachable —
  node and expansion counts stay small while output grows without bound. (2) detects the blow-up
  only after the bytes were already produced, and a whole-request rejection discards a schema
  Moonshot would have accepted in partially inlined form.
- 장점, 단점 및 영향: Output size is bounded independently of how the reference graph is shaped,
  and over-budget nodes degrade to the same bare-`$ref` fallback the other budgets already use.
  Measuring is iterative and capped at the remaining allowance, so the guard itself cannot
  reintroduce the deep-schema stack exhaustion the depth budget prevents. Moonshot 계열
  `openai-chat` baseUrl에만 적용되고 다른 provider는 손대지 않는다.

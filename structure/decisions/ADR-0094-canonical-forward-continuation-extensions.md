# ADR-0094 — Canonical forward continuation extensions

- Contract owner: [adapters/compatibility-contracts.md](../adapters/compatibility-contracts.md#canonical-forward-continuation-extensions)

## Decision record

- 목적과 의도: Preserve Posit Assistant tool continuation semantics while preventing canonical ChatGPT Codex forwarding from sending client-only cache markers or unresolvable stored-item references.
- 기존 구현 및 제약 조건: The existing `store: false` sanitizer removed item ids but left `item_reference` shells, and no bounded pass recognized markers nested inside content; tool `call_id` pairing and reasoning effort are continuation-critical.
- 검토한 주요 대안: Strip the extensions for every Responses destination; delete only reference ids; expand references from local state; or normalize only the canonical forward destination with bounded recursive marker removal.
- 선택한 방식: Apply the bounded marker pass only to canonical forward `input`, and omit `item_reference` rows only when `store` is exactly `false`.
- 다른 대안 대신 이 방식을 선택한 이유: Public and custom gateways may implement these extensions, while id-only deletion creates an invalid reference shell and local expansion would invent unavailable persistence authority.
- 장점, 단점 및 영향: Posit continuations retain tool pairing and reasoning controls without widening public-provider behavior; hostile nesting fails closed to the original input, so an over-limit request may still be rejected upstream rather than partially rewritten.

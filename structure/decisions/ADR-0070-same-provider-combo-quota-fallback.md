# ADR-0070 — Same-provider combo quota fallback

- Contract owner: [transports/responses.md](../transports/responses.md#same-provider-combo-quota-fallback)

## Decision record

- 목적과 의도: Let an ordered combo recover when one model-specific Codex quota window is exhausted but another model on the same account remains usable.
- 기존 구현 및 제약 조건: Account health is shared across models, and recording a reset-derived 429 before combo advancement rejected the later model locally.
- 검토한 주요 대안: Make every quota cooldown model-scoped; ignore all combo 429 cooldowns; or defer only reset-derived cooldown recording for an eligible later same-provider failover target.
- 선택한 방식: Use the narrow request-scoped deferral while retaining target cooldown and all explicit Retry-After/default account cooldown behavior.
- 다른 대안 대신 이 방식을 선택한 이유: Reset timestamps identify quota windows rather than a literal account-wide retry instruction, but widening the exception would risk hot retries and provider abuse.
- 장점, 단점 및 영향: Same-account model fallback works without weakening explicit upstream backoff; the account health map intentionally does not remember that one deferred reset-derived failure, while the combo target map does.

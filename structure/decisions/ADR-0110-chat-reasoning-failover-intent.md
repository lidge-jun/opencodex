# ADR-0110 — decision recorded under "Responses Failover"

- Contract owner: [transports/responses-failover.md](../transports/responses-failover.md)

## Decision record

- 목적과 의도: Preserve a Chat caller's reasoning effort across combo and policy failover while still omitting unsupported controls from each concrete upstream.
- 기존 구현 및 제약 조건: Chat ingress translated one shared Responses body, then stripped effort using the provisional settled route. Combo and policy dispatch already clone and normalize that body per target with the target's own reasoning ladder.
- 검토한 주요 대안: Keep ingress stripping; restore effort from the original Chat body after each failure; attach a second private metadata field; or skip ingress stripping for unresolved routes and use the existing per-target normalizer.
- 선택한 방식: Apply ingress empty-ladder stripping only to a non-combo, non-policy concrete route. Combo and policy retain the translated reasoning object and normalize an isolated child body for every attempt.
- 다른 대안 대신 이 방식을 선택한 이유: The shared body is caller intent, not an attempt wire shape. Reconstructing after mutation is lossy and a second metadata channel can drift, while the existing child normalizer already owns target capability mapping.
- 장점, 단점 및 영향: A capable fallback receives the requested effort even when an earlier target has an empty ladder; unsupported targets still omit it. The unresolved body retains the small reasoning object until a target is chosen.

# ADR-0028 — Background service command selection

- Contract owner: [ops/service-and-sidecars.md](../ops/service-and-sidecars.md#background-service-command-selection)

## Decision record

- 목적과 의도: Make a bare service refresh safe and idempotent without converting a localized or transient Windows status failure into an elevated re-registration.
- 기존 구현 및 제약 조건: The command defaulted to install and later used a boolean diagnostic whose scheduler query fallback could collapse unknown into absent; repair must preserve the existing Windows launcher and Bun stability workarounds.
- 검토한 주요 대안: Always repair; keep a boolean installed check; infer presence from saved state alone; use a tri-state live registration probe.
- 선택한 방식: Validate arguments first, then use a narrow tri-state platform probe only for a bare backend-neutral invocation; route installed to repair, absent to install, and unknown to a refusal.
- 다른 대안 대신 이 방식을 선택한 이유: Saved state can be stale and unconditional repair breaks first install, while a boolean cannot represent the exact uncertainty that must fail closed.
- 장점, 단점 및 영향: Healthy existing services avoid UAC and registration churn; stale Windows scheduler definitions may be refreshed and require elevation. Invalid input performs no status I/O, and uncertain Windows hosts require one explicit status/installation decision instead of risking a destructive guess.

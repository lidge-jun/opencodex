# ADR-0073 — Authentication boundaries

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#authentication-boundaries)

## Decision record

- 목적과 의도: Keep a lower-privileged local process from collecting the management bearer by impersonating `/healthz` on an unused port.
- 기존 구현 및 제약 조건: Liveness must remain public and backward-compatible, but its service string and reported PID are assertions made by the listener itself.
- 검토한 주요 대안: Require only a runtime source and non-null PID; stop showing account health; authenticate the listener with a protected per-process challenge secret.
- 선택한 방식: Store a random secret in the mode-protected runtime record and use method/path/PID/port-bound HMAC capabilities for the two CLI health reads, so the CLI sends no reusable Authorization value.
- 다른 대안 대신 이 방식을 선택한 이유: PID and command-line checks are not cryptographic listener identity, while removing live account health would regress diagnostics unnecessarily.
- 장점, 단점 및 영향: The long-lived token never reaches a listener without the runtime secret; an old running proxy remains visible but cannot provide detailed CLI account health until restarted on the new version.

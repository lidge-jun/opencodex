# ADR-0003 — Lifecycle

- Contract owner: [runtime.md](../runtime.md#lifecycle)

## Decision record

- 목적과 의도: Separate proxy process ownership from persisted configuration without changing lifecycle behavior.
- 기존 구현 및 제약 조건: `src/config.ts` mixed config transactions with cross-platform PID identity, runtime-port attestation, and stale-state cleanup; process writes still require the same config-home and atomic-write protections.
- 검토한 주요 대안: Keep the mixed module; create a process-state module that imports `config.ts`; duplicate atomic writes inside the new module; split the minimal path and atomic-write foundations first.
- 선택한 방식: `paths.ts` and `atomic-write.ts` are dependency leaves, `process-state.ts` depends only on those leaves, and `config.ts` remains a compatibility facade.
- 다른 대안 대신 이 방식을 선택한 이유: Importing the facade would create a cycle, while duplicated writes could drift on ACL, symlink, residual-secret, and atomic-sequence behavior.
- 장점, 단점 및 영향: Lifecycle callers have a narrow owner and behavior remains characterized; the temporary facade and three small config modules add files but preserve downstream imports.

# ADR-0016 — Config surface

- Contract owner: [config.md](../config.md#config-surface)

## Decision record

- 목적과 의도: Make persisted config, path resolution, atomic file publication, and live process state distinct ownership boundaries.
- 기존 구현 및 제약 조건: All four concerns lived in `src/config.ts`; process-state extraction could not safely import the facade without a cycle and could not copy the atomic writer without creating two security/correctness contracts.
- 검토한 주요 대안: Keep one file, tolerate the cycle, duplicate only PID/runtime writes, or extract the minimal dependency leaves.
- 선택한 방식: Preserve one implementation per concern under `src/config/` and keep facade re-exports for downstream compatibility.
- 다른 대안 대신 이 방식을 선택한 이유: The dependency graph stays acyclic and every existing path, serialized shape, error, identity probe, and cleanup guard remains reusable from one owner.
- 장점, 단점 및 영향: Internal lifecycle imports become narrow and testable; review must still treat changes to `atomic-write.ts` and `process-state.ts` as shared cross-platform runtime changes.

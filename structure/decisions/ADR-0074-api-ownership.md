# ADR-0074 — decision recorded under "API ownership"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#api-ownership)

## Decision record

- 목적과 의도: Distinguish a healthy process from a continuation spill writer that is repeatedly failing, especially on Windows where the ACL publication lane is asynchronous.
- 기존 구현 및 제약 조건: `/healthz` intentionally reports liveness only, while `spillWriteFailures` was cumulative and discarded the failure class, event time, and recovery boundary.
- 검토한 주요 대안: Make `/healthz` fail on a spill error; publish raw error messages; expose a fixed classified health projection only on the authenticated memory route.
- 선택한 방식: Keep liveness unchanged and add a consecutive streak, fixed error class, and last failure/success timestamps to the existing authenticated response-state metrics.
- 다른 대안 대신 이 방식을 선택한 이유: One failed cache demotion must not restart or remove an otherwise serving proxy, and raw filesystem errors can disclose user paths while still failing to show whether the next write recovered.
- 장점, 단점 및 영향: Operators can identify accumulating failures and same-process recovery without sensitive text. The status is process-local and resets to `initial` on restart, so historical diagnosis still requires external metric collection.

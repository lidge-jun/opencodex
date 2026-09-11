# ADR-0077 — Startup safety

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#startup-safety)

## Decision record

- 목적과 의도: Prevent a crashed dashboard update worker from permanently blocking every later update.
- 기존 구현 및 제약 조건: The job file was written before spawn, the returned PID was not persisted, and active status had no liveness or freshness check.
- 검토한 주요 대안: Require manual deletion; expire all jobs by age; or persist PID and use age only for legacy no-PID records.
- 선택한 방식: Persist and verify PID liveness, with a ten-minute fallback only for legacy records.
- 다른 대안 대신 이 방식을 선택한 이유: It recovers known-dead workers promptly without allowing a second installer beside a long-running live worker.
- 장점, 단점 및 영향: New jobs self-recover after worker death and spawn failures become visible; legacy crashes may remain blocked for up to ten minutes.

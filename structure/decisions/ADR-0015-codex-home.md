# ADR-0015 — decision recorded under "Codex home"

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Keep `/healthz` and unrelated requests responsive during intermittent Windows ACL stalls without publishing an unhardened continuation.
- 기존 구현 및 제약 조건: Response demotion called the synchronous spill writer from request-time state mutations; `Bun.spawnSync(icacls)` could block the only Bun event loop for the full timeout and immediately replace replayable state with a tombstone.
- 검토한 주요 대안: Increase the ACL timeout, weaken required ACL checks, publish before hardening, move every platform to async state mutation, or isolate only the Windows ACL-dependent publication boundary.
- 선택한 방식: Preserve non-Windows behavior; serialize Windows publications through async ACL APIs, retain the exact resident generation until compare-before-swap succeeds, cap pending bytes, and retry one proven timeout.
- 다른 대안 대신 이 방식을 선택한 이유: Longer waits worsen liveness, early publication weakens secret-file ACLs, and a cross-platform async rewrite would disturb mature immediate memory and crash-ordering contracts that do not cause this incident.
- 장점, 단점 및 영향: Windows health stays schedulable and transient ACL stalls retain continuation replay; pending payloads can temporarily exceed the 64 MiB resident target but are pinned under a 256 MiB local ceiling and remain inside the documented 512 MiB process-owned worst case.

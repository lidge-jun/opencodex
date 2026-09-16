# ADR-0078 — decision recorded under "Usage accounting"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#usage-accounting)

## Decision record

- 목적과 의도: Explain missing main-account quota without confusing a working login with a successful WHAM read.
- 기존 구현 및 제약 조건: HTTP failures and body/transport exceptions returned identical null metadata; existing authentication and freshness policy must remain unchanged.
- 검토한 주요 대안: Copy raw errors, infer plan/quota, reuse stale evidence, or add a bounded diagnostic outcome.
- 선택한 방식: Carry a non-persisted fixed category and optional numeric HTTP status through the existing management and CLI read paths.
- 다른 대안 대신 이 방식을 선택한 이유: It gives reporters actionable evidence without disclosing payloads, changing permissions, or introducing another cache.
- 장점, 단점 및 영향: Main-account failures become distinguishable; root-cause repair and pool diagnostics remain separate work, and clients must tolerate an absent field.

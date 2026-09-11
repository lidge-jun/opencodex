# ADR-0019 — Config injection

- Contract owner: [config.md](../config.md#config-injection)

## Decision record

- 목적과 의도: Prevent a refused Codex config injection from degrading a previously usable model catalog and make the refusal actionable from the CLI.
- 기존 구현 및 제약 조건: Catalog discovery and replacement ran before injection, while the injector alone owned the authoritative TOML transforms and write-coordination eligibility checks.
- 검토한 주요 대안: Roll back catalog and cache bytes after a later refusal, duplicate a partial TOML validator in the CLI, or run the injector's existing planning path without committing before discovery.
- 선택한 방식: Add a non-writing mode to the injector and call it before catalog work; keep the normal injector call as the final under-lock authority check.
- 다른 대안 대신 이 방식을 선택한 이유: Post-hoc rollback can overwrite a concurrent catalog writer, and a second validator would drift from the real refusal rules. Reusing the injector keeps one policy path and avoids compensating writes.
- 장점, 단점 및 영향: Deterministic refusals preserve catalog/cache bytes and print their reason on stderr. A concurrent state change can still make the final injection refuse, but catalog and injection retain their existing independent revalidation and serialization boundaries.

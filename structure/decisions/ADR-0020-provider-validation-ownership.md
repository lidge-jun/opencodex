# ADR-0020 — Provider validation ownership

- Contract owner: [config.md](../config.md#provider-validation-ownership)

## Decision record

- 목적과 의도: Separate reusable provider payload validation from config file persistence without changing accepted configuration or error behavior.
- 기존 구현 및 제약 조건: The Zod schema, CLI, and management API shared helpers defined inside `src/config.ts`, so callers needing one pure check depended on the full persistence module.
- 검토한 주요 대안: Keep validation in the persistence module; duplicate checks per caller; extract one leaf and retain compatibility re-exports.
- 선택한 방식: Use one pure validation leaf, consume it from config refinement and direct DTO callers, and keep `src/config.ts` re-exports during migration.
- 다른 대안 대신 이 방식을 선택한 이유: One implementation preserves load/write parity while reducing dependency breadth and avoiding a flag-day import rewrite.
- 장점, 단점 및 영향: Validation can be characterized independently and config persistence becomes smaller; a temporary facade remains until all internal callers migrate.

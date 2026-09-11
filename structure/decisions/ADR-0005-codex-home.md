# ADR-0005 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Make the container's catalog location persistent and writable without changing native home semantics.
- 기존 구현 및 제약 조건: Compose persisted only the OCX home, leaving Codex state on a read-only root; both products use incompatible auth.json formats.
- 검토한 주요 대안: Merge the homes, nest Codex under an existing volume with a new startup initializer, or persist the existing separate Codex home.
- 선택한 방식: Add a separate codex-state volume and create both owner-only directories in the image.
- 다른 대안 대신 이 방식을 선택한 이유: It preserves existing paths, avoids credential-file collisions, and works when an older ocx-state volume hides the image's seeded directory tree.
- 장점, 단점 및 영향: Two volumes must be backed up, but no automatic credential migration or runtime resolver change is needed. Catalog import/materialization remains an explicit prerequisite.

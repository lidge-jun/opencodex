# ADR-0007 — decision recorded under "Codex home"

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Make every history safety check and mutation address the SQLite database Codex actually opened.
- 기존 구현 및 제약 조건: History code rebuilt `CODEX_HOME/state_5.sqlite`, while Codex supports a config or environment-selected SQLite root for split Windows/WSL layouts.
- 검토한 주요 대안: Copy the database into CODEX_HOME, teach only the writer about the override, or centralize the call-time target.
- 선택한 방식: Add one Codex-compatible SQLite resolver, fail closed when its authoritative config is unreadable or its present `sqlite_home` cannot be parsed as a non-empty string, and share it across history jobs, provider defaults, admission, and residue classification.
- 다른 대안 대신 이 방식을 선택한 이유: A writer-only override would let ownership checks authorize one database while the mutation touched another.
- 장점, 단점 및 영향: Split-home history remains correct and backup identities stay database-specific; storage cleanup of an external root remains out of scope.

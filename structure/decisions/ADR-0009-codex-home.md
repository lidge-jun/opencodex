# ADR-0009 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Recover a crashed zero-byte coordinator without mistaking SQLite's normal creation window for stale authority.
- 기존 구현 및 제약 조건: Eligibility treated every existing pathname as coordinated, while initialization correctly refused a missing row over routed residue; catalog sync could therefore succeed before config injection failed permanently.
- 검토한 주요 대안: Delete zero-byte files automatically, initialize a new row over residue, require a manual filesystem command, or add observe-only classification plus explicit guarded quarantine.
- 선택한 방식: Treat only a settled, identity-stable, immutably verified zero-byte database like the existing legacy-uncoordinated boundary; keep fresh creators coordinated, diagnose all other database states immutably, and expose an opt-in zero-byte-only same-directory backup move with identity, ownership, sidecar, liveness, and SQLite-lock checks.
- 다른 대안 대신 이 방식을 선택한 이유: Automatic deletion or adoption can race a live creator or erase transition evidence; a guarded backup preserves evidence and makes the operator action reproducible.
- 장점, 단점 및 영향: A stale zero-byte file no longer wedges sync, valid/unrecognized databases remain fail-closed, and recovery requires the proxy to be stopped before `ocx sync` retries injection.

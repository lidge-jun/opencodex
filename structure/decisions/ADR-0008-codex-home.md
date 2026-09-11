# ADR-0008 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Keep zero-profile and zero-stage installations out of the native-profile transaction path without weakening staged-credential cleanup.
- 기존 구현 및 제약 조건: Every live server swept stages at startup and every minute, and a failed sweep closed the global native-main gate even when no stage artifact existed.
- 검토한 주요 대안: Disable native-main ownership entirely when the vault is empty, add a stale-lock deletion command, or skip only the stage sweep when both artifact paths are absent.
- 선택한 방식: Preserve owner and claim protection, but bypass `sweepStages()` only after proving the registry and staging tree are both absent.
- 다른 대안 대신 이 방식을 선택한 이유: Physical credential ownership remains cross-process safe, while an inert optional subsystem can no longer create the reported lock/recovery catch-22.
- 장점, 단점 및 영향: Fresh installs avoid the SQLite profile lock; any present or uncertain stage state retains the existing locked fail-closed cleanup and recovery behavior.

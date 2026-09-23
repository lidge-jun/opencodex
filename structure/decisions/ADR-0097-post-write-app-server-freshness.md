# ADR-0097 — decision recorded under "CLI Codex restart scope"

- Contract owner: [runtime.md](../runtime.md#cli-codex-restart-scope)

## Decision record

- 목적과 의도: Avoid telling an operator to interrupt a fresh Codex session after a successful sync.
- 기존 구현 및 제약 조건: Startup already classified catalog freshness, but the ordinary post-write CLI warning treated every running app-server as stale; explicit restart flags must keep their existing consent semantics.
- 검토한 주요 대안: Warn on every running process; suppress every warning; classify only the advisory non-restart path from one process observation.
- 선택한 방식: Retain command lines from the classifier's enumeration and warn only for the proven-stale subset.
- 다른 대안 대신 이 방식을 선택한 이유: Presence alone cannot prove stale state, while suppressing every warning would hide a real in-memory catalog mismatch.
- 장점, 단점 및 영향: Mixed fresh/stale sets name only stale PIDs and unknown observations stay quiet; explicit restart requests remain unchanged.

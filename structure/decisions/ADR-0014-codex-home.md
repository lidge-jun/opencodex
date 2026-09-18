# ADR-0014 — decision recorded under "Codex home"

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Bound disk and conversation-state retention after abrupt process termination.
- 기존 구현 및 제약 조건: Ordinary write failures clean up immediately, but a killed process cannot run that path and Windows may temporarily lock files.
- 검토한 주요 대안: Delete every `.tmp`, rely on manual cleanup, or recover only exact response-state remnants with age and PID guards.
- 선택한 방식: Run a capped, best-effort, unlink-only sweep on lazy response-state startup.
- 다른 대안 대신 이 방식을 선택한 이유: It repairs known remnants without broad authority over unrelated temp files or active writers.
- 장점, 단점 및 영향: Old dead-PID files are reclaimed automatically; locked or conservatively classified files remain for a later retry.

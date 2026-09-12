# ADR-0010 — decision recorded under "Codex home"

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Make multi-home injection truthful without taking ownership of user environment variables.
- 기존 구현 및 제약 조건: CODEX_HOME is an intentional override, but Orca exports it for its own bundled runtime and the Windows app reads a different home.
- 검토한 주요 대안: Rewrite CODEX_HOME automatically, warn for every custom home, or detect only the Orca-owned signature and report the target path.
- 선택한 방식: Preserve the override, add a narrow Windows/Orca diagnostic, and qualify sync/restore success output with the effective home.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the silent failure while avoiding destructive or noisy behavior for intentional custom homes.
- 장점, 단점 및 영향: Orca users get an actionable warning; other multi-home products remain unchanged until they have an equally reliable signature.

# ADR-0006 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Keep service ownership metadata aligned with the Codex home the proxy actually uses.
- 기존 구현 및 제약 조건: The runtime performed narrow WSL Windows-home discovery, while service state used `CODEX_HOME || ~/.codex`.
- 검토한 주요 대안: Bake `CODEX_HOME` into every service, migrate old state automatically, or reuse the runtime resolver.
- 선택한 방식: Resolve service install and comparison state through the existing runtime Codex-home resolver.
- 다른 대안 대신 이 방식을 선택한 이유: It preserves explicit overrides and the existing WSL ambiguity rules without rewriting user environment or foreign state.
- 장점, 단점 및 영향: New installs and same-environment repairs agree with runtime targeting; genuinely foreign or ambiguous state remains fail-closed.

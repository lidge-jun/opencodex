# ADR-0011 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: keep trusted Windows identity and process probes console-less without triggering Bun's direct PowerShell `-WindowStyle Hidden` failure.
- 기존 구현 및 제약 조건: the calls already used `windowsHide: true` or a hidden VBS host, but redundantly passed PowerShell's window-style CLI option; the same option remains valid inside `Start-Process` and must not be removed there.
- 검토한 주요 대안: decode the generic failure specially, retry after failure, remove all hidden-window controls, or remove only the redundant direct CLI pair.
- 선택한 방식: retain trusted executable resolution, non-interactive flags, timeouts, and process-level hiding; remove `-WindowStyle Hidden` only from direct PowerShell argv.
- 다른 대안 대신 이 방식을 선택한 이유: the command executes on affected Bun/Windows combinations, no console window is introduced, and working elevated/detached child-process behavior stays unchanged.
- 장점, 단점 및 영향: SID, process-owner, tray, update, and sync probes share the compatible launch contract; a future call must use launcher-level hiding rather than reintroducing the PowerShell CLI pair.

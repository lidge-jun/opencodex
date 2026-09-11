# ADR-0012 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Preserve required Windows ACL hardening on the bundled Windows ARM64 runtime without weakening executable trust.
- 기존 구현 및 제약 조건: The effective-SID query depended on the shared `GetSystemDirectoryW` FFI resolver; Bun 1.3.14 Windows ARM64 has no working `bun:ffi`, so config mutation reached `EACLIDENTITY` before PowerShell could start.
- 검토한 주요 대안: Restore `USERDOMAIN\\USERNAME`; trust `SystemRoot`, `WINDIR`, or `PATH`; weaken required ACL writes; broaden the shared elevation resolver; or add a fixed-path fallback only for the non-elevated SID query.
- 선택한 방식: Keep FFI authoritative, then allow only Windows ARM64 to use the existing default `C:\Windows\System32` PowerShell binary for the SID query when that exact file exists.
- 다른 대안 대신 이 방식을 선택한 이유: Names and environment paths are caller-controlled, required secret writes must not silently skip ACLs, and elevation has a larger authority boundary that should remain FFI-only.
- 장점, 단점 및 영향: Default Windows ARM64 installations can start and harden secrets; non-default Windows roots continue to fail closed until Bun exposes a trustworthy native system-directory API without FFI.

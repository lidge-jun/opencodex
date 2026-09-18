# ADR-0047 — decision recorded under "Cursor Native Exec"

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-native-exec)

## Decision record

- 목적과 의도: prevent caller-controlled Responses text from authorizing Cursor native local shell, filesystem, or fetch execution.
- 기존 구현 및 제약 조건: the adapter preserved top-level `instructions`, system messages, and developer messages, then treated a `sandbox_mode ... danger-full-access` prose marker as an exec allow signal in `codex-sandbox` mode.
- 검토한 주요 대안: keep marker-based authorization, require a future trustworthy attestation channel, or restrict authorization to server-local config.
- 선택한 방식: keep marker detection only as diagnostic/context and make `nativeLocalExec: "on"` the only non-legacy mode that enables built-in local exec; unset, `off`, and `codex-sandbox` all deny.
- 다른 대안 대신 이 방식을 선택한 이유: opencodex has no trustworthy per-request sandbox attestation in request text or headers, so any prompt-carried marker is spoofable by data-plane callers.
- 장점, 단점 및 영향: this closes prompt-to-native-exec escalation while preserving an explicit operator escape hatch; existing configs that relied on `codex-sandbox` must switch to `nativeLocalExec: "on"` for trusted local experiments.

# ADR-0075 — Startup safety

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#startup-safety)

## Decision record

- 목적과 의도: Keep a refused fresh Windows service install from stopping a working proxy and removing managed Codex routing.
- 기존 구현 및 제약 조건: The generic installer stopped service managers and the standalone proxy before the first scheduler create attempt; the Dashboard UAC path depended on assets produced by that already-destructive failure.
- 검토한 주요 대안: Reject every non-elevated caller up front, restart and re-inject after failure, snapshot every runtime/config artifact for rollback, or separate registration approval from the destructive commit.
- 선택한 방식: When scheduler absence is proven, create but do not run the owned registration from a temporary XML first; cleanup and canonical asset publication begin only after registration succeeds.
- 다른 대안 대신 이 방식을 선택한 이유: An early rejection breaks Dashboard UAC, while a best-effort restart cannot prove that manager, proxy, and routing state were restored. The two-phase boundary makes denial/cancellation a real pre-commit failure.
- 장점, 단점 및 영향: Fresh-install UAC failure preserves the live proxy and routing. Failures after registration remain explicit partial-install cases, and existing/conflicting scheduler recovery remains conservative until exact prior-state restoration is available.

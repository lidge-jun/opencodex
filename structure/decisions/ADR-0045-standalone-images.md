# ADR-0045 — Standalone Images

- Contract owner: [data-planes/images.md](../data-planes/images.md#standalone-images)

## Decision record

- 목적과 의도: Preserve Codex Desktop reasoning summaries while adapting only the delivery enum rejected by a specific Responses-compatible upstream.
- 기존 구현 및 제약 조건: The existing boolean capability either passed Codex's enum unchanged or disabled summaries entirely; stale running clients can keep sending the old enum after a catalog refresh.
- 검토한 주요 대안: Disable summaries; rewrite the enum globally; inject a delivery field when absent; configure a provider-wide value.
- 선택한 방식: Use a validated per-model allowlisted map, imply summary capability for that model, and rewrite only a caller-provided delivery field at the Responses adapter boundary.
- 다른 대안 대신 이 방식을 선택한 이유: Upstream enum support differs by model and provider, while global rewriting or injection would change unrelated requests and disabling summaries removes Desktop UX.
- 장점, 단점 및 영향: Configured models retain the native summary UI and stale clients self-heal; each incompatible model needs an explicit map entry and contradictory opt-out configuration now fails closed.

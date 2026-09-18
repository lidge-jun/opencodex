# ADR-0072 — decision recorded under "Transport inventory"

- Contract owner: [transports/inventory.md](../transports/inventory.md#transport-inventory)

## Decision record

- 목적과 의도: Keep reactive OAuth 429 recovery available without silently enabling proactive account-routing policy the operator switched off.
- 기존 구현 및 제약 조건: #3495 made reactive recovery presence-driven, but a disabled Anthropic pool still consulted its dormant strategy on the reactive path, and a per-provider `oauthAccountFailover.enabled: true` could no longer beat a global `false`.
- 검토한 주요 대안: Restore the old all-or-nothing enable flag; leave the merged behavior and document the gaps; or keep the reactive/proactive split and repair the exact policy boundaries.
- 선택한 방식: Keep presence-driven reactive recovery, apply proactive precedence only before dispatch, and use quota ordering for disabled-pool Anthropic recovery.
- 다른 대안 대신 이 방식을 선택한 이유: This preserves the merged product decision without letting disabled proactive settings influence a retry, and it restores the published narrow-over-broad precedence in both directions.
- 장점, 단점 및 영향: 429 recovery stays automatic for operators with multiple eligible accounts; operators who require no automatic account switch must keep one eligible account, which the GUI and public docs state explicitly.

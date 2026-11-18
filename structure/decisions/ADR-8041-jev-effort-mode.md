# ADR-8041 — decision recorded under "JEV Decision Routing"

- Contract owner: [jev-decision.md](../providers/jev-decision.md)

## Decision record

- 목적과 의도: Let an operator keep a JEV combo's target choice while leaving the wire effort to the caller and the target ladder, for targets that implement effort by swapping the upstream model id.
- 기존 구현 및 제약 조건: A JEV decision's effort replaced the caller's effort on the first dispatch of both lanes. For a target whose effort tiers are separate upstream model ids, every re-tier changes the model id and so the prompt prefix a provider can reuse.
- 검토한 주요 대안: Change the default for every JEV combo; add a per-target switch; stop JEV choosing effort entirely; or add an opt-in combo field that only changes who owns effort.
- 선택한 방식: An opt-in `jevEffortMode` (`decide` default, `client`). Target selection stays JEV-owned in both modes; only the first-dispatch effort and `service_tier` handling differ, read from one place for both lanes so they cannot disagree.
- 다른 대안 대신 이 방식을 선택한 이유: Opt-in keeps every existing JEV combo byte-for-byte unchanged. Keeping target choice in JEV preserves the reason for choosing JEV, and one reader for the mode avoids a lane-specific contract.
- 장점, 단점 및 영향: A provider that tiers by model id is no longer re-tiered by JEV. This does not guarantee cache reuse: that still depends on a stable caller effort, target, provider/account and prompt prefix. In `client` mode the decision's recorded effort and the wire effort can differ by design, and the requested-effort label records no JEV transition.

# ADR-0121 — decision recorded under "Remote Workspace"

- Contract owner: [remote-workspace.md](../remote-workspace.md)

## Decision record

- 목적과 의도: Prevent a request whose prepare send remains backpressured through coordinator timeout from acquiring execution authority when those bytes arrive later.
- 기존 구현 및 제약 조건: ADR-0108 starts a relative executor lifetime upon request receipt. Delayed delivery can restart that lifetime after the coordinator stops waiting, before the ordered cancellation arrives. Device wall clocks are not assumed synchronized.
- 검토한 주요 대안: Absolute timestamps require clock assumptions; cancellation alone loses the delayed-receipt race; immediate execution cannot distinguish a still-pending coordinator from an expired one.
- 선택한 방식: RPC v2 separates authenticated prepare from grant. Prepare validates and retains bounded request state but cannot invoke. After prepare send completion, a grant is admitted only while the same pending request remains live, with the check inside the serialized send queue. Cancellation and expiry discard ungranted state; the existing abort signal owns granted work. RPC v1 is rejected without downgrade; encrypted framing is unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: The grant check closes the prepare-backpressure race without a shared clock, preserves directional encryption order, and prevents old immediate-execution endpoints from silently bypassing the new contract.
- 장점, 단점 및 영향: Timeout delivery no longer waits for a blocked send. Prepare-only requests never enter the executor. This adds one authenticated message and requires both peers to upgrade. A grant already sent can itself be delayed, and a running operation may already have committed; timeout remains an unknown outcome with cancellation requested, not proof of rollback or universal post-timeout non-execution.

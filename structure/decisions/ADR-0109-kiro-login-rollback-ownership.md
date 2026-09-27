# ADR-0109 — decision recorded under "Forced-login credential rollback"

- Contract owner: [providers/kiro.md](../providers/kiro.md#forced-login-credential-rollback)

## Decision record

- 목적과 의도: Compensate a failed forced Kiro login without deleting credentials or reversing account selection created by another concurrent login.
- 기존 구현 및 제약 조건: Rollback snapshotted only the pre-login account IDs, then deleted every later ID and unconditionally reselected the old active account. Auth-store mutations are already serialized and credentials have stable generation hashes and selection revisions.
- 검토한 주요 대안: Serialize the entire browser login; replace the whole prior provider set; keep the ID-difference rollback; or return an exact write receipt and compensate it with generation and selection checks.
- 선택한 방식: The receipt-bearing credential writer returns the exact written account, generation, post-write selection revision, previous active ID, and previous slot. Rollback performs one serialized mutation, acts only while that generation still matches, preserves a later selection of the same slot, and otherwise removes a created slot or restores only the slot this login replaced.
- 다른 대안 대신 이 방식을 선택한 이유: A global login lock would span interactive authentication and block unrelated work; whole-set or ID-difference restoration cannot distinguish this login from a concurrent successful one. Existing generation and revision metadata provides a narrow ownership proof.
- 장점, 단점 및 영향: Concurrent accounts and refreshes survive a failed publication, while uncontended failures still restore the prior state. A later write to the same slot deliberately wins and can leave the failed login credential present if ownership is no longer provable.

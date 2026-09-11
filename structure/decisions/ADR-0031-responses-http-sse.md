# ADR-0031 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep long but progressing client-driven tool continuations valid while locating repository-semantic loop detection at the layer that owns the workspace and continuation policy.
- 기존 구현 및 제약 조건: Issue #2600 recorded 18 persisted Cursor continuations whose transcript and tool counters grew while the worktree did not. Every proxy-local liveness and capacity bound was therefore satisfied, but the proxy had no workspace delta to compare.
- 검토한 주요 대안: Stop after a fixed continuation count; classify read-like tool names as no progress; compare assistant prose; emit a new proxy-only terminal code after a time budget; or leave semantic progress to the client while preserving transport cancellation for objective proxy failures.
- 선택한 방식: Do not add a proxy semantic cutoff without a client-supplied progress contract. Keep objective transport, byte, concurrency, and silence bounds typed and cancellable; require the workspace-owning client to bound repeated continuations using repository state plus its own side-effect ledger.
- 다른 대안 대신 이 방식을 선택한 이유: Calls and prose are not a repository oracle, and tool names do not prove side effects. A proxy cutoff would either miss the reported loop because items kept changing or terminate legitimate slow work. Retrying after the cutoff could also replay side-effecting work.
- 장점, 단점 및 영향: OpenCodex does not manufacture a root cause or silently terminate healthy long turns. The combined route still needs a client-side semantic boundary; if a future client sends an explicit privacy-safe progress marker, the proxy may enforce that contract without inferring workspace state.

# ADR-0108 — decision recorded under "Remote Workspace"

- Contract owner: [remote-workspace.md](../remote-workspace.md)

## Decision record

- 목적과 의도: Ensure a coordinator timeout cannot leave a queued workspace mutation authorized to run later, while allowing the documented 60-second exec ceiling to return normally.
- 기존 구현 및 제약 조건: The coordinator discarded only its pending result after 30 seconds. Executor operations serialize behind one queue, and their abort controllers previously lived only at the endpoint with no request deadline or timeout signal from the coordinator.
- 검토한 주요 대안: Delete late responses only; give each tool an independent queue; use an absolute wall-clock timestamp; send cancellation alone; or combine a bounded relative lifetime with an authenticated cancel frame.
- 선택한 방식: Carry the transport timeout on every encrypted request, start an endpoint abort timer on receipt, check the signal after dequeue through the existing executor boundary, and send a best-effort encrypted cancel frame when the coordinator timer fires. Set the default transport window to 65 seconds and cap negotiated values at 120 seconds.
- 다른 대안 대신 이 방식을 선택한 이유: Relative lifetimes avoid cross-device clock assumptions and cover cancellation frames that are delayed or lost. The cancel frame shortens active work when delivery succeeds, while the request deadline independently prevents queued post-timeout writes.
- 장점, 단점 및 영향: Timed-out queued mutations do not execute, supported commands can use their full 60-second limit, and timeout text no longer claims confirmed cancellation. A non-cooperative running command still depends on its runner honoring AbortSignal, and mixed implementations fail closed rather than silently accepting a request without a lifetime.

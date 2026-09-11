# ADR-0038 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Complete Cursor turns at the protocol terminal instead of waiting for a separate HTTP-body EOF that may never arrive.
- 기존 구현 및 제약 조건: Cursor can send turnEnded followed by a clean Connect END_STREAM envelope while RunSSE remains open or later closes through an abort-shaped transport error. The adapter logged the clean envelope but did not settle its terminal owner, so a completed-looking turn could remain open until the Responses stall watchdog.
- 검토한 주요 대안: Shorten the global stall timeout; treat every later abort as success; settle only when the HTTP stream emits end; make the clean Connect envelope authoritative.
- 선택한 방식: Process preceding frames in order, preserve an already-emitted terminal, run any already-armed drained client-tool finalizer before protocol cleanup clears its grace timer only while the call set is still drained, otherwise finalize once through the existing fail-closed tool-call logic, and settle the transport successfully on a clean Connect END_STREAM.
- 다른 대안 대신 이 방식을 선택한 이유: The protocol envelope is upstream's explicit terminal signal. Timeout changes only hide the race, and globally swallowing aborts would mask genuine mid-turn cancellation.
- 장점, 단점 및 영향: Completed Cursor responses no longer wait for the 300-second watchdog when the HTTP body stays open; incomplete tool calls still emit their existing truncation error, and error-bearing Connect terminals remain failures.

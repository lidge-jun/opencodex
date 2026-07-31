# 260627 Cycle 3 — Transport Close Logging Plan

## Purpose

Make `/v1/responses` request log entries distinguish normal terminal status from client close. Windows users report "proxy stopped" without enough evidence; request logs should show whether the stream completed, failed, became incomplete, or was cancelled by the client.

## Planned Diff

### MODIFY `src/server.ts`

Extend `RequestLogEntry`:

```ts
terminalStatus?: ResponsesTerminalStatus;
closeReason?: "terminal" | "client_cancel" | "non_stream";
```

Change `addFinalRequestLog(...)` to accept optional metadata and include it in the stored entry.

Change `responseWithDeferredRequestLog(...)`:

- non-stream responses log `{ closeReason: "non_stream" }`;
- SSE terminal responses log `{ closeReason: "terminal", terminalStatus: status }`;
- client cancellation logs `{ closeReason: "client_cancel" }` with HTTP 499.

### MODIFY `tests/request-log.test.ts`

Add test coverage for filtering/shape only if needed.

### MODIFY `tests/server-auth.test.ts`

Extend existing passthrough tests to assert:

- failed SSE log includes `terminalStatus: "failed"` and `closeReason: "terminal"`;
- client cancel log includes `closeReason: "client_cancel"` and no terminal status.

## Verification

```bash
bun test tests/request-log.test.ts tests/server-auth.test.ts tests/passthrough-abort.test.ts
bun x tsc --noEmit
```

## Acceptance Criteria

- Request logs remain token-safe.
- Existing status/errorCode behavior is preserved.
- SSE terminal vs client cancellation can be distinguished in `/api/logs`.
- Focused tests and typecheck pass.

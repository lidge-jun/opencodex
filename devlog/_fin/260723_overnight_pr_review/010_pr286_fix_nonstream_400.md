# 010 — PR #286: fix(server): return 400 instead of 500 for non-streaming

- **Author:** lg320531124
- **Branch:** fix/non-streaming-400-status → dev
- **CI:** All pass (ubuntu, windows, macos, npm-global x3)
- **Decision:** MERGE
- **Risk:** Minimal (one-line change)

## Change

`src/server/responses.ts` line ~1637: `formatErrorResponse(500, "internal_error", ...)` → `formatErrorResponse(400, "invalid_request_error", ...)`.

Non-streaming on adapters without `parseResponse` is a client config error, not an internal server error.

## Review

- Correct HTTP semantics: 400 > 500 for invalid client request.
- No functional regression risk.
- No tests needed beyond existing coverage.

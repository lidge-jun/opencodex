# Model availability error classification

## Problem

Account-gated native model selection inherited `CodexPoolAuthenticationError`, so every local
compatibility or capacity failure became HTTP 401 `invalid_api_key`. A healthy pool account that
did not support the selected model therefore looked like a broken credential.

## Change

- Added typed `unsupported` and `temporarily_unavailable` model-availability reasons.
- Mapped unsupported selections to 400 `invalid_request_error`.
- Mapped temporarily unavailable model-capable pools to 429 `rate_limit_error` with code
  `rate_limit_exceeded`.
- Reused the mapping on Responses, Images, Live, and Search surfaces.
- Preserved existing 401 behavior for actual pool credential failures.

## Verification

- Focused mapping tests cover 400, 429, and unchanged 401 behavior.
- The existing auth-context regression suite covers account-gated detours, exact selection,
  cooldowns, affinity, and reauthentication behavior.

# 180 — WebSocket Audit Remediation

External audit identified 15 issues across WebSocket, service, and config layers.
Source-code verification reduced actionable items to 5 VALID, 2 INVALID, 2 partially valid, 4 unchecked (low severity).

## Scope

### Patches (VALID)

| Doc | Issue | File | Change |
|-----|-------|------|--------|
| 10 | #3 Heartbeat stall | `src/bridge.ts` | Add bounded stall counter (150 ticks = 5 min); call `onCancel()` on timeout |
| 20 | #4 EOF misclassification | `src/bridge.ts` | Change synthesized terminal status from `completed` → `incomplete` |
| 30 | #5 JSON status overwrite | `src/ws-bridge.ts` | Preserve original `failed`/`incomplete` status in `sendResponsesJsonAsEvents()` |
| 40 | #10 Windows service restart | `src/service.ts` | Add retry loop to batch script for crash-restart parity with macOS/Linux |
| 50 | #11 atomicWriteFile race | `src/config.ts` | Use unique temp filename (`pid` + sequence) |

### Documentation only (INVALID / partial)

| Doc | Issue | Verdict | Reason |
|-----|-------|---------|--------|
| 60 | #1 OpenCode Go adapter | INVALID | Gateway provides unified OpenAI Chat interface; adapter split unnecessary |
| 60 | #6 WS response headers | INVALID | `safeResponseHeaders()` explicitly forwards all claimed headers |
| 60 | #2 Sidecar continuation | Partial | Concern is real but cited parameter `forceEmptyResponseId` doesn't exist |
| 60 | #7 Routed error headers | Partial | HTTP path loses headers; WS path preserves via `safeResponseHeaders()` |

## Verification

- `bun x tsc --noEmit`
- `bun test tests`
- `bun run src/cli.ts help`

# server.ts export contract (frozen for the split) - WP4

Date: 2026-07-01
Baseline: src/server.ts = 2322 lines. Full suite 974 pass / 0 fail before WP4.

## Public surface that MUST stay importable from ../src/server (barrel rule)

Functions (move target module in parens):
- registerTurn, unregisterTurn, isDraining, getActiveTurnCount,
  trackStreamLifetime, drainAndShutdown        (turn-lifecycle)
- resolveGuiFilePath, rootFallbackPayload       (gui-static)
- resolveAdapter                                (adapter-resolve)
- linkAbortSignal, disableResponsesRequestTimeout (responses-handler)
- nextRequestLogId, requestLogErrorCode, requestLogSpeedLabel,
  usageFromResponsesPayload, filterRequestLogs, responseWithDeferredRequestLog
                                                (request-log)
- relayWithAbort, relaySseWithHeartbeat, sanitizePassthroughHeaders
                                                (responses-handler)
- corsHeaders, isLoopbackHostname, isApiAuthRequired, assertServerAuthConfig,
  hasValidApiAuth, safeConfigDTO                (stays: auth/cors boundary)
- startServer                                   (stays: bootstrap)

Types: RequestLogContext, RequestLogEntry (keep exported from server.ts).

Re-exported FROM other modules today (must remain): clearThreadAccountMap,
formatCodexProviderForLog, resolveCodexAccountForThread (from ./codex-routing).

## Test import map (zero churn required)

- provider-registry-parity.test.ts: resolveAdapter
- server-auth.test.ts: assertServerAuthConfig, corsHeaders,
  disableResponsesRequestTimeout, hasValidApiAuth, isApiAuthRequired,
  isLoopbackHostname (+ more in its brace list)
- passthrough-headers.test.ts: sanitizePassthroughHeaders
- shutdown-drain.test.ts: registerTurn, unregisterTurn, isDraining,
  getActiveTurnCount, trackStreamLifetime
- request-log.test.ts: filterRequestLogs, nextRequestLogId,
  responseWithDeferredRequestLog, requestLogErrorCode, requestLogSpeedLabel,
  type RequestLogEntry
- api-usage.test.ts: startServer
- passthrough-abort.test.ts: linkAbortSignal, relaySseWithHeartbeat,
  relayWithAbort
- usage-shape-extraction.test.ts: usageFromResponsesPayload
- error-fidelity.test.ts: sanitizePassthroughHeaders

## Rule

server.ts becomes a barrel: every symbol above stays exported from
../src/server via re-export from ./server/<module>. No test import path
changes. tsconfig include ["src"] auto-compiles src/server/*. Release entry
(src/index.ts, src/cli.ts) does not import these deep paths - confirmed.

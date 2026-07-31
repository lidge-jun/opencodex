# server.ts split - progress (WP4, partial)

Date: 2026-07-01
Status: PARTIAL - 2 of 5 modules extracted; remaining 3 deferred to a dedicated session.

## Done (committed on dev, each green at commit)

- WP4.1 gui-static -> src/server/gui-static.ts (commit 177c06e). Moved
  findGuiDist/resolveGuiFilePath/isFile/serveGuiFile/rootFallbackPayload +
  MIME_TYPES. Path-depth (package.json + gui/dist) verified correct in BOTH the
  dev (src/) and packaged tarball (files:["src","gui/dist"]) layouts.
- WP4.2 adapter-resolve -> src/server/adapter-resolve.ts (commit 76e38ce). Moved
  ANTHROPIC_WIRE_MODELS/resolveWireProtocolOverride/resolveAdapter; dropped 6
  now-unused adapter-factory imports.

server.ts 2322 -> 2205 lines. Full suite 974/0 at each commit; tsc 0; zero test
import churn (barrel re-exports). gpt-5.5 review: APPROVE/CLEAR, path math
verified (.omo/evidence/server-extractions-code-review.md).

## Deferred (NOT done) - request-log + responses-handler + turn-lifecycle

These are tightly coupled and higher-risk; stopping here per the plan's
"STOP if a move reveals hidden coupling" rule rather than rushing them inside a
multi-WP loop:

- request-log: RequestLogContext is referenced across the data-plane handler
  that stays in server.ts; addFinalRequestLog / inspectResponseLogSsePayload /
  inspectResponseLogJson / httpStatusForTerminalStatus are shared with the relay
  functions (relayWithAbort, relaySseWithHeartbeat, responseWithDeferredRequestLog).
  The cluster also depends on ~10 externals (appendUsageEntry, appendUsageDebug,
  isUsageDebugEnabled, truncateForDebug, usageForFinalLog, usageStatusForFinalLog,
  usageTotalTokens, CODEX_CONFIG_PATH, readRootTomlString, readCodexCatalogPath).
- responses-handler: handleResponses + the relay functions form the data plane;
  extracting them requires moving request-log first (they share the helpers above).
- turn-lifecycle: small, but joins with runtime-state (already closed as no-op).

## Recommendation for the dedicated session

1. Extract request-log.ts as a SELF-CONTAINED module exporting the full cluster
   (buffer + addRequestLog + nextRequestLogId + error/speed + usageFromResponses
   Payload + applyResponseLogMetadata + inspect* + httpStatusForTerminalStatus +
   addFinalRequestLog + filterRequestLogs + RequestLogEntry/RequestLogContext).
   Keep addRequestLog injectable (relays already default-param it).
2. Then extract responses-handler.ts (handleResponses + relays), importing from
   request-log.
3. Keep the barrel rule: every currently-exported symbol stays importable from
   ../src/server. Add no behavior change; green at every commit.

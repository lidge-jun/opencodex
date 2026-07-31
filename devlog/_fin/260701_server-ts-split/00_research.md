# Split src/server.ts (2322 lines) into cohesive modules

Date: 2026-07-01
Surface: src/server.ts (HTTP/WS entry + data plane + management + logging).
Class: C4 (large structural refactor on the release-critical request path).
Status: SCAFFOLD - measured from code, plan drafted, NOT started.
Source: gajae/architect repo review (gpt-5.5), risk item 1 / priority 3.

## Measured facts (not estimates)

- wc -l src/server.ts -> 2322 lines (review said ~2.3k: confirmed).
- One file currently mixes: turn tracking + drain/shutdown, GUI static serving,
  adapter resolve + wire-protocol override, sidecar/quota outcome recording,
  request-log build + metadata inspection, the Responses data-plane handler,
  header-timeout/abort plumbing, and (via imports) the WS registry wiring.
- Representative symbols (line anchors, will drift):
  - turn/drain: registerTurn/unregisterTurn/isDraining/trackStreamLifetime
    /drainAndShutdown (~120-196)
  - GUI: findGuiDist/resolveGuiFilePath/serveGuiFile/rootFallbackPayload
    (~197-276)
  - adapter: resolveWireProtocolOverride/resolveAdapter (~282-309)
  - outcome recording: sidecarOutcomeRecorder/codexForwardTerminalOutcome...
    (~310-337)
  - data plane: handleResponses (~338-590+)
  - abort/timeout: linkAbortSignal/disableResponsesRequestTimeout
    /fetchWithHeaderTimeout (~677-745)
  - request log: addRequestLog/nextRequestLogId/requestLog*/applyResponseLog
    Metadata/inspectResponseLog* /httpStatusForTerminalStatus (~746-910+)

## Why this matters (and why it is NOT urgent)

- Review/regression cost grows with the file; new contributors must read 2.3k
  lines to touch one concern.
- BUT: this is a structure change with NO intended behavior change, and the
  request path is release-critical. So it ranks BELOW the two adapter bugs
  (anthropic reasoning gate, openai-chat EOF) which are real defects.

## Proposed target modules (cohesion, not line count)

Extract by concern, keeping server.ts as the thin wiring/entry:

1. src/server/turn-lifecycle.ts - activeTurns, draining, registerTurn,
   unregisterTurn, isDraining, getActiveTurnCount, trackStreamLifetime,
   drainAndShutdown. (See also runtime-state-consolidation plan - the mutable
   state may move there instead.)
2. src/server/gui-static.ts - findGuiDist, resolveGuiFilePath, isFile,
   serveGuiFile, rootFallbackPayload.
3. src/server/adapter-resolve.ts - resolveWireProtocolOverride, resolveAdapter,
   ANTHROPIC_WIRE_MODELS.
4. src/server/request-log.ts - addRequestLog, nextRequestLogId,
   requestLogErrorCode/SpeedLabel, applyResponseLogMetadata,
   inspectResponseLog*, usageFromResponsesPayload, httpStatusForTerminalStatus.
5. src/server/responses-handler.ts - handleResponses + its sidecar/quota
   outcome recorder helpers + abort/timeout plumbing.
6. src/server.ts - keep: fetch router, CORS/auth boundary, WS upgrade wiring,
   and the startServer bootstrap; import the above.

Keep exports stable where tests import them directly (e.g. registerTurn,
resolveGuiFilePath, nextRequestLogId, usageFromResponsesPayload). Prefer
re-exporting from server.ts during transition so test imports do not churn.

## Hard constraints

- ZERO behavior change. This is a move + re-wire only.
- The full suite (966 pass) must stay green at every commit, not just the end.
- No new module-level mutable state; if anything, consolidate (see separate
  runtime-state plan).
- Do it in small, independently-green commits (one module per commit), never
  one mega-commit.

## Sequencing (low-risk first)

1. gui-static (leaf, no state) -> 2. adapter-resolve (pure) ->
3. request-log (mostly pure + addLog injection) -> 4. turn-lifecycle ->
5. responses-handler (largest; do last, after the leaves are out).

## Open questions (resolve before starting)

- Do downstream tests import any of these as deep paths, or only via server.ts?
  Grep tests/ for each symbol first; that decides whether re-export shims are
  needed.
- Does the bundler/release (bun build) care about new files under src/server/?
  Confirm tsconfig include globs and the release script entrypoints.

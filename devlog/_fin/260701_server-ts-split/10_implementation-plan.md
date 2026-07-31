# server.ts split - jawdev implementation plan (PABCD work-phases)

Date: 2026-07-01
Status: SCAFFOLD - ready to execute under cxc-loop (one work-phase = one PABCD).
Prereq: the two adapter bug fixes (reasoning-none, eof-fail-closed) land first.
Co-dependency: 260701_runtime-state-consolidation decides the final home for
activeTurns / draining / nativePassthroughSseResponses BEFORE WP4 here.

## Measured contract (the safety net)

tsconfig: rootDir "src", include ["src"] -> any new src/server/*.ts is
auto-compiled; no tsconfig edit needed.

Release entrypoint: package.json exports "bun": "./src/index.ts"; scripts run
src/cli.ts. server.ts is NOT a build entrypoint, so splitting it cannot change
the published bundle as long as src/index.ts + src/cli.ts still resolve the same
exports transitively.

Tests import these symbols directly from ../src/server (MUST stay importable
from "../src/server" via re-export, or the test churns):

- resolveAdapter            (provider-registry-parity.test.ts)
- sanitizePassthroughHeaders (passthrough-headers.test.ts, error-fidelity.test.ts)
- linkAbortSignal, relaySseWithHeartbeat, relayWithAbort (passthrough-abort.test.ts)
- usageFromResponsesPayload (usage-shape-extraction.test.ts)
- startServer               (api-usage.test.ts)
- server-auth.test.ts, shutdown-drain.test.ts, request-log.test.ts import a
  brace-list set - enumerate before WP starts

RULE: server.ts becomes a barrel that re-exports every symbol it exports today.
No test import path changes in this whole effort. Verify with a pre-flight grep
(step P below) that captures the EXACT current export set.

## P - Plan / freeze the contract (work-phase 0)

1. grep -nE '^export ' src/server.ts -> write the full export list to
   11_export-inventory.md (the frozen public surface).
2. grep -rn 'from "../src/server"' tests/ -> map each imported symbol to its
   future module (table in 11_export-inventory.md).
3. Baseline evidence: bun x tsc --noEmit (0), bun test ./tests/ (record the
   exact pass count, currently 966/0), bun run privacy:scan (passed).
4. Confirm no deep test import like ../src/server/... exists yet (none today).

Exit P when the frozen export list + module map + green baseline are recorded.

## Work-phases (each = one full PABCD; commit must be green)

### WP1 - gui-static.ts (leaf, zero state)
- Move: findGuiDist, resolveGuiFilePath (exported), isFile, serveGuiFile,
  rootFallbackPayload (exported) -> src/server/gui-static.ts.
- server.ts: re-export resolveGuiFilePath, rootFallbackPayload from
  ./server/gui-static; import serveGuiFile internally.
- A-gate: gpt-5.5 reviewer confirms pure move, no logic delta.
- C-gate: tsc 0; bun test ./tests/ == baseline; privacy passed.

### WP2 - adapter-resolve.ts (pure)
- Move: resolveWireProtocolOverride, resolveAdapter (exported),
  ANTHROPIC_WIRE_MODELS -> src/server/adapter-resolve.ts.
- Re-export resolveAdapter from server.ts (provider-registry-parity.test.ts).
- Gates as WP1.

### WP3 - request-log.ts
- Move: addRequestLog, nextRequestLogId, requestLogErrorCode,
  requestLogSpeedLabel, filterRequestLogs, applyResponseLogMetadata,
  inspectResponseLogJson, inspectResponseLogSsePayload,
  usageFromResponsesPayload (exported), httpStatusForTerminalStatus,
  readConfiguredCodexServiceTier, catalogModelSupportsServiceTier.
- The in-memory requestLog buffer is module state -> see runtime-state plan;
  for now keep it co-located here and expose addLog via injection where
  handleResponses already passes it.
- Re-export nextRequestLogId, requestLogErrorCode, requestLogSpeedLabel,
  filterRequestLogs, usageFromResponsesPayload from server.ts.
- Gates as WP1. (request-log.test.ts, usage-shape-extraction.test.ts must stay
  green WITHOUT import edits.)

### WP4 - turn-lifecycle.ts
- Move: activeTurns, draining, registerTurn, unregisterTurn, isDraining,
  getActiveTurnCount, trackStreamLifetime, drainAndShutdown.
- DECISION GATE: coordinate with runtime-state-consolidation. If that plan is
  done first, these consume RuntimeState; if not, they keep module state here
  and expose it for reset. Do NOT move this state twice.
- Re-export the lot from server.ts (shutdown-drain.test.ts).
- Gates as WP1.

### WP5 - responses-handler.ts (largest; do last)
- Move: handleResponses + sidecarOutcomeRecorder, codexLogAccountId,
  usesCodexForwardPoolAuth, codexForwardTerminalOutcomeRecorder,
  linkAbortSignal (exported), disableResponsesRequestTimeout (exported),
  fetchWithHeaderTimeout, relayWithAbort (exported), relaySseWithHeartbeat
  (exported), responseWithDeferredRequestLog (exported),
  sanitizePassthroughHeaders (exported).
- server.ts keeps ONLY: the fetch router, CORS/auth boundary (corsHeaders,
  isLoopbackHostname, isApiAuthRequired, assertServerAuthConfig, hasValidApiAuth,
  safeConfigDTO), WS upgrade wiring, startServer bootstrap; imports the rest.
- Re-export every previously-exported symbol now living in responses-handler.
- A-gate: this is the high-risk move (data plane). Reviewer must diff that the
  handler body is byte-identical modulo import paths.
- C-gate: tsc 0; FULL bun test ./tests/ == baseline; privacy passed; plus a
  manual smoke: bun run src/cli.ts start boots and /healthz responds.

## D - close

Each WP records its own C-evidence block (commands + counts) in this folder
(20_wpN_verification.md). Final D: server.ts line count recorded, full suite
green, no test import changed. Then this entry moves to _fin per the
code-merged rule.

## Hard invariants (every WP)

- Pure move + re-wire. No behavior change, no signature change to exported fns.
- server.ts re-exports 100% of its current public surface (barrel).
- Green at EVERY commit (one module per commit), never a mega-commit.
- If a move reveals a hidden coupling that forces a logic change, STOP and
  record it as a separate finding; do not fold a behavior change into a move.

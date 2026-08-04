# 050 — Phase 5: split `src/server/responses.ts` (2146) into leaf modules + core engine

## The crux (from the symbol inventory)

`handleResponses` (`:895-1840`) and `handleComboResponses` (`:705-894`) are
MUTUALLY RECURSIVE: `handleComboResponses` calls `handleResponses` with
`comboAttempt: true` for every child attempt. They share the private contract
`HandleResponsesOptions` (`:593-607`) and `ConsumedComboFailure`
(`:584-591`). Forcing combo and core into separate modules creates an import
cycle (core→combo→core). The honest design keeps the mutually-recursive
request engine as ONE core module and extracts only the genuinely independent
leaf concerns.

No module-level mutable state exists in this file (verified). No production
`src/` file imports from `src/server/responses`; only 9 test files do, each
importing specific helpers. The facade must preserve every exported name at
this path.

## File map

NEW `src/server/responses/collaboration.ts` — the collaboration/injection
guidance concern (`:99-350`), all self-contained:
`buildToolBridgeMaps`, `PROACTIVE_MULTI_AGENT_MODE_TEXT`, `isV1CollabSurface`,
`collabSurface`, `MultiAgentGuidanceOptions`, `MultiAgentGuidanceDeps`,
`resolveEffectiveSubagentRoster`, `multiAgentGuidanceText`,
`V2_GUIDANCE_CHAR_BUDGET`, `applyInjectionPlaceholders`, `subagentRosterText`,
`injectDeveloperMessage`.

NEW `src/server/responses/encrypted-payload.ts` — ciphertext detection +
sanitization (`:353-499`): `looksLikeBackendCiphertext`, `FERNET_TOKEN_RUN`,
`AGENT_MESSAGE_ROUTING_ENVELOPE`, `AGENT_MESSAGE_CONTROL_PREAMBLE`,
`hasUnreadableEncryptedAgentTask`, `encryptedSlotParts`,
`hasEncryptedContentPart`, `sanitizeEncryptedContentInPlace`.

NEW `src/server/responses/compact.ts` — compact-response path
(`:1842-2094`): `linkAbortSignal`, `COMPACT_RESPONSE_MAX_BYTES`,
`compactResponseTooLargeError`, `bufferCompactResponse`,
`handleResponsesCompact`. `handleResponsesCompact` delegates non-native
compaction through a synthetic `/v1/responses` request → it imports
`handleResponses` from `./core` (one-way compact→core dependency; core never
imports compact, so no cycle).

NEW `src/server/responses/fetch-helpers.ts` — (`:2096-2146`):
`disableResponsesRequestTimeout`, `safeHostLabel`, `providerFetch`,
`fetchWithHeaderTimeout`.

NEW `src/server/responses/core.ts` — the mutually-recursive request engine
stays together: `handleResponses`, `handleComboResponses`,
`HandleResponsesOptions`, `ConsumedComboFailure`, `comboUnavailableResponse`,
`clientCancelledResponse`, `sanitizedRetryAfter`, `consumeComboFailure`,
`usageFromComboFailureText`, `createChildPassthroughCallbackGate`,
`buildComboChildHeaders`, plus the outcome/auth helpers that sit on the
combo/core seam and are called from the engine: `sidecarOutcomeRecorder`,
`codexLogAccountId`, `usesCodexForwardPoolAuth`,
`codexForwardTerminalOutcomeRecorder`, `decodeRequestErrorResponse`
(`:502-573`), and `isShadowSourceModel` (EXPORTED `:528`, used inside
`handleResponses` at `:977`, imported by
`tests/responses-shadow-intercept.test.ts:7` — it is an engine helper, so it
belongs in core.ts and is re-exported from the facade). `core.ts` imports the
leaf modules (collaboration,
encrypted-payload, fetch-helpers).

MODIFY `src/server/responses.ts` → thin facade: re-export the full prior
public surface from the five modules above. Target < ~200 lines.

## Symbols that resisted clean assignment (and their resolution)

- `sidecarOutcomeRecorder`/`codexLogAccountId`/`usesCodexForwardPoolAuth`/
  `codexForwardTerminalOutcomeRecorder`/`decodeRequestErrorResponse`:
  physically near encrypted-payload but semantically engine helpers → core.ts.
- `HandleResponsesOptions`/`ConsumedComboFailure`: the private core↔combo
  contract → core.ts (not exported; reaches tests only via
  `Parameters<typeof handleResponses>`, which the facade preserves).
- `linkAbortSignal`: generic but only compact uses it → compact.ts.

## Extraction risks (must hold in B)

- Combo recursion guard (`comboAttempt: true`) preserved inside core.ts.
- `createChildPassthroughCallbackGate` transactional delay/discard semantics
  unchanged (it closes over `HandleResponsesOptions`/`state`/`pending`/
  `accepted` — all stay in core.ts).
- Abort propagation (`options.abortSignal` checked before/during/after child
  attempts) unchanged.
- `handleResponsesCompact` keeps `CodexAuthContext`/`RequestLogContext`/
  provider-routing/outcome-recording behavior; only its module location
  changes.

## Verification (C)

1. `bun run typecheck`; `bun run test` (esp. the 9 importing suites:
   errors-adapter-failure, multi-agent-compat, fetch-header-timeout,
   v2-agent-message-failfast, combo-child-headers, server-combo-failover-e2e,
   effort-policy, openai-responses-passthrough, combos); `bun run privacy:scan`.
2. Import-surface check: `rg "from .*server/responses"` (excluding the new
   `responses/` subdir) shows only the pre-existing exported names — no new
   specifiers, no caller edits.
3. `wc -l src/server/responses.ts` < 800 (facade).
4. Combo failover e2e (`tests/server-combo-failover-e2e.test.ts`) is the
   activation proof for the recursion + callback-gate path — it must pass
   unchanged (C-ACTIVATION-GROUNDING-01: this suite drives the combo child
   failover trigger).

## SoT sync

Update the `structure/` note covering the Responses pipeline if present;
otherwise note the new `src/server/responses/` layout in D.

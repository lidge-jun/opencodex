# Phase 1 — WebSocket routed-adapter usage log parity

## Loop spec

- Archetype: spec-satisfaction repair.
- Trigger: Anthropic/routed adapter requests over `/v1/responses` WebSocket returned
  HTTP 200 but request logs showed `usageStatus: "unreported"` and no cache-token
  accounting.
- Goal: every successful routed-adapter WebSocket response path that is re-framed
  into Responses events feeds its payloads into request-log usage inspection before
  finalization.
- Non-goals: provider prompt-cache policy, GUI presentation changes, provider quota,
  OAuth/account work, `ocx` lifecycle commands. The running local proxy must not be
  restarted in this work-phase.
- Verifier:
  - `bun run typecheck`
  - `bun test tests/adapter-usage.test.ts tests/request-log.test.ts tests/ws-endpoint.test.ts tests/server-auth.test.ts`
- Stop condition: focused tests prove WebSocket SSE and JSON fallback re-framing both
  expose usage-bearing payloads to log observation, and the routed Anthropic WS
  integration log reports usage + terminal metadata.
- Memory artifact: this devlog unit plus cxc ledger.
- Expected terminal outcome: DONE. Use BLOCKED only if the test harness cannot run
  locally without restarting `ocx`.
- Escalation: NEEDS_HUMAN if the fix requires changing live provider config or
  restarting/stopping the user's running proxy.

## Code facts

- `src/server.ts` owns request-log metadata extraction:
  - JSON responses: `inspectResponseLogJson`.
  - SSE payloads: `inspectResponseLogSsePayload`.
  - final rows: `addFinalRequestLog`.
- HTTP/SSE `/v1/responses` already uses `responseWithDeferredRequestLog`, so SSE
  payloads are inspected as the response body is consumed.
- native passthrough already consumes a duplicated stream for response-log metadata.
- WebSocket routed-adapter delivery goes through `sendResponseToWebSocket` and
  `pumpResponsesSseToWebSocket`, so that bridge needs an explicit observation hook.

## Diff-level plan

### MODIFY `src/ws-bridge.ts`

- Keep `onSsePayload` on `pumpResponsesSseToWebSocket` and `sendResponseToWebSocket`.
- For text/event-stream and sniffed-SSE bodies, invoke the observer for each
  non-`[DONE]` data payload before forwarding the frame.
- Extend the JSON fallback path so synthesized Responses event payloads are also
  observable. This closes the same bug class if an upstream/provider returns
  `application/json` despite the WebSocket handler forcing `stream: true`.
- Observer failures remain non-fatal to WebSocket delivery.

### MODIFY `src/server.ts`

- In the WebSocket `response.create` handler, pass observed payloads to
  `inspectResponseLogSsePayload(logCtx, payload)`.
- Finalize terminal WebSocket logs with both `terminalStatus` and
  `closeReason: "terminal"` so the request-log row has the same completion shape
  as other completed Responses paths.

### MODIFY `tests/ws-endpoint.test.ts`

- Assert SSE pumping observes the payloads it forwards.
- Add/extend JSON fallback coverage so `sendResponseToWebSocket` reports the
  synthesized `response.completed` payload to the observer.

### MODIFY `tests/server-auth.test.ts`

- Add an integration test with a fake Anthropic upstream emitting cache-read,
  cache-creation, input, and output usage over SSE.
- Drive the request through the WebSocket endpoint and assert the request log reports:
  `status: 200`, `terminalStatus: "completed"`, `closeReason: "terminal"`,
  `usageStatus: "reported"`, `totalTokens: 29`,
  `inputTokens: 25`, `outputTokens: 4`, `cachedInputTokens: 5`.

## Out of scope guard

- Do not run `ocx restart`, `ocx stop`, `ocx start`, `ocx ensure`, or `ocx sync`.
- Do not edit unrelated OAuth, provider-api-key, GUI, quota, or structure-doc changes
  already present in the dirty worktree.

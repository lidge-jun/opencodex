# Phase 1 — Bug A: forward-mode previous_response_id strip + passthrough state recording

## Audit amendments (verdict PASS-WITH-FIXES, applied)
- WS `/v1/responses` is CONVERTED to internal HTTP POST (src/server.ts:2525 -> handleResponses ->
  buildRequest), so there is no raw-WS chaining that always-strip could break: forwarding the
  param to the ChatGPT HTTP backend is a guaranteed 400. Always-strip in forward mode stands,
  BUT the unexpanded-miss case must be logged (console.warn in server.ts) since it means the
  delta may lack earlier context.
- Passthrough recording is dead code without a store:false bypass (codex-rs sends store:false
  on non-Azure HTTP and WS inherits it). Add `{ force: true }` option to rememberResponseState
  used ONLY by the passthrough branch (in-memory, 1h TTL, proxy-internal continuation cache —
  same spirit as the Cursor conversation-id tracking).
- Recording guard: never record when the request carried an unexpanded previous_response_id
  (would store truncated history); record only when `!parsed.previousResponseId ||
  parsed._previousResponseInputExpanded`.

## Changes

### MODIFY src/adapters/openai-responses.ts
- `stripPreviousResponseId(body, strip)` with `strip = provider.authMode === "forward"
  || parsed._previousResponseInputExpanded`. Forward mode: ChatGPT Codex backend rejects the
  param categorically (metapi#504, Locus#35), so stripping can only improve outcomes. Api-key
  mode (`/v1/responses`, platform supports the param + real server-side store): unchanged —
  strip only after proxy expansion.

### MODIFY src/server.ts (passthrough branch)
- Warn on unexpanded miss for forward passthrough: `parsed.previousResponseId` set,
  `_previousResponseInputExpanded` falsy → console.warn (id + model) so truncated-context
  turns are diagnosable.
- Record completed passthrough responses into the replay store so the NEXT turn's
  `previous_response_id` can be expanded to full input instead of arriving as a naked delta:
  - SSE path: extend `consumeForInspection` AND `consumeForResponseLogMetadata` (both are the
    tee-branch consumers of the passthrough SSE) with an optional `onCompletedResponse(response)`
    callback fired when a block parses to `{type:"response.completed", response:{...}}`.
  - JSON path (content-type application/json, upstreamResponse.ok): parse text, call
    `rememberResponseState`.
  - Both gated by the recording guard above and passed `{ force: true }`.

### MODIFY src/responses/state.ts
- `rememberResponseState(requestBody, response, conversationId?, opts?: { force?: boolean })`:
  `force` bypasses only the `store === false` skip. Existing callers unchanged.

## Tests
- tests/openai-responses-passthrough.test.ts:
  - forward mode: unexpanded delta request → `previous_response_id` ABSENT from body (new behavior).
  - api-key mode (authMode key): unexpanded → field PRESERVED (platform semantics unchanged);
    expanded → stripped. (Rewrites the existing "drops only after proxy-expanded replay" test
    into the two-mode matrix.)
- tests/responses-state.test.ts: `force: true` records despite store:false and enables next-turn
  expansion; without force, store:false still skips (existing behavior locked).

## Accept
- bun test + tsc green; forward body never contains previous_response_id.

# 010 — Phase 1: Adapter terminal truth (classes 1, 2, 3)

One PABCD cycle. Foundation phase: routed adapters must never promote a
truncated/corrupted upstream stream to a clean `done`, and terminal reasons
must survive to the bridge.

## Scope

IN:
- src/adapters/google.ts (parseStream EOF/malformed/finishReason handling)
- src/adapters/anthropic.ts (early-EOF false done)
- src/adapters/openai-chat.ts (finish_reason -> stopReason propagation)
- src/bridge.ts (done-case stopReason mapping extension only)
- tests: google-hardening / google-vertex-stream / anthropic stream suites /
  openai-chat-eof / openai-chat-hardening / bridge tests for new mapping

OUT: chat outbound policy (phase 3), incomplete caching (phase 2),
heartbeat/stall (phase 4), Kiro/Cursor adapters (already fail-closed).

## File change map

### 1. src/adapters/google.ts — MODIFY parseStream (~336-440)

Current (verified):
```ts
for (const line of lines) {
  if (!line.startsWith("data: ")) continue;
  const payload = line.slice(6).trim();
  ...
  } catch { debugDroppedFrame(...); continue; }
...
// EOF: unconditional
yield { type: "done", usage: pendingUsage };
```

Changes:
- (a) Track `sawAnyFrame` and `sawTerminalSignal` (a parsed candidate with
  `finishReason` or usage-bearing final chunk — A-gate fold: this is the
  ONLY terminal-signal definition; a parsed content frame is NOT one
  (otherwise truncated-after-text completes clean, which is class 1
  itself). Real Gemini streams always end with finishReason+usage, so
  this tightening breaks no existing test). At EOF, FIRST flush the
  streaming decoder (`buffer += decoder.decode()`) so partial UTF-8 bytes
  held inside TextDecoder surface into the string buffer (A-gate finding:
  today a valid STOP followed by truncated UTF-8 bytes never reaches
  `buffer` and completes clean), THEN inspect the residual `buffer`: if
  non-empty after trim, attempt the same frame handling; a residual that
  is not a valid frame => truncation evidence.
- (b) Malformed `data:` JSON: stop dropping silently. Yield
  `{ type: "error", message: "malformed upstream SSE data frame" }` and
  return (mirrors openai-chat.ts:626-629). Keep debugDroppedFrame for the
  non-`data:` line class only.
- (c) Accept `data:` without trailing space (protocol variant) by matching
  `line.startsWith("data:")` and slicing 5, then trimming — do NOT switch to
  the shared decoder in this phase (google frames carry no multi-line data;
  keep the diff surgical).
- (d) EOF without any terminal signal (no finishReason AND no usage —
  definition unified per (a)): yield error "upstream stream ended without
  a terminal signal — possible truncation" (mirrors
  openai-chat.ts:724-726).
- (e) Propagate finishReason on the terminal done:
  `lastFinishReason === "MAX_TOKENS"` -> `yield { type: "done", usage,
  stopReason: "max_tokens" }`; SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT
  /SPII -> `stopReason: "content_filter"`. Other/absent -> plain done.
  Keep the existing Vertex truncation-with-tool-calls error guard first.

### 2. src/adapters/anthropic.ts — MODIFY parseStream tail (~717-821)

Current (verified): `if (pendingUsage && !emittedDone) yield* emitDone();`

Change:
- EOF tail becomes: if `!emittedDone`:
  - `pendingStopReason !== undefined` (compatible providers that skip
    message_stop but reported stop_reason in message_delta) -> emitDone()
    with stopReason mapped: "max_tokens" -> "max_tokens",
    "refusal"/"content_filter" -> "content_filter", else undefined.
  - else if `pendingUsage` only (message_start then silence) ->
    `yield { type: "error", message: "upstream stream ended before
    message_stop — possible truncation" }`.
  - else (nothing at all) -> error (same message). Never silent done.
  (A-gate note: `pendingStopReason` is in scope at the EOF tail —
  anthropic.ts:727 declaration, :806 write, :820 read. Mapping stays
  local to the EOF branch; shared emitDone keeps its current behavior.)

### 3. src/adapters/openai-chat.ts — MODIFY handleDataLine + EOF (~595-730)

Current (verified): `let sawFinish = false` boolean only.

Change:
- Replace boolean with `let finishReason: string | undefined`; set from
  `choices[0].finish_reason` where sawFinish is set today (:647-650); keep a
  derived `sawFinish = finishReason !== undefined` semantic for the EOF
  guard (:722).
- Terminal done events (both the [DONE] path :617 and the EOF graceful path
  :728) carry stopReason mapping: "length" -> "max_tokens",
  "content_filter" -> "content_filter", everything else/absent -> omit.

### 4. src/bridge.ts — MODIFY done case (~653)

Current: `if (event.stopReason === "max_tokens") { ... incomplete ... }`.

Change: extend to also map `event.stopReason === "content_filter"` ->
`response.incomplete` with `incomplete_details: { reason: "content_filter"
}`. Chat outbound already understands that reason (outbound.ts:325-326).

## Accept criteria + activation scenarios (C-ACTIVATION-GROUNDING-01)

1. Google stream whose final chunk JSON is truncated mid-object ->
   adapter yields error, bridge emits response.failed. Activation: test
   drives parseStream with a crafted chunk split; assert error event.
2. Google stream with EOF-residual frame lacking trailing newline -> frame
   still parsed (no event loss). Activation: residual-buffer test.
2a. Google stream with a valid STOP terminal followed by partial UTF-8
   bytes (incomplete multi-byte sequence at socket EOF) -> error, not
   clean done. Activation: crafted byte chunks ending mid-codepoint.
2b. Google stream with malformed residual (non-frame garbage) after the
   last valid frame -> error.
3. Google stream ending with zero terminal signal -> error, not done.
4. Google MAX_TOKENS text-only stream -> done stopReason "max_tokens" ->
   bridge response.incomplete max_output_tokens. (Existing Vertex guard
   with tool calls stays an error — pinned by google-vertex-stream tests.)
5. Anthropic stream: message_start + clean EOF -> error. Anthropic stream
   with message_delta stop_reason + EOF (no message_stop) -> done, no
   error (compatible-provider guard, pinned by
   anthropic-compatible-stream.test.ts).
6. openai-chat stream with finish_reason "length" -> done stopReason
   "max_tokens" -> bridge incomplete. finish_reason "content_filter" ->
   incomplete content_filter.
7. `bun run typecheck` green; focused suites green:
   `bun test tests/google-hardening.test.ts tests/google-vertex-stream.test.ts
   tests/anthropic-compatible-stream.test.ts tests/openai-chat-eof.test.ts
   tests/openai-chat-hardening.test.ts tests/bridge-lifecycle.test.ts`.

## Risks

- Anthropic-compatible providers that omit message_stop AND stop_reason:
  they now fail-closed. Mitigation: error message names the missing
  terminal; this is the intended truthfulness trade-off (a silent truncation
  is worse than a visible failure).
- Test updates in B (A-gate verified NO existing test goes mechanically
  RED): EXTEND google-vertex-stream.test.ts:57 ("MAX_TOKENS with NO tool
  call still completes") with `done.stopReason === "max_tokens"` and add
  the bridge-level pin (response.incomplete max_output_tokens); add
  message_stop to the umans-provider.test.ts:146 fixture so its truncated
  shape is not left as "normal"; all new accept criteria are written
  RED-first.

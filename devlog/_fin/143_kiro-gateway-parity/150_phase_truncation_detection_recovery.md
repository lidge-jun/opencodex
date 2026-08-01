# Phase 150 (P2) - Kiro truncation detection and recovery

## Trigger

The original parity map and external review both flag Kiro truncation recovery
as missing. Current `parseKiroStream()` closes an open tool call and emits
`done` when the eventstream ends, even if the tool input never received a stop
event. That can turn an upstream cut-off into a successful Codex tool call with
partial or invalid JSON.

`kiro-gateway` has a broader truncation recovery subsystem. opencodex should at
least stop silently completing truncated Kiro tool calls and surface a clear,
redacted upstream truncation failure.

## Current state

- `src/adapters/kiro.ts` parses Kiro event JSON inline.
- A Kiro tool call is emitted as soon as a `name`/`input` event arrives.
- At stream EOF, `parseKiroStream()` currently emits `tool_call_end` for any
  open tool and then emits `done`.
- `bridge.ts` already treats an adapter `error` event as `response.failed`, and
  treats a generator EOF without `done`/`error` as `response.incomplete`.
- `bridge.ts` sets its upstream activity flag once per adapter event before the
  switch dispatch, so an internal non-visual event can keep the stream alive
  without sending Codex-visible output.
- Kiro returns no authoritative usage frame, so ordinary text-only EOF must
  continue to be treated as normal completion.

## Diff plan

### ADD `src/adapters/kiro-truncation.ts`

Create a small helper module:

- `kiroTruncationReason(parsed: Record<string, unknown>): string | undefined`
  - Detect explicit truncation markers in event JSON:
    `finish_reason`, `finishReason`, `stop_reason`, `stopReason`,
    `completionReason`, `reason`, or `truncated: true`.
  - Treat string values containing `length`, `max_token`, `max-tokens`,
    `truncate`, `truncated`, `incomplete`, or `context_length` as truncation.
- `isCompleteKiroToolInput(input: string): boolean`
  - Treat empty input as complete only after a real Kiro `stop` event.
  - Parse non-empty accumulated input as JSON and require an object/array root.
- `kiroTruncationErrorMessage(reason?: string): string`
  - Return a user-facing, redacted message:
    `Kiro response truncated upstream before the tool call completed...`

### MODIFY `src/adapters/kiro.ts`

- Import the helper module.
- Extend `ParsedKiroEvent` with `type: "truncation"`.
- In `parseKiroEvent()`, return a truncation event when
  `kiroTruncationReason(parsed)` detects an explicit marker.
- Change `parseKiroStream()` tool handling:
  - Buffer Kiro tool starts/input chunks internally.
  - Emit `tool_call_start`, `tool_call_delta`, and `tool_call_end` only after a
    real Kiro `stop` event.
  - Preserve chunk boundaries when flushing a completed tool call.
  - Ignore duplicate `name` starts for the same open tool before input arrives.
  - Yield internal `{ type: "heartbeat" }` events while buffering Kiro tool
    start/input events so the streaming bridge does not falsely stall-timeout
    during long but active tool-call generation.
  - On Kiro eventstream `exception`/`error` frames, discard any buffered
    unflushed tool call and emit only the upstream error. Do not yield
    `tool_call_end`, because no matching `tool_call_start` has been sent to the
    bridge under the buffering model.
  - If a new tool/content/truncation/EOF arrives while a tool is still open
    without `stop`, emit `error` with `kiroTruncationErrorMessage()` and return.
  - Do not emit `done` after a truncation error.
- Keep normal text-only EOF as `done` because Kiro has no usage terminal.
- Keep stream exception/error frame behavior from Phase 70 unchanged.

### MODIFY `src/types.ts`

- Add a non-visual adapter event:
  `{ type: "heartbeat" }`.
- This event is internal to the proxy. It has no Responses API output item and
  carries no user-visible content.

### BRIDGE BEHAVIOR (no code change)

- Do not modify `src/bridge.ts`; it is already over the repo line limit.
- `bridgeToResponsesSSE()` already sets `activity = true` before dispatching on
  `event.type`, so `heartbeat` resets stall tracking even with no switch case.
- `buildResponseJSON()` has no default side effect for unknown event variants,
  so `heartbeat` is naturally non-visual. Add tests to lock this behavior.

### MODIFY `tests/kiro-stream.test.ts`

Add regression tests:

- Normal completed tool call still emits start/delta/end/done in the same final
  event order, even though Kiro events are buffered until stop.
- Tool input stream ending mid-JSON without stop emits a clear truncation error,
  no `done`, and no partial `tool_call_delta`.
- Tool input stream ending with valid JSON but without stop is still treated as
  truncation because the upstream did not complete the tool call.
- Explicit Kiro length/truncation marker emits the truncation error and no
  `done`.
- Duplicate tool `name` events before input do not create duplicate tool calls.
- Buffered tool input emits internal `heartbeat` events that tests can observe,
  but bridge tests prove they are not Codex-visible.
- Update the existing `exception mid-stream closes an open tool call then stops`
  regression to the new fail-closed behavior: if the tool was buffered and not
  stopped, expect only heartbeat/internal activity plus the upstream error, with
  no client-facing `tool_call_start`/`tool_call_end`.

### MODIFY `tests/bridge.test.ts`

- Add a regression proving `heartbeat` events do not create SSE output items,
  do not change non-streaming JSON output, and still allow surrounding normal
  events to complete.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-stream.test.ts tests/bridge.test.ts tests/error-fidelity.test.ts`
- `wc -l src/adapters/kiro.ts src/adapters/kiro-events.ts src/adapters/kiro-truncation.ts src/types.ts tests/kiro-stream.test.ts tests/bridge.test.ts`

## Commit

`fix(kiro): surface truncated tool-call streams`

## Explicit non-goals

- No full gateway-style persistent recovery memory.
- No attempt to classify ordinary text EOF as truncation without an explicit
  marker; Kiro has no terminal usage frame, so that would create false
  positives.
- No user-visible heartbeat or progress output. The new `heartbeat` event is
  internal and ignored by response builders.

## Completion evidence

- Implemented in `c3b10c9`:
  - Added `src/adapters/kiro-events.ts` for Kiro event JSON parsing and
    explicit truncation marker detection.
  - Added `src/adapters/kiro-truncation.ts` for truncation reason detection,
    tool-input completeness checks, and user-safe truncation messages.
  - Updated `src/adapters/kiro.ts` to buffer tool starts/input until a real
    stop event, emit internal `heartbeat` events while buffering, and fail
    closed on EOF, exception/error, explicit truncation markers, or content
    before tool stop.
  - Added internal `{ type: "heartbeat" }` to `AdapterEvent`.
  - Added regression tests in `tests/kiro-stream.test.ts` and
    `tests/bridge.test.ts`.
- Local verification:
  - `bun x tsc --noEmit` passed.
  - `bun test tests/kiro-stream.test.ts tests/bridge.test.ts tests/error-fidelity.test.ts`
    passed: 42 tests.
  - Line counts stayed under 500 for touched files:
    `kiro.ts` 478, `kiro-events.ts` 42, `kiro-truncation.ts` 33,
    `types.ts` 347, `kiro-stream.test.ts` 413, `bridge.test.ts` 213.
- Independent verifier:
  - Backend verifier reported DONE with the same typecheck, target tests, and
    line-count evidence.
  - It confirmed `src/bridge.ts` was intentionally not modified; heartbeat is
    non-visual because existing bridge code marks activity before the switch and
    has no output-producing heartbeat case.

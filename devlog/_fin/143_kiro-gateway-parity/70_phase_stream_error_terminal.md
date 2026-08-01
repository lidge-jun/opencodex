# Phase 70 (P0-1) - Stream exception/error is terminal

## Problem
parseKiroStream (kiro.ts ~407-414) on a CW eventstream frame with
:message-type == "exception"|"error" yields an `error` AdapterEvent then
`continue`s the loop. When the loop ends it ALSO yields `done` with usage.

Downstream (bridge.ts 351-377): `done` -> response.completed; `error` ->
response.failed. Both set terminated=true. So whichever the bridge sees FIRST
wins, but the generator keeps yielding post-exception content and a trailing
`done`. A failed upstream call can leak partial content and a success-shaped
`done`, and the generator wastes work after termination.

## Fix
On an exception/error frame: yield the `error` event and `return` immediately
(terminal). Do not parse further frames, do not emit `done`.

### MODIFY src/adapters/kiro.ts (in parseKiroStream loop)
Before:
    if (mt === "exception" || mt === "error") {
      yield { type: "error", message: ... };
      continue;
    }
After:
    if (mt === "exception" || mt === "error") {
      if (open) yield { type: "tool_call_end" }; // close any dangling tool call
      yield { type: "error", message: ... };
      return; // terminal: no further frames, no done
    }

Rationale for closing `open`: keeps tool-call bracketing balanced for the
bridge's closeCurrentToolCall path even on the error route.

## Tests (tests/kiro-adapter.test.ts, add cases)
- exception frame mid-stream -> yields error, NO done after it, no further text.
- exception frame before any content -> yields error only, no done.
- (existing) exception-only test updated to assert absence of trailing done.

## Verify
bun x tsc --noEmit + bun test tests/kiro-adapter.test.ts

## Commit
fix(kiro): treat upstream exception/error frames as terminal (no trailing done)

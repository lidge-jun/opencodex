# Phase 85 (P0 user-visible leak) - Hide Kiro <thinking> blocks

## Trigger

The user observed a Kiro response exposing a raw leading block:

    <thinking> ... </thinking>

This is a user-visible leak. It must be routed as reasoning output, not normal
assistant text.

## Root cause

Kiro emits fake-thinking content as ordinary CodeWhisperer `content` chunks.
`parseKiroStream` currently forwards every content chunk as `text_delta`, so
the bridge emits it as `response.output_text.delta` and the UI displays the raw
tags and internal reasoning text.

The bridge already supports hidden/raw reasoning through AdapterEvent
`reasoning_raw_delta`, which becomes `response.reasoning_text.delta`.

## File changes

### ADD src/adapters/kiro-thinking.ts

Add a small streaming FSM:

- detect only a leading `<thinking>`, `<think>`, or `<reasoning>` block
- tolerate opening/closing tags split across chunks
- emit content inside the block as `reasoning_raw_delta`
- emit text after the closing tag as `text_delta`
- if no leading thinking tag appears, flush buffered prefix as normal text
- if stream ends while inside a thinking block, flush buffered content as raw
  reasoning (no raw tags)
- after the first text is emitted, do not parse later literal tags

### MODIFY src/adapters/kiro.ts

- import `KiroThinkingParser`
- instantiate it once per `parseKiroStream`
- for `content` events, feed text into the parser and yield parser-produced
  events instead of always yielding `text_delta`
- on stream end, flush parser-finalized events before usage `done`
- count output usage from visible text + reasoning text, but never include raw
  tags

### MODIFY tests/kiro-adapter.test.ts

Add parseStream regression tests:

- leading `<thinking>raw</thinking>answer` -> `reasoning_raw_delta:raw`,
  `text_delta:answer`, no text event containing `<thinking>`
- opening and closing tags split across chunks are parsed
- non-leading literal `<thinking>` inside normal answer remains visible text
- unterminated leading thinking block flushes as reasoning at stream end

## Verify

- bun x tsc --noEmit
- bun test tests/kiro-adapter.test.ts tests/kiro-images.test.ts tests/bridge.test.ts

## Commit

fix(kiro): route leading thinking blocks as reasoning

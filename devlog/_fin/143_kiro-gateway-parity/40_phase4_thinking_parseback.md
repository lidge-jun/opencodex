# Phase 40 — Response-side thinking block parse-back

## Problem
opencodex injects request-side thinking tags (kiro.ts 196-209) but does not
parse <thinking>/<think>/<reasoning> blocks OUT of the response stream. Gateway
(thinking_parser.py) runs an FSM that detects a leading thinking block and emits
it as reasoning_content separate from visible text.

## Plan (finalized in this phase's P)
- Add a streaming FSM in the kiro parse path: detect a thinking block ONLY at the
  start of the response; buffer until close tag; emit AdapterEvent reasoning
  deltas (matching how other opencodex adapters surface reasoning), then switch
  to normal text_delta for the remainder.
- Handle tag split across SSE chunks (FSM buffers partial tags).
- Once closed, no further thinking detection (later literal tags pass through).

## Tests
- "<thinking>plan</thinking>answer" -> reasoning="plan", text="answer".
- tag split across chunks -> still parsed.
- no thinking block -> all text, no reasoning event.
- thinking tag NOT at start -> treated as text.

## Commit
feat(kiro): surface response <thinking> blocks as reasoning (gateway parity)

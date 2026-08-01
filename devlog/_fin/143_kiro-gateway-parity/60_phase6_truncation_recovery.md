# Phase 60 — Truncation detection / recovery

## Problem
Gateway (truncation_recovery.py, Issue #56) detects when Kiro truncates large
tool-call payloads or content mid-stream and injects a synthetic message so the
model adapts. opencodex kiro swallows truncation silently.

## Plan (finalized in this phase's P)
- Detect truncation signals in the eventstream (incomplete tool_input JSON at
  stream end, or an explicit truncation marker if CW sends one).
- On detection, emit a clear AdapterEvent (text or error annotation) so the
  turn surfaces "(response truncated upstream)" rather than producing invalid
  partial tool JSON.
- Guard: only activate when truncation is actually detected (no false positives
  on normal completion).

## Tests
- tool_input stream ends mid-JSON -> truncation surfaced, no invalid tool call.
- normal completion -> no truncation event.

## Commit
feat(kiro): detect and surface upstream truncation (gateway parity)

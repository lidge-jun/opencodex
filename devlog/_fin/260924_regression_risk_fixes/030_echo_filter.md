# Tool-envelope echo filter

Defect: src/lib/tool-envelope-echo-filter.ts ToolEnvelopeEchoFilter.feed matches as soon as a line starts with a marker (probe === marker) and drops that line and everything after it. The filter arms on almost every Codex agentic turn (input carrying tool calls/outputs or previous_response_id), so a legitimate line such as "[Tool Result] shows the build passed." silently truncates the answer. The replayed envelope OpenCodex builds is always a marker alone on its line ("[Tool Result]\n<payload>", protobuf-request.ts), and the replay-side stripper in cursor/envelope-echo.ts already requires whole-line markers.

Change (tool-envelope-echo-filter.ts only):

- feed: a line that equals a marker is kept pending (candidate) instead of matching immediately; trailing spaces/CR after a marker stay candidates; a "[Tool call:" line stays pending up to a bounded length (MAX_CALL_LINE = 4096) and is released as prose beyond it.
- completeLine decides: whole-line marker (exact after trimEnd) or a "[Tool call:" line ending with "]" is an echo (outside a fence: match; inside: hold as today). Anything else is prose.
- finish applies the same whole-line rule to an unterminated last line; a truncated marker prefix ("[Tool Res") or an unterminated "[Tool call:" line at stream end still counts as an echo, as today.

Tests (new tests/lib/tool-envelope-echo-whole-line.test.ts): prose starting with a marker survives whole and char-by-char; marker alone mid-answer still drops the tail; "[Tool call: x (call_id: 1) with args: {}]" line drops; final unterminated "[Tool Result] header text" survives; existing passthrough-grok-upstream-envelope-echo and cursor-envelope-echo-retry tests keep passing.


## Audit fold (round 1 FAIL)

Two Cursor paths share the marker vocabulary:

- The replay-side stripper isEchoMarkerLine (src/adapters/cursor/envelope-echo.ts) was whole-line at 685321e297 (exact marker) and #5676 widened it to prefix matching, so assistant history prose such as "[Tool Result] shows ..." is now stripped with its following non-blank lines. Restore whole-line semantics: trimmed line equals a marker (with or without the closing bracket for the truncated forms), or a "[Tool call:" line that ends with "]". Test it.
- The first-bytes prefix sniffer CursorEnvelopeEchoSniffer is unchanged since before the round (probe.startsWith(marker) at 685321e297) and triggers a remint retry rather than truncation. Not a regression of the round; left as is and recorded.

finish() replaces the startsWith(truncated marker) rule with: exact truncated prefix of a marker, whole-line marker, or an unterminated "[Tool call:" line. Tests cover CRLF, trailing whitespace, fenced markers, streaming char-by-char and the buffered Responses JSON path (stripGrokUpstreamEnvelopeEchoFromResponsesJson).


## Audit round 2 rebuttal

The Cursor first-bytes sniffer stays out of scope: it predates the round (685321e297) and its false positive costs a remint retry, not a truncated answer. Narrowing a pre-existing echo guard is a separate decision; recorded as a residual.

## Build note

The "[Tool call:" line keeps its prefix rule instead of the planned completed-line rule. An existing Cursor replay test showed why: a call echo wraps when its arguments do ("[Tool call: Glob" then "args"), so a completed-line rule leaks it. Prose that opens with "[Tool call:" is rare, while "[Tool Result] ..." prose is common, so only the result/error markers move to the whole-line rule. The diff review flagged the prefix rule; this is the recorded reason for keeping it.

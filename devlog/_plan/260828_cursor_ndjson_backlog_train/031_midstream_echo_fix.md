# 031 — wp4 diff spec: mid-stream envelope-echo detection (PR B1)

Evidence base: 021 F1/F2 — run-03 (macmini-cf) streamed three verbatim
"[Tool Result] [tool_result] call_id: ... output: ..." blocks INSIDE an
agent message, after legitimate leading text. The existing
CursorEnvelopeEchoSniffer stops looking after the first 40 bytes of the
turn (envelope-echo.ts MAX_SNIFF_BYTES), so mid-message echoes reach the
client uncorrected. One echoed block also carried the corrupted call-id
"fc_63367283 mar-2aec-..." (F2, 080's "mar" signature) — the model is
echoing the flattened replay envelope it was primed with.

## Branch/PR

Stays on the current stack: branch codex/cursor-midstream-echo, based on
codex/runturn-backlog-coalesce head (stacked PR; base PR #2774 targets
dev, this PR targets codex/runturn-backlog-coalesce until #2774 lands).
Rationale: same devlog unit carries both; no src overlap, but the devlog
history is linear on this chain.

## Changes

### 1. MODIFY src/adapters/cursor/envelope-echo.ts — mid-stream detector

ADD class CursorMidstreamEchoObserver (A-gate blockers 1/3/4 folded):
- DIAGNOSTIC-ONLY: feed(textDelta) NEVER throws and never withholds
  output. It returns void; findings are exposed via a findings() getter
  read by the caller at turn end (and opportunistically after each feed).
- Detection: maintain lastLineStartBuffer — the text since the most
  recent newline, capped at 128 chars (indentation beyond that disarms
  matching for that line; bounds the \s* concern). A marker fires when
  the post-newline line, after <=128 chars of leading whitespace, starts
  with "[Tool Result]", "[tool_result]", or "[Tool Error]", at an offset
  BEYOND the prefix-sniffer window. Marker split across deltas is handled
  naturally because the line buffer accumulates across feeds.
- Corruption observation: after a marker fires, the observer enters a
  post-marker window (next 512 chars) watching for the call-id lines. It
  records callIdCorrupt=true when the window contains /fc_[0-9a-f]+\s+mar-/
  (the observed "space + mar-" splice) or a call_id line whose token is
  split by whitespace (/call_id: \S+\s+\S+_0/). Only booleans and
  numeric offsets are retained; window text is discarded after the check.
- findings(): { echoes: Array<{ marker, offset, callIdCorrupt }> } —
  capped at 8 entries per turn.
- Bound: scanning disarms after MAX_MIDSTREAM_SCAN_LENGTH = 512 * 1024
  UTF-16 code units of cumulative fed text. A delta crossing the cap is
  scanned up to its end (the cap is checked between feeds, not mid-delta),
  so text before the boundary is never skipped.

### 2. MODIFY src/adapters/cursor.ts — arm + exactly-once feeding

- Arm CursorMidstreamEchoObserver under the same armEchoSniffer condition.
- Exactly-once feed (A-gate blocker 2): introduce one helper
  emitTextObserved(event) that (a) feeds observer.feed(event.text) then
  (b) emits. BOTH release paths route through it: releaseGuardHeld()'s
  per-held-event emit for text deltas, and the ordinary post-guard emit at
  cursor.ts:~324. Held deltas are NOT fed while held — only on release —
  so no double-feed is possible.
- At turn end (done event handling, before final emit): read
  observer.findings(); for each finding emit debugProviderDiagnostic
  ("cursor", "midstream-envelope-echo", { wireModel, conversationHash:
  request.conversationId.slice(0,16), offset, marker, callIdCorrupt }).
  marker stays a fixed enum string; no content bytes logged (audit
  finding 6 conventions).

### 3. MODIFY tests/cursor-envelope-echo-retry.test.ts (named activation
### tests, A-gate blocker 5 — one per conditional branch)

- "midstream echo after leading text is recorded with marker and offset"
  (run-03 specimen block as fixture).
- "midstream corruption window flags a space-spliced mar call-id"
  (callIdCorrupt=true) and "clean call-id lines do not flag corruption"
  (callIdCorrupt=false).
- "a marker fragmented across delta boundaries still fires" (feed
  "[Tool Res" then "ult]\n...").
- "a mid-line marker mention does not fire" (negative).
- "indentation beyond the 128-char line cap disarms that line" (negative).
- "scanning disarms past the cumulative cap but keeps prior findings".
- "held-then-released deltas are fed exactly once" (adapter-level test via
  the existing transport harness: prefix-guard hold + release, observer
  offset arithmetic proves single feed).
- KEEP: all existing prefix-sniffer tests unchanged.

## Accept criteria + activation

1. bun test tests/cursor-envelope-echo-retry.test.ts exit 0; activation =
   the mid-stream specimen from run-03 (verbatim block pasted as fixture)
   fires the detector; line-start anchoring proven by negative case.
2. bun run typecheck exit 0.
3. Live (wp5): re-run N1 x6 on patched stack; any echo occurrence now
   appears in probe-proxy.log as midstream-envelope-echo diagnostic with
   callIdCorrupt evidence — closing the F2 observability gap.

## Out of scope

Retry/suppression for already-streamed echoes (user-visible behavior
decision), native zero-stdout marker (stays conditional), checkpoint
reserialization.

# P0 plan — cross-conversation contamination: capture then fix

Date: 2026-07-02
Status: P skeleton (high severity; capture instrumentation can piggyback on
WP2's debug-frames work).

## Evidence

- Run 2 final continuation turn (15:47, ocx-mr356d7f-jh) returned an unrelated
  conversation's narrative wrapping this session's real tool results.
- RCA lane (static): continuation reuses the same Cursor `conversationId` and
  sends `ResumeAction` (`request-builder.ts:84-88`, `protobuf-request.ts:295-315`,
  `responses/state.ts:49-78`); ocx never sends checkpoints back; outgoing
  summary/archive fields are empty (`protobuf-request.ts:318-332`).
- Ranked suspects: (1) Cursor server-side resume state keyed by conversationId
  merging foreign state; (2) process-global blob map (`native-exec.ts:44`)
  serving stale blobs if the server references old ids; (3) wrong
  previous_response_id mapping (unlikely).

## Additional watch surfaces (live hints 21:05)

- Cursor product vocabulary leaks into bridged sessions (model offered
  "Chronicle" — Cursor's screen/work history feature; schema counterparts:
  `recordScreenToolCall`/`computerUseToolCall`, both safely stubbed by
  `native-exec-tools.ts` with failure replies unless desktopExecutor is
  configured). Prompt-side conditioning goes to WP2b.
- Cursor Notes as a cross-session content channel: `RequestContext.
  conversationNotesListing`/`sharedNotesListing` (S2). ocx does not populate
  them, but capture must log any notes-related content in server frames and
  outgoing context replies.

## Capture (with WP2 debug instance)

- Log at `live-transport.ts:453`-equivalent: conversationId, action case,
  rootPromptMessagesJson blob ids, turns count.
- Log blob gets/sets: blob id, size, whether referenced by current request.
- Log previous_response_id → conversationId resolution (`server.ts:260-266`).

## Fix candidates (validate by capture)

1. Fresh `conversationId` per upstream request (full replay already carries
   history) — kills server-side resume reuse; verify tool-result continuation
   still completes and checkpoint usage still arrives.
2. Scope blob map per conversation/request with TTL eviction.
3. If ResumeAction is required for continuation semantics, isolate per codex
   thread: conversationId derived from the Responses chain root id.

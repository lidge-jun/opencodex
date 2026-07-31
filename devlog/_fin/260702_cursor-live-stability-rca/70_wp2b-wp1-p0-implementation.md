# WP2b / WP1 / P0 implementation pass

Date: 2026-07-02 (Boss direct, continuing the PABCD loop after WP2/WP0 closed)

## WP2b — tool-name surface unification

### `src/adapters/cursor/tool-definitions.ts`

- **Changes**: Added `normalizeCursorWireName` — folds the Cursor-displayed
  `mcp_opencodex-responses_<tool>` MCP name back to the advertised wire name —
  and applied it inside `responsesToolNameFromCursorWire`. System guidance now
  states the long display name is the SAME tool (call whichever the list
  shows; no user-facing narration about the naming difference) and conditions
  Cursor product features (Chronicle, screen recording, Notes, Plans,
  background agents) on the current catalog.
- **Impact**: Models calling the prefixed display name verbatim (live 20:41
  session: 9 consecutive "MCP exec_command keeps failing" retries; 21:00
  session: mid-run "이름이 바뀌었네요" narration) now resolve to the same
  client tool instead of `recordToolCall`'s unknown-tool error.
- **Verification**: New alias regression tests in
  `tests/cursor-protobuf-events.test.ts` (prefixed name resolves + still
  rejects genuinely unknown names); cursor suites green.

### `src/adapters/cursor/protobuf-events.ts`

- **Changes**: Central `mcpWireNameFromArgs` helper normalizes the display
  prefix at every extraction point (tool-call frames, arg-schema lookup,
  completed-args resolution, synthetic exec mapping).
- **Impact**: Prefix handling is uniform across the ToolCall frame plane and
  the exec-channel plane; arg-key normalization keeps working when the model
  uses the long name.

Deferred from WP2b scope: the `native-exec.ts:126-133` bridge-suspension
mcpResult error is UNREACHABLE in the live path (`planMcpArgsHandling`
intercepts our provider first) and is covered by a fail-closed test; left as
the backstop. providerIdentifier shortening skipped (migration risk, cosmetic).

## WP1 — partial usage on failed turns

### `src/types.ts`, `src/adapters/cursor/types.ts`

- **Changes**: `error` events (AdapterEvent and CursorServerMessage) gained an
  optional `usage` field.

### `src/adapters/cursor/live-transport.ts`

- **Changes**: `partialUsageFromEventState` (exported, pure) mirrors the clean
  finalize math (checkpoint = cumulative context, streamed delta = output);
  transport failures now throw with `partialUsage` attached when any token
  signal was seen.

### `src/adapters/cursor.ts`, `src/adapters/cursor/message-mapper.ts`, `src/bridge.ts`

- **Changes**: The adapter's catch forwards `partialUsage` on its error event;
  the mapper passes usage through; the bridge attaches `usage` to the
  `response.failed` payload, which the server's existing
  `applyResponseLogMetadata` → `usageFromResponsesPayload` path records.
- **Impact**: Mid-stream upstream 502s (the "미보고/unreported, 0 tokens" rows
  from runs 4/6/7 and the user's 14:52 session) now log real partial
  consumption. Watchdog-incomplete rows remain usage-less (the bridge has no
  token signal of its own) — documented limitation.
- **Verification**: 3 new `partialUsageFromEventState` tests (checkpoint math,
  output-only, no-signal → undefined); usage suites green.
- Cache column stays absent by design: S2 schema sweep confirmed the Cursor
  protocol exposes NO cache/cost fields anywhere.

## P0 — blob store hardening

### `src/adapters/cursor/native-exec.ts`

- **Changes**: The process-global content-addressed blob map is now bounded:
  15-min TTL + 4096-entry cap, insertion-order eviction with re-store
  refreshing recency; `getBlob` drops expired entries on read.
- **Impact**: Fixes unbounded memory growth on a long-running proxy and closes
  the indefinite-stale-blob window (contamination enabler #2). Safe for live
  sessions because every continuation re-stores its blobs.
- **Verification**: `tests/cursor-blob.test.ts` + native-exec suites green.
- The primary contamination suspect (Cursor server-side `ResumeAction` state
  keyed by conversationId) remains monitored: no recurrence in runs 3-12;
  OCX_DEBUG_FRAMES now dumps per-frame cases for any future incident, and the
  conversationId-per-request decision stays open pending a captured recurrence.

## Gate

- Full suite: 1327 pass, 0 fail (bun test ./tests/). Catalog untouched across
  runs (WP0 holding). tsc blocked only by a concurrent foreign edit in
  `src/cli.ts` (another session's in-progress work; my files typechecked clean
  before it appeared).
- Live smoke on debug instance :10199 with all fixes:
  - run11 (sequential exploration, previously the 18/18 stall scenario):
    completed clean, ZERO reconnects, correct 5-point final summary with
    accurate `wc -l` numbers.
  - run12 (create/modify/verify write task): ZERO errors; `shapes.py` correct
    with all three functions; the verification `python3 -c` ran as a
    codex-visible `exec_command` round trip. File WRITES still go through
    Cursor-native `writeArgs` (fast, invisible to codex) even though
    `apply_patch` is advertised post-WP0 — composer prefers its native write
    path. Routing mutations through codex-visible `apply_patch` is a POLICY
    decision (safety/visibility vs speed), tracked as the remaining WP3 item;
    functionally writes are correct and stall-free.

## Loop status after this pass

- CLOSED: WP0 (catalog erosion), WP2 (stall root fix), WP2b (name surfaces),
  WP1 (partial usage), P0 hardening layer (blob TTL/cap; primary suspect
  monitored with frame diagnostics).
- OPEN (user decisions): WP3 native-write policy; webSearchRequestQuery
  approve-vs-reject default; main-instance restart timing (fixes are inactive
  on :10100 until restart).

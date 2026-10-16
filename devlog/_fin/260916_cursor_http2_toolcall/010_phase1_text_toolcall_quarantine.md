# 010 — L1 textual toolcall quarantine

## IN

- NEW `src/adapters/cursor/text-toolcall.ts`
- MODIFY `src/adapters/cursor/protobuf-events.ts` (`textDelta`, finalize, state)
- MODIFY `tests/providers/cursor/cursor-protobuf-events.test.ts` (#2305 block)
- MODIFY `structure/providers/cursor.md`

## OUT

Host cutover, stall-resume, CLI spawn, new test-layout file.

## Diff contract

- `drainCursorTextToolCalls(pending, chunk)` extracts complete
  `[TOOL_CALL]name[ARGS]{json}` blocks, folds `mcp_opencodex-responses_*`
  names, returns surrounding prose + pending opener.
- Incomplete markers hold up to 64 KiB then drop (no leak).
- Advertised names → atomic `tool_call_start/delta/end` via existing
  `recordToolCall` + `commitToolCall`.
- Unadvertised names: strip only.
- Finalize deletes `pendingTextToolCall`.

## Accept

- Marker + surrounding prose: text has no `[TOOL_CALL]`, tool events exist.
- Split deltas promote on the second chunk.
- Finalize of a held opener emits `done` without the marker.
- Activation: `textDelta` containing a complete or split marker.
  Observable: no `[TOOL_CALL]` in mapped events; advertised name becomes a
  committed tool call.

## Verifier

NOT RUN locally. Hosted `bun test tests/providers/cursor/cursor-protobuf-events.test.ts`.

## Shipped

https://github.com/lidge-jun/opencodex/pull/4815
`dev` ← `cursor/l1-text-toolcall-quarantine` (`407bf3ce56`).

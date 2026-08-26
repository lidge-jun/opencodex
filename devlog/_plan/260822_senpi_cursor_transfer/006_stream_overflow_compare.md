# 006 — Stream completion / usage / overflow / rotation

Leibniz + Ohm. senpi SHA `a5eed44536f3024c5740dc3dfff4ffe0bb08b717`.

## usedTokens — ALREADY-HAVE

Both treat checkpoint `usedTokens` as absolute conversation window, not additive output.

OpenCodex `protobuf-events.ts:1233-1238`. senpi [cursor-agent.ts L3566-3582](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L3566-L3582). OpenCodex tests lock 10000→10300 not 20300 (`tests/cursor-protobuf-events.test.ts`).

OpenCodex cache: 200 entries / 60 minutes (`protobuf-events.ts:21-22`). Older memory said 30m/256; current code wins.

## cacheRead — senpi-only billed split

senpi reads billed `turnEnded` fields and drops cacheRead when `cacheRead > liveUsed * 3` ([cursor-agent.ts L3516-3547](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L3516-L3547); [cursor-usage.test.ts](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/test/cursor-usage.test.ts)). Compact threshold uses local estimate if billed > 8× and estimate ≥ 50k.

OpenCodex generated `TurnEndedUpdate` is `{}` (`gen/agent_pb.ts:3083-3085`), so billed cacheRead cannot spike totals. Do not add billed fields without the 3×/8× guards. Live wire still emitting those int64s is **unverified** this cycle (client versions differ).

## 0-token resource_exhausted — inverted

OpenCodex: generic RE is 429 unless an explicit size phrase wins (`cursor-errors.ts:131-163`; `tests/cursor-errors.test.ts:15-17` expects bare `Connect error resource_exhausted: Error` → rate limit). Retry layer never retries RE (`transport-retry.ts:25`).

senpi: 0-token RE is payload overflow for compact-before-rotate (`overflow.ts` `isCursorPayloadResourceExhausted`, [L211-222](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/utils/overflow.ts#L211-L222)). First failure is **surfaced** so session compact can run; later ones rotate wire id ≤3 ([cursor-conversation-rotation.ts L34-46](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-conversation-rotation.ts#L34-L46), [cursor-agent.ts L789-812](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L789-L812)). Stale senpi comment still says 0-token RE is rate-limit; code does the opposite.

OpenCodex remint is only external-model `invalid_argument` (`src/adapters/cursor.ts:231-247`). Compaction is client-driven and isolated (`request-builder.ts:397, 443-444`). Architectural bound: OpenCodex cannot copy senpi `AgentSession._runPrePromptCompaction`. Transfer is **HTTP mapping** so Codex compact can fire, plus optional remint after that, not an in-adapter compact loop.

## turnEnded hang — senpi newer

#1062: Cursor can leave HTTP/2 open after content is done. senpi closes the client stream on `turnEnded`. OpenCodex waits for EOF / 300s bridge stall. First-frame 30s is not a mid-turn health watchdog.

OpenCodex-only: synthesize `done` on clean EOF after assistant text without `turnEnded` (`live-transport.ts:1147-1150`). senpi fails that case. Comment/test tension: `tests/cursor-eof-terminal.test.ts` vs hardening tests vs transport `settleFinish`.

## ANTML / interactionQuery

ANTML skip is senpi-only because senpi has Claude-name text-tool recovery. OpenCodex has zero ANTML hits — already-have by absence. interactionQuery is OpenCodex-only (senpi gap #1026).

## #1043 toolResult reload

senpi compact reloads full jsonl bodies (still open). OpenCodex truncates toolResult blobs for **external-model replay budget** 512KiB / 192 roots (`protobuf-request.ts:64-72, 140-143`), not as a post-compact native admission pass. Medium residual if native-model full replay after Codex compact still ships verbatim tool results.


# 020 — L2 observed maxTokens ceiling

## IN

- MODIFY `src/adapters/cursor/protobuf-events.ts` checkpoint handler
- MODIFY `src/adapters/cursor/discovery.ts` `inferCursorContextWindow`
- MODIFY `src/adapters/cursor.ts` `cursorRequestSizeContext`
- MODIFY `src/adapters/cursor/cursor-errors.ts` callers if the size prior
  needs the observed window
- Tests in existing `tests/providers/cursor/cursor-errors.test.ts` /
  `cursor-protobuf-events.test.ts`

## OUT

Disk store (`cursor-context-limits.json`), senpi admission amputation,
client-version bump.

## Diff contract

- On `conversationCheckpointUpdate`, record positive `tokenDetails.maxTokens`
  per wire model id in a process-local map (same shape as usage carry-forward).
- `inferCursorContextWindow(modelId, observed?)` prefers a positive observed
  ceiling, else today's id heuristic.
- `cursorRequestSizeContext` feeds that window into the existing 0.5-window
  overflow vs 429 prior.

## Shipped

Process-local map in `discovery.ts`; checkpoint records a positive
`maxTokens` when `wireModelId` is set from `live-transport.ts`.
`inferCursorContextWindow(modelId, observed?)` prefers explicit then
recorded then heuristic. `cursorRequestSizeContext` is unchanged except
the comment — it already calls `inferCursorContextWindow`.

## Accept

- Checkpoint with `maxTokens: 32000` makes a 20-token request classify as 429
  (small vs observed window), not overflow.
- Zero/missing `maxTokens` keeps the heuristic (first checkpoint is 0 on senpi).
- Activation: checkpoint frame with `maxTokens > 0`, then a bare
  `resource_exhausted` on a small payload.
  Observable: `classifyCursorError` stays on the 429 class.

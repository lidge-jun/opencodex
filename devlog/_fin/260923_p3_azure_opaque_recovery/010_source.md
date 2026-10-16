# 010 — Source: contract gate and rejected reasoning id drop (wp-2)

## `src/server/responses/core-opaque-recovery.ts`

- Import `resolvedAdapterWire` from `../../responses/continuation-ownership` (already in the
  `core.ts` graph through `request-prepare.ts`; not a `./` sibling, so the owner graph is unchanged).
- Add `adapterSpeaksResponsesWire(adapterName: string): boolean` returning
  `resolvedAdapterWire(adapterName) === "openai-responses"`, with a comment naming #5583 and the
  `contractParent` inheritance.
- Replace `args.adapterName === "openai-responses"` in `shouldAttemptOpaqueBlobRecovery` and
  `adapterName !== "openai-responses"` in `opaqueBlobRejectionBodyForRecovery` with the helper.
- In `prepareOpaqueBlobRecovery`, set `parsed._dropForeignReasoningItemIds = true` beside
  `_stripReasoningEncryptedContent`.

## `src/types/request.ts`

- Add `_dropForeignReasoningItemIds?: boolean` after `_stripReasoningEncryptedContent`, documenting
  the two setters and the `Item with id … not found` failure it prevents.

## `src/server/responses/core-replay.ts`

- In `bindRouteReasoningReplayScope`, the `reasoningReplayOpaqueBlobRejectionMemoized` branch also
  sets `_dropForeignReasoningItemIds`. The serving-identity-change branch does not.

## `src/adapters/openai-responses/reasoning.ts`

- `sanitizeReasoningInputContent` gains `dropForeignItemId?: boolean` (named `dropStrippedItemId` in
  the first revision; see 050). When true and the item's
  `encrypted_content` is being removed, also delete `id`. Items that keep their blob, or never had
  one, keep their id.

## `src/adapters/openai-responses/passthrough.ts`

- Pass `dropForeignItemId: parsed._dropForeignReasoningItemIds === true` into the existing
  `sanitizeReasoningInputContent` call. Azure inherits this through `inner.buildRequest`.

## Invariants kept

- 5xx other than the exact function-output 502, non-self-identified 4xx, blobless bodies and a
  second rejection never enter recovery.
- The call sites and `rebuildAndRefetch` budget plumbing are untouched.

# Final Fix Report: image-only SelectedImage turns

## Status
DONE

## Summary
Fixed image-only Cursor turns so resolved `selectedImages` attach on the active `userMessageAction` instead of falling through to `resumeAction`.

## Root cause
1. `createCursorRequest` dropped active user/developer turns after image parts were omitted from text, so image-only turns never survived into `request.messages`.
2. `buildPreparedCursorRunRequest` chose `resumeAction` whenever `text.trim()` was empty, even when live transport had already resolved `selectedImages`.

## Fix
- `request-builder.ts`
  - Preserve image-only user/developer turns as empty-string messages when raw content contains Cursor image URLs.
  - Keep dropping empty assistant tool-call-only messages.
  - Stop filtering out empty-string active messages in `createCursorRequest`.
- `protobuf-request.ts`
  - Prefer `userMessageAction` when `selectedImages.length > 0`, even if prompt text is empty.
  - Reuse the resolved `selectedImages` array for both action selection and `selectedContext` attachment.

## Tests added
- `tests/cursor-request-builder.test.ts`
  - image-only first user turn preserved as `{ role: "user", content: "" }`
  - image-only active user turn after assistant reply preserved
- `tests/cursor-blob.test.ts`
  - image-only first turn with `selectedImages` encodes `userMessageAction` + inline `selectedContext`
  - image-only turn after assistant reply encodes `userMessageAction` + inline `selectedContext`

## Verification
```bash
bun test tests/cursor-request-builder.test.ts tests/cursor-blob.test.ts
```
Result: 92 pass, 0 fail.

## Commit
Pending commit in this wave.

## Notes
- `prepareCursorRunRequest` / `encodeCursorRunRequest` remain synchronous.
- No changes to `noVisionModels`.
- History remains text-only; `selectedContext` stays on the active turn only.

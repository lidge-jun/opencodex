# Cursor Grok view_image External-Model Fix

## Goal
Stop OpenCodex from discarding `view_image` image bytes for external Cursor models (`grok-4.5`, GPT/Claude/Gemini families) so Cursor actually receives the tool-result image. Add fully automated wire-level verification so we do not need Codex Desktop reinstall/restart/manual testing.

## Root Cause
`isCursorExternalWireModel("grok-4.5") === true`. In `conversationTurns()`, the external branch flattens tool results to text via `contentToText()`, which drops image parts. Image-only `view_image` therefore becomes an empty `[Tool Result]\n` for Cursor. The existing `McpImageContent` forwarding path only runs on the native (`composer-*`) branch and is unit-tested only with `composer-2.5`.

## Global Constraints
- Keep prepare/encode synchronous.
- Preserve `resumeAction` for trailing tool-result continuations (do not force `userMessageAction` there).
- Keep history/root blobs text-only for user-attached images; only active SelectedImage / tool-result image content carries bytes.
- Do not put Cursor back into `noVisionModels`.
- Prefer forwarding real image bytes over inventing placeholders.
- Automated verification must prove non-empty image bytes on the Cursor wire for `grok-4.5` without requiring Desktop UI clicks.
- Work only under `/Users/user/Projects/opencodex`.
- Commit on `audit/cursor-dev`.

## Tasks

### Task 1: Failing Grok view_image wire test + fix external flatten path
1. TDD: add a failing test in `tests/cursor-blob.test.ts` that encodes a `view_image` tool-result continuation with `modelId: "grok-4.5"` and asserts the conversation turn carries `McpImageContent` (or equivalent non-empty image bytes) for the tool result — not empty text-only `[Tool Result]`.
2. Optionally add a tiny pure helper/script test that builds the same request from a fixture PNG path and asserts byte length > 0 / PNG magic, so agents can re-run without Desktop.
3. Implement the minimal fix in `src/adapters/cursor/protobuf-request.ts`: for external models, when a toolResult has image parts (or when a matched priorCall exists with image content), use the native `toolCallStep(..., message)` / `McpImageContent` path instead of text-flattening away images. Keep text-flatten only for non-image tool results if that remains needed for external replay compatibility.
4. Keep existing composer `view_image` McpImageContent test green.
5. Run focused tests, commit, report.

### Task 2: Automated vision harness (no Desktop)
1. Add `tool/cursor_vision_wire_check.ts` (or `tests/cursor-vision-wire-harness.test.ts`) that:
   - builds a synthetic 8x8 solid-color PNG (or uses a fixture)
   - encodes both attach-turn SelectedImage and grok view_image tool-result paths
   - prints/asserts pass/fail with concrete byte counts
2. Document one command: `bun test tests/cursor-blob.test.ts` and `bun test tests/cursor-vision-wire-harness.test.ts` (or `bun run tool/cursor_vision_wire_check.ts`).
3. Commit if separate from Task 1; otherwise fold into Task 1 if tiny.

## Success Criteria
- `bun test tests/cursor-blob.test.ts` proves grok-4.5 view_image tool results carry non-empty image bytes.
- Automated harness/test can be re-run by the agent without restarting Codex Desktop.
- No manual screenshot testing required to claim the wire fix.

# 010 — carry #6769: external task input stays a user turn in raw-body repairs

Source: https://github.com/lidge-jun/opencodex/pull/6769 (robin-bially), head e770246a8b, three
commits, merges cleanly with dev c15037b324. Refs #6764 (does not close it).

## Problem

Codex sends an external task as a `function_call_output` with `id`, `name`, `namespace` and no
pairing `call_id`. `src/responses/task-input.ts` `externalTaskInputContent` already treats that as
user input on the parsed path, but the raw-body repairs in
`src/adapters/openai-responses/tool-output-recovery.ts` (`repairUnidentifiedToolOutputItems`,
`repairOrphanedInputItems`) wrap it as `[tool output for unknown call]`, so a routed summarizer
reads the authorized handover as a stray tool result.

## Changes (carry the PR, then amend)

1. Cherry-pick the three PR commits onto `codex/compaction-responses-carry` (from origin/dev),
   preserving authorship; final squash message carries
   `Co-authored-by: robin-bially <robin-bially's GitHub noreply address from the PR commits>`.
2. Amend (D6769-2) `src/adapters/openai-responses/tool-output-recovery.ts`
   `repairUnidentifiedToolOutputItems`: run the task-input recognition before the
   non-empty-`call_id` early return.

   ```diff
   -    if (!isPlainObject(item)
   -      || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")
   -      || (typeof item.call_id === "string" && item.call_id.length > 0)) {
   -      return item;
   -    }
   -    const taskInput = externalTaskInputResponsesContent(item);
   -    if (taskInput) { changed = true; return { type: "message", role: "user", content: taskInput }; }
   +    if (!isPlainObject(item)
   +      || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) {
   +      return item;
   +    }
   +    // #6764: same recognition as the parser, including a blank call_id that cannot pair.
   +    const taskInput = externalTaskInputResponsesContent(item);
   +    if (taskInput) { changed = true; return { type: "message", role: "user", content: taskInput }; }
   +    if (typeof item.call_id === "string" && item.call_id.length > 0) return item;
   ```

   `externalTaskInputContent` rejects any item with a real pairing key, so a paired output still
   returns unchanged.
3. Amend `tests/responses/external-task-input-repair.test.ts`: add a case where
   `call_id: "   "` external task input reaches the passthrough `buildRequest` and becomes the same
   user message the parser produces, and a case where a real `call_id` with `id/name/namespace`
   stays a tool output.
4. Re-read the PR's doc edits (`structure/providers/chat-compat.md`,
   `docs-site/src/content/docs/reference/adapters.md`,
   `docs-site/src/content/docs/guides/sub-agent-surface.md`) against the final behavior.

## Acceptance

- Activation: a raw passthrough body whose input holds `{type:"function_call_output", id, name,
  namespace, output}` with no `call_id`, with `call_id: null`, and with `call_id: "   "` — each is
  sent upstream as `{type:"message", role:"user", content:[{type:"input_text", text}]}`; with an
  image block `detail:"original"` it is sent as `detail:"high"`.
- Guard: an item with a real `call_id` keeps the existing pairing/orphan behavior; a plain
  orphaned output keeps the `[tool output for unknown call]` marker.
- `tests/responses/openai-responses-passthrough.test.ts` stays at or under 4809 lines.

## Verifier

- `bun test tests/responses/external-task-input-repair.test.ts tests/responses/openai-responses-passthrough.test.ts tests/responses/responses-parser.test.ts`
  (reads the target: the repair functions are exercised through `createResponsesPassthroughAdapter`).
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` (new file registration).
- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`; hosted CI on the exact head.

## P revalidation (wp2, 2026-10-09)

`origin/dev` is still c15037b324, the base this doc was written against; none of the touched files
moved. Architect decisions D6769-1..3 were accepted in the roadmap and reflected ALIGNED; the
roadmap audit passed in round 5. Co-author trailer: `Co-authored-by: Robin Bially
<7304732+robin-bially@users.noreply.github.com>` (author of the three PR commits). The PR
description says `Refs #6764`, not `Closes`, because task selection after replay is out of scope.

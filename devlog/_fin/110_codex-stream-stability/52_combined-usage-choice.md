# 110.52 — F2: Combined Usage+Choice Drop and EOF-without-`[DONE]` Usage Loss

## Objective

GPT Pro: *"terminal usage may be isolated, combined with a content choice, or followed by EOF
without `[DONE]`, so adapters must retain usage without skipping the rest of the chunk."* Two
concrete defects implement that gap today:

- **F2a — content dropped on a usage+choice chunk.** `openai-chat.ts:196-199` does
  `if (chunk.usage) { pendingUsage = …; continue; }`. A provider that sends `usage` **and** a
  final `choices[].delta.content` in the **same** chunk loses that content — the `continue`
  skips the choices parsing below it.
- **F2b — usage dropped on EOF-without-`[DONE]`.** When a stream ends by socket EOF (no
  `[DONE]` sentinel), the post-loop terminal yields `done` **without** usage:
  `openai-chat.ts:239` (`yield { type: "done" }`) and `google.ts:172` (same). The
  `pendingUsage` accumulated from a prior usage chunk is silently discarded, so Codex shows a
  successful turn with **zero token usage**.

`google.ts` has an additional latent defect: it yields `done` **twice** on a normal finish —
inline at `:164-169` (when `finishReason && usageMeta`) **and** unconditionally post-loop at
`:172`. Consolidating to a single post-loop `done` fixes F2b and the double-terminal at once.

## Evidence

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:196-199  if (chunk.usage) { pendingUsage = …; continue; }  ← F2a
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:239      yield { type: "done" };  (post-loop, no usage)        ← F2b
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:163-169       inline done with usage when finishReason && usageMeta  ← double-done
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:172           yield { type: "done" };  (post-loop, no usage)          ← F2b
```

Bridge usage projection that receives `done.usage` (unchanged):

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:311-321  case "done" → response.completed { usage: responsesUsage(event.usage) }
```

## Files

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
```

F2a — record usage but do **not** `continue`; fall through to choices parsing (current 196-199):

```diff
-            if (chunk.usage) {
-              pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);
-              continue;
-            }
+            if (chunk.usage) {
+              // Record usage but keep parsing: some providers send usage and the final content
+              // delta in the SAME chunk; a `continue` here would drop that content.
+              pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);
+            }
```

> **Why removing `continue` is safe (do not skip this):** the line immediately below is
> `const choices = chunk.choices …; if (!choices || choices.length === 0) continue;`. A
> usage-only chunk has no `choices`, so that guard already no-ops it. Removing the early
> `continue` therefore only changes behavior for the usage+content chunk — the case we are
> fixing — and is a no-op for every other chunk.

F2b — carry `pendingUsage` on the post-loop terminal (current line 239):

```diff
         if (currentToolCallId) {
           yield { type: "tool_call_end" };
         }
-        yield { type: "done" };
+        yield { type: "done", usage: pendingUsage };
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts
```

Replace the inline `done` with a `pendingUsage` accumulator and emit a single post-loop `done`.
Declare `pendingUsage` immediately after `let buffer = "";` (`src/adapters/google.ts:126`, with
the `reader`/`decoder`/`buffer` loop locals at `:124-126`):

```diff
       let buffer = "";
+      let pendingUsage: OcxUsage | undefined;
```

Record usage instead of yielding an inline `done` (current 163-169):

```diff
             const usageMeta = chunk.usageMetadata as Record<string, number> | undefined;
-            if (candidates[0].finishReason && usageMeta) {
-              yield {
-                type: "done",
-                usage: usageFromGemini(usageMeta),
-              };
-            }
+            if (usageMeta) {
+              pendingUsage = usageFromGemini(usageMeta);
+            }
```

Emit one terminal `done` with usage post-loop (current line 172):

```diff
-        yield { type: "done" };
+        yield { type: "done", usage: pendingUsage };
```

> Add `import type { OcxUsage } from "../types";` if `google.ts` does not already import it
> (verify the existing import block during implementation).

## Verification

```bash
bun test tests/adapter-usage.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

Add to `tests/adapter-usage.test.ts` (or a new `tests/adapter-eof-usage.test.ts`) cases that
assert:

- openai-chat: a single chunk carrying **both** `usage` and `choices[].delta.content`
  yields the `text_delta` **and** a final `done.usage` (content not dropped).
- openai-chat: a stream ending by EOF (no `[DONE]`) after a usage chunk yields
  `done.usage` equal to the accumulated usage (not `undefined`).
- google: a normal finish yields **exactly one** `done`, and it carries usage.

Expected:

```text
combined-chunk content preserved; EOF usage retained; google emits a single done with usage
full suite passes; typecheck clean; whitespace clean
```

## Commit

```text
[agent] fix: retain usage and content on combined and EOF-terminated streams
```

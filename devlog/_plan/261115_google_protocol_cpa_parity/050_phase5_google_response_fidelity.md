# 050 — Phase 5: Google response fidelity (usage, finish reasons, prompt blocks)

Rows: OUT-V38 (P1), OUT-V42 (P1), AG-R7, OUT-V40, OUT-V43 (P2). Class C3: usage feeds pricing,
telemetry and every inbound encoder. Independent of #8742 (IN-14 benefits automatically).

## 5a — usage (OUT-V38, AG-R7)

```diff
// src/adapters/google.ts:679
 function usageFromGemini(usage: Record<string, number> | undefined): OcxUsage | undefined {
   if (!usage) return undefined;
+  const thoughts = usage.thoughtsTokenCount ?? 0;
   return {
-    inputTokens: usage.promptTokenCount ?? 0,
-    outputTokens: usage.candidatesTokenCount ?? 0,
+    // Google reports tool-use prompt tokens (search grounding, URL context) beside the prompt.
+    inputTokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
+    // Google reports thinking beside candidates; every other adapter's output includes reasoning
+    // (telemetry clamps reasoning to output, src/telemetry/aggregate.ts:185), and Google bills it as output.
+    outputTokens: (usage.candidatesTokenCount ?? 0) + thoughts,
     ...(usage.cachedContentTokenCount !== undefined ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
     ...(usage.thoughtsTokenCount !== undefined ? { reasoningOutputTokens: usage.thoughtsTokenCount } : {}),
   };
 }
```

Pinned expectations change with a stated reason (D5): `tests/adapters/adapter-usage.test.ts:296`
("Google usage maps cached and thoughts tokens", output 5 → 7) and the thoughts cases in
`tests/adapters/google/google-vertex-stream.test.ts`, `google-adapter.test.ts`,
`gemini-4-argon-antigravity.test.ts`, `tests/responses/responses-show-thinking-summary.test.ts`,
`protocol-argon-thought-boundary.test.ts` (each found by `rg -l thoughtsTokenCount tests`; update only the
output/input numbers, never loosen an assertion). Stale check before B: `rg -n 'reasoningOutputTokens'
src/pricing* src/usage` to confirm no consumer adds reasoning on top of output for Google (none on
d842c1352e outside the generic sums listed in the research pass).

New failing tests first: candidates 5 + thoughts 2 → output 7, reasoning 2; prompt 10 +
toolUsePrompt 4 → input 14; absent thoughts → unchanged.

## 5b — fail-closed finishes on every Google mode (OUT-V42)

Today the fail-closed check is gated on `googleMode === "vertex" || "cloud-code-assist"`
(`google.ts:1607`, `google.ts:1822`), so AI Studio turns ending in `MALFORMED_FUNCTION_CALL` complete
empty. CPA fails all three zero-output reasons on every Gemini path
(`internal/runtime/executor/helps/gemini_zero_output.go:39-46`).

```diff
// src/adapters/google-truncation.ts
 const TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);
+/** Finishes that mean the model's output was dropped upstream; they fail only when nothing visible arrived. */
+const DROPPED_OUTPUT_REASONS = new Set(["UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]);
-export function isVertexTruncatedTurn(finishReason: string | undefined, toolCallsStarted: number): boolean {
-  if (!isVertexTruncationReason(finishReason)) return false;
-  return toolCallsStarted > 0 || finishReason === "MALFORMED_FUNCTION_CALL";
+export function isGoogleTruncatedTurn(finishReason: string | undefined, toolCallsStarted: number, sawVisibleOutput = false): boolean {
+  if (finishReason === undefined) return false;
+  if (isVertexTruncationReason(finishReason)) return toolCallsStarted > 0 || finishReason === "MALFORMED_FUNCTION_CALL";
+  return DROPPED_OUTPUT_REASONS.has(finishReason) && toolCallsStarted === 0 && !sawVisibleOutput;
 }
```

The existing `MALFORMED_FUNCTION_CALL` rule is kept as it is (it fails even after text, because a dropped
call leaves the turn incomplete). The two new reasons follow CPA's rule and fail only when no text or
call arrived. With visible output: `MALFORMED_RESPONSE` maps to `content_filter` (5c) and
`UNEXPECTED_TOOL_CALL` ends as a plain stop with no stop reason (a tool-misuse finish is not a content
filter; the text the client already has is the answer). `isVertexTruncatedTurn` stays as a
re-export for existing imports. `vertexTruncationErrorEvent` marks `replaySafeBeforeOutput` for every
zero-call failure. Both call sites in `google.ts` drop the `googleMode` condition and pass
`sawVisibleOutput`. Dropping the gate also makes AI Studio (and its Go/Zen variants) fail closed on
`MAX_TOKENS` after a started tool call, as Vertex and Antigravity already do; that is intended (a
half-written call is never a valid tool call) and gets its own test. NEW `googleTruncationErrorMessage(mode, reason)` names "Gemini API", "Vertex AI" or
"Antigravity" by mode; the vertex wording is unchanged.

## 5c — finish reasons (OUT-V40) and prompt blocks (OUT-V43)

- Both stop-reason tables (`google.ts:1617-1620` stream, `google.ts:1838-1841` buffered) move to one
  helper in `google-truncation.ts`: `googleStopReason(finishReason)` with `MAX_TOKENS → max_tokens` and a
  new constant `GOOGLE_CONTENT_FILTER_FINISHES = SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII,
  IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT, MALFORMED_RESPONSE` → `content_filter`; everything else → no stop
  reason.
- `src/lib/failure-detail.ts:42-46` `FAILURE_DETAIL_FINISH_REASONS` (the request-log finish-reason enum,
  which `withProviderFailureFacts` filters against) gains `MALFORMED_RESPONSE` and
  `MISSING_THOUGHT_SIGNATURE` (both in Google's FinishReason enum, `doc-generate-content-ref` capture),
  so the new fail-closed events keep their #8446 log fact; `structure/data-planes/error-detail.md` lists
  them.
- Prompt blocks: a buffered body with no candidates and `promptFeedback.blockReason`, or a stream frame
  with `promptFeedback.blockReason` and no candidates, ends the turn with
  `{type:"error", message:"<label> blocked the prompt (<REASON>)", nonRetryable: true}` where `REASON` is
  matched against `^[A-Z_]{1,40}$` (else `OTHER`); `blockReasonMessage` is not forwarded. Stale check: the
  field name the adapter event uses for "do not retry/fail over" (search `AdapterEvent` error members);
  `src/server/images.ts:430-439` already handles the image route the same way.

## Tests (first, failing)

EXTEND `tests/adapters/google/google-adapter.test.ts` (or a new sibling
`tests/adapters/google/google-finish-fidelity.test.ts` if the ratchet requires; register it): AI Studio
stream and buffered `MALFORMED_FUNCTION_CALL` with no parts → error event; `UNEXPECTED_TOOL_CALL` and
`MALFORMED_RESPONSE` with no output → error (request-log finish reason recorded), with text →
`content_filter`; `UNEXPECTED_TOOL_CALL` with text → done without stop reason; AI Studio `MAX_TOKENS` after a
started call → error; `IMAGE_SAFETY` →
`content_filter`; prompt block stream and buffered → error naming the reason and not the message.

## Docs

`structure/providers-and-adapters.md` Google section: usage composition, fail-closed reasons, prompt
blocks.


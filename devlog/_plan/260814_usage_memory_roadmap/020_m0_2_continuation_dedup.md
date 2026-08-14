---
title: "M0-2: Continuation overlap removal"
phase: "020"
depends: []
consumes: []
branch: codex/m0-2-continuation-dedup
closes: "(split from #1412)"
---

# 020 — M0-2: Stop compounding replayed history

## Thesis

When a request already contains the full conversation history (from the client
replaying its own context), the proxy must not prepend stored continuation state
on top. This duplication turns a 127k request into 254k→381k→508k across
continuations, eventually causing OOM or provider rejection.

## Current state

- `src/server/responses/core.ts:1544` sets `parsed._providerContinuation`
  from `previousResponseProviderState`
- The continuation expansion code (around line 1621) checks
  `hasUnexpandedPreviousResponse` but does not detect when the client has
  already included the full history in the `input` array
- #1412 documents cases where 1x input becomes 2x→3x→4x through repeated
  continuation prepending

## File change map

### NEW: src/server/responses/continuation-dedup.ts

```ts
/**
 * Detect whether a request's input array already contains messages that
 * overlap with the stored continuation state. If substantial overlap is
 * detected, skip the continuation expansion.
 *
 * Detection strategy: compare the first N message hashes from stored
 * continuation against the request's input array. If ≥80% of stored
 * messages appear in the input, the client already replayed history.
 */
export function detectHistoryOverlap(
  requestInput: unknown[],
  storedMessages: unknown[],
): { overlapping: boolean; overlapRatio: number };

/**
 * Fingerprint a message for overlap detection. Uses a fast hash of
 * role + first 200 chars of content. Images/tool-results use their
 * type + id as fingerprint.
 */
export function messageFingerprint(message: unknown): string;
```

### MODIFY: src/server/responses/core.ts

Location: Around the continuation expansion block (near line 1621).

```diff
  const hasUnexpandedPreviousResponse = !!parsed.previousResponseId
    && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string";

+ // Guard: if the client already included full history in input[],
+ // skip continuation expansion to prevent 1x → 2x → 3x compounding.
+ if (hasUnexpandedPreviousResponse && parsed._providerContinuation) {
+   const { overlapping } = detectHistoryOverlap(
+     parsed.input ?? [],
+     parsed._providerContinuation.messages ?? [],
+   );
+   if (overlapping) {
+     parsed._previousResponseInputExpanded = true; // mark as already expanded
+     // Clear the continuation to prevent double-prepending
+     parsed._providerContinuation = undefined;
+   }
+ }
```

### NEW: tests/continuation-dedup.test.ts

Test cases:
1. Full history already in input → continuation skipped, chain stays 1x
2. Delta continuation (new messages only) → continuation applied normally
3. Partial overlap (50%) → continuation applied (conservative)
4. Empty input + continuation → continuation applied normally
5. Preserved: call ID, reasoning, image, tool result integrity
6. Preserved: stateless provider behavior unchanged

## Activation scenario

A Codex session with 50 turns: each turn the client sends the full 50-turn
history as `input[]`. Without this fix, turn 3's request would contain
50 + 50 + 50 = 150 messages. With this fix, the overlap detector recognizes
the duplication and the request stays at 50 messages.

## Scope boundary

IN: Dedup detection module + core.ts guard + test file
OUT: Changing Codex client behavior, modifying continuation cache storage,
     restructuring the continuation protocol


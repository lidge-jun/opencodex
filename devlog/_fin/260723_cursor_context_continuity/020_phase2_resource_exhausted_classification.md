# Phase 2 — resource_exhausted: split tool-catalog overflow (400) from quota (429)

Owns RC2 (000_plan.md). Goal: generic gRPC `resource_exhausted` (detail lacking
explicit request-too-large language) surfaces to Codex as 429
`rate_limit_exceeded`; only explicit tool-catalog/registration/request-size
overflow keeps 400 `tool_catalog_too_large`.

## Semantics decision

- "tool catalog too large" / "tool registration too large" / "message too
  large" / "request too large" / "too many tools" → deterministic client-side
  overflow → 400 (retry is useless; Codex should trim tools).
- Any other `resource_exhausted` (including bare `Error` detail, "quota",
  "limit reached") → quota/rate → 429 (Codex backs off; combo failover treats
  as transient).

## File change map

### MODIFY `src/adapters/cursor/cursor-errors.ts`

Before (`:59-63`):
```ts
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted")
  ) return "Cursor resource limit exceeded";
```
After:
```ts
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted")
  ) {
    // gRPC RESOURCE_EXHAUSTED is quota/rate exhaustion unless the detail names a
    // request-size overflow (tool catalog/registration). Only the latter is a
    // client-fixable 400; everything else must surface as a 429 so Codex backs off.
    return isCursorRequestTooLargeDetail(lower)
      ? "Cursor resource limit exceeded"
      : "Cursor rate limit exceeded";
  }
```
New helper (audit r1 blocker 4 + r2 blocker 3: free cue pairing reclassified
"too many requests" as 400 — rejected. Quota/rate rejection runs FIRST, then
only phrase-specific size patterns match):
```ts
const QUOTA_RATE_CUES = ["too many requests", "quota", "rate limit", "rate-limit", "throttl"];
const REQUEST_TOO_LARGE_PATTERNS: (string | RegExp)[] = [
  "tool catalog too large",
  "tool registration too large",
  "too many tools",
  "message too large",
  "payload too large",
  "request too large",
  /request (?:body |size )?exceeds .*(?:size|limit)/,
  "maximum allowed size",
];

/** True when a resource_exhausted detail names a request-size overflow rather than quota. */
export function isCursorRequestTooLargeDetail(lowerMessage: string): boolean {
  if (QUOTA_RATE_CUES.some(cue => lowerMessage.includes(cue))) return false;
  return REQUEST_TOO_LARGE_PATTERNS.some(pattern =>
    typeof pattern === "string" ? lowerMessage.includes(pattern) : pattern.test(lowerMessage),
  );
}
```
Table cases: "resource_exhausted: too many requests" → 429 (quota cue rejects
first); "resource_exhausted while loading tool catalog: quota exhausted" → 429
(quota cue); "resource_exhausted: tool registration too large" → 400;
"resource_exhausted: request exceeds maximum allowed size" → 400; bare
"resource_exhausted: Error" → 429 (no size pattern).
`safeCursorErrorMessage` keeps the existing `resource[_ ]exhausted` →
"resource limit exceeded" rewrite (`:125`) — harmless for both prefixes.

### MODIFY `src/lib/errors.ts`

`:102` and `:205` currently trust the prefix alone. The prefix now only appears
for genuine too-large cases, so both branches stay but their comment is updated
to note the adapter-side narrowing. The 429 path needs no change: the
"Cursor rate limit exceeded" prefix already matches the existing
`rate limit` keyword branches (`:117` region and `:206-210`).

Diff at `:102` (comment only):
```ts
  // "Cursor resource limit exceeded" is emitted only for explicit request-size
  // overflow details (isCursorRequestTooLargeDetail); quota-style resource
  // exhaustion arrives as "Cursor rate limit exceeded" and falls through to 429.
  if (text.includes("cursor resource limit exceeded")) {
```
Same comment shape above `:205`.

## Accept criteria + activation scenarios

1. `classifyCursorError("resource_exhausted: Error")` → `"Cursor rate limit exceeded"`.
2. `classifyCursorError("resource_exhausted: tool registration too large")` →
   `"Cursor resource limit exceeded"` (unchanged).
2a. Adversarial negatives (asserted END-TO-END through `safeCursorErrorMessage(raw)`,
   not just the predicate — audit r2 blocker 3): `"resource_exhausted: too many requests"`
   → rate-limit prefix (429); `"resource_exhausted while loading tool catalog: quota exhausted"`
   → rate-limit prefix; `"resource_exhausted: request exceeds maximum allowed size"`
   → too-large prefix (400).
3. `adapterFailureFromMessage("Cursor rate limit exceeded: ...")` → 429 /
   `rate_limit_error` / `rate_limit_exceeded`.
4. `adapterFailureFromMessage("Cursor resource limit exceeded: tool catalog too large")`
   → 400 / `tool_catalog_too_large` (unchanged).
5. Request-log rows for the generic case record status 429 + `rate_limit_exceeded`.

## Tests

- MODIFY `tests/cursor-errors.test.ts:11` — the existing
  "tool registration too large" case keeps its expectation; ADD the generic
  `resource_exhausted: Error` → rate-limit case; ADD unit tests for
  `isCursorRequestTooLargeDetail`.
- MODIFY `tests/cursor-errors.test.ts:80` region — same split.
- MODIFY `tests/adapter-error-inline.test.ts:63` — keep the tool-catalog fixture
  (still 400); ADD a sibling generic fixture asserting 429.
- MODIFY `tests/request-log.test.ts:638` — keep too-large as 400; ADD generic → 429 row.
- CHECK `tests/errors-adapter-failure.test.ts:9` — raw `resource_exhausted` → 429
  already passes; keep as-is.

## Verification

```
bun run typecheck
bun test tests/cursor-errors.test.ts tests/adapter-error-inline.test.ts tests/request-log.test.ts tests/errors-adapter-failure.test.ts
```

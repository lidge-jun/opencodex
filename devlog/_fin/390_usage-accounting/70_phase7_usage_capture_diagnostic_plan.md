# Phase 7 — Usage capture diagnostic + extraction hardening

## Why

Phase 5's tests proved the request-log surface end-to-end with synthetic data. Real Codex
CLI traffic against the chatgpt backend lands as `usageStatus: "unreported"` for **all**
148 entries in `~/.opencodex/usage.jsonl` (147 `chatgpt` + 2 `chatgpt-p104398`). Every
entry shows `closeReason: "non_stream"`, so neither the SSE path nor `applyResponseLogMetadata`
on the JSON body extracted token counts.

We don't yet know whether:
- the chatgpt internal Responses endpoint returns a different JSON shape than the
  public Responses API (e.g. ChatCompletions-style `prompt_tokens`/`completion_tokens`),
- usage lives in a header rather than the body,
- or usage isn't returned at all (and we need to estimate).

Phase 7 ships two layers so we can diagnose without another full goal cycle:

1. **Extraction hardening** — broaden `usageFromResponsesPayload` to recognise
   the ChatCompletions shape (`prompt_tokens` / `completion_tokens`) and pick up
   cached/reasoning details under either `_tokens_details` naming. This may
   already fix the bug for some clients.
2. **Diagnostic capture** — when `OPENCODEX_USAGE_DEBUG=1` is set, append a
   rolling debug record per finalized request to `~/.opencodex/usage-debug.jsonl`
   so we can see what the upstream actually returns and act on Phase 8 with
   evidence instead of guesses. (SSE inspection accumulates block payloads into
   a single capped sample on `logCtx`; the final record is emitted once per
   request from `addFinalRequestLog`.)

## Scope

Out of scope: estimating tokens via tiktoken, log rotation, CSV export, GUI debug viewer.
Phase 8 will apply the targeted fix once Phase 7's diagnostic shows the real shape.

## Files

### NEW

- `src/usage-debug.ts` (~80 lines)
  - `export const USAGE_DEBUG_ENV = "OPENCODEX_USAGE_DEBUG";`
  - `export const USAGE_DEBUG_BODY_SAMPLE_BYTES = 2048;`
  - `export function isUsageDebugEnabled(): boolean` — true when env equals `"1"`.
    (Strict equality — `"true"`, `"yes"`, `"0"` are all false.)
  - `export function usageDebugPath(): string` — `${getConfigDir()}/usage-debug.jsonl`.
  - `export interface UsageDebugRecord` — `{ ts, requestId, provider, model,
    upstreamContentType, upstreamStatus, bodyKind: "sse" | "json" | "other" | "none",
    bodySample: string, extractedUsage: OcxUsage | null }`.
  - `export function appendUsageDebug(record: UsageDebugRecord): void` — ensures
    the parent dir exists (`mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 })`
    mirroring `ensureUsageLogDir` in `src/usage-log.ts`), appends one JSON line to
    the file (mode 0o600). After appending, if the file exceeds 200 lines, rewrite
    it keeping only the most-recent 100 lines (simple read/trim/write — file stays
    small so the cost is acceptable). All errors swallowed: debugging never breaks
    the proxy.
  - `export function truncateForDebug(text: string, max = USAGE_DEBUG_BODY_SAMPLE_BYTES): string`
    — clamps the body sample to `max` chars with a `... [+N more]` suffix when truncated.

### MODIFY

- `src/server.ts`
  - Extend the existing `RequestLogContext` interface (server.ts:88-100) with three
    new optional fields used by debug capture only:

      `usageDebugBodyKind?: "sse" | "json" | "other" | "none";`
      `usageDebugBodySample?: string;`
      `usageDebugContentType?: string;`
  - `export function usageFromResponsesPayload`: extend (and add `export`) to also
    accept the ChatCompletions shape. Try, in order:
    1. `input_tokens` / `output_tokens` (current Responses shape) — with
       `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`.
    2. `prompt_tokens` / `completion_tokens` (ChatCompletions shape) — coerce to
       `inputTokens` / `outputTokens`. Pull `cached_tokens` from
       `prompt_tokens_details.cached_tokens` and `reasoning_tokens` from
       `completion_tokens_details.reasoning_tokens` when present.
    3. Return `undefined` otherwise.
  - **Debug context propagation** — the existing `inspectResponseLogJson` and
    `inspectResponseLogSsePayload` only see `logCtx + payload text`, not requestId,
    provider, model, or content-type. Rather than thread those through every
    inspection signature (and through the SSE block loop), capture the body sample
    on `logCtx` via two new optional fields:

      `usageDebugBodyKind?: "sse" | "json" | "other" | "none";`
      `usageDebugBodySample?: string;`

    Only the **outer** inspector writes the debug body kind/sample for a given
    request: `inspectResponseLogJson` writes `bodyKind: "json"` only when called
    directly on the response body, and `inspectResponseLogSsePayload` writes
    `bodyKind: "sse"`. Since `inspectResponseLogSsePayload` internally delegates
    JSON parsing to `inspectResponseLogJson`, that nested JSON call must NOT
    overwrite the existing `usageDebugBodyKind` / `usageDebugBodySample`. Guard
    by skipping the JSON debug write when those fields are already set on logCtx.
    SSE inspection appends each block's payload (joined with `\n`) up to the
    same byte cap so we see the terminal block.

    `addFinalRequestLog` (which already has requestId + logCtx + status + meta) is
    the single point where the debug record is emitted. It reads
    `logCtx.usageDebugBodyKind / usageDebugBodySample`, builds a `UsageDebugRecord`
    with the resolved `logCtx.provider`/`logCtx.model` (and `responseContentType`
    captured below), and calls `appendUsageDebug`.

    For the upstream content-type, capture it once on logCtx as
    `usageDebugContentType?: string` from the passthrough handler (line 448 area)
    and from `responseWithDeferredRequestLog`'s `contentType` (line 1015), guarded
    by `isUsageDebugEnabled()`.
  - For the non-stream/no-body fallthrough in `responseWithDeferredRequestLog`
    (line ~1044), set `usageDebugBodyKind` to `"none"` (when `!response.body`) or
    `"other"` (body present but neither SSE nor JSON) BEFORE the `addFinalRequestLog`
    call so the debug record distinguishes the two.

  Hot-path safety: every new write is guarded by a single `isUsageDebugEnabled()`
  check, and field reads in `addFinalRequestLog` are `undefined`-tolerant.

### TEST (NEW)

- `tests/usage-debug.test.ts` (~70 lines)
  - Inline `beforeEach`/`afterEach` with `mkdtempSync` + `OPENCODEX_HOME` env
    swap, matching the pattern in `tests/usage-log.test.ts:16-26` (no shared
    helper exists yet — duplicating the pattern is acceptable for a single
    additional file).
  - `isUsageDebugEnabled()` returns false by default, true when env is set to
    exactly `"1"`, false for other values (`"true"`, `"yes"`, `"0"`).
  - `appendUsageDebug` writes a single JSON line (parseable, with the expected
    fields) and the file mode is 0o600.
  - After 200 appends, the file holds exactly 100 lines and the most-recent record
    is preserved (verifies the rotation rule).
  - `truncateForDebug` clamps as expected and preserves shorter strings verbatim.

- `tests/usage-shape-extraction.test.ts` (~40 lines)
  - Imports `usageFromResponsesPayload` from `../src/server` (after the new
    `export` keyword on the function definition; the function is currently
    module-private at server.ts:788 — the export is part of this phase).
  - Direct unit tests of `usageFromResponsesPayload`:
    - Responses shape with details → returns all four fields.
    - ChatCompletions shape (`prompt_tokens` + `completion_tokens` +
      `prompt_tokens_details.cached_tokens` +
      `completion_tokens_details.reasoning_tokens`) → returns equivalent
      `OcxUsage` mapped from prompt/completion to input/output.
    - Empty / null / wrong-type / missing both pairs → `undefined`.

### TEST (MODIFY)

- `tests/request-log.test.ts`
  - Add a case for ChatCompletions-shape JSON in `responseWithDeferredRequestLog`:
    response body `{"usage":{"prompt_tokens":42,"completion_tokens":7}}` results in
    `usageStatus: "reported"` and `totalTokens: 49`.

### Doc cue

- Append a one-line note to the existing usage section in
  `structure/05_gui-and-management-api.md` (where `usage.jsonl` and `/api/usage`
  are already documented) pointing at `OPENCODEX_USAGE_DEBUG=1` and
  `~/.opencodex/usage-debug.jsonl` as the debug capture for upstream response
  shape investigations. No new file.

## Verification

- `npx bun test tests/usage-debug.test.ts tests/usage-shape-extraction.test.ts tests/request-log.test.ts tests/usage-summary.test.ts tests/usage-log.test.ts`
- `npx tsc --noEmit -p tsconfig.json`
- Manual: restart proxy with `OPENCODEX_USAGE_DEBUG=1`, make one Codex CLI call to
  `gpt-5.5`, inspect `~/.opencodex/usage-debug.jsonl` head — confirm the body sample
  shows the real shape from the chatgpt backend.

## Atomic commits

1. `feat(usage): add diagnostic capture for upstream response shape`
   - `src/usage-debug.ts` (new)
   - `src/server.ts` (debug hook wiring only)
   - `tests/usage-debug.test.ts` (new)

2. `feat(usage): accept ChatCompletions-shape usage payloads in extractor`
   - `src/server.ts` (`usageFromResponsesPayload` extension + export if needed)
   - `tests/usage-shape-extraction.test.ts` (new)
   - `tests/request-log.test.ts` (modified)

3. `docs(usage): Phase 7 plan + OPENCODEX_USAGE_DEBUG cue in structure docs`
   - This devlog file + the appended line in
     `structure/05_gui-and-management-api.md`.

## Risks

- Debug file leaks request bodies to disk. Mitigated by env gate (off by default),
  0o600 perms, 2KB cap per record, and rolling truncation to the most-recent 100
  entries (rewrite triggered when the file exceeds 200 lines).
- The ChatCompletions shape extractor is additive — falls back to the current
  Responses path when those fields are absent. Existing tests catch regressions.
- We do not change the SSE inspection logic itself; only add observability around
  it. Worst case Phase 7 fixes one of the two shapes and Phase 8 still needs a fix
  for the other; that's fine and intentional.

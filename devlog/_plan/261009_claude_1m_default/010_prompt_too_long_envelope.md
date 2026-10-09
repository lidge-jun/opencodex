# 010 wp1: context overflow reaches Claude clients as `prompt is too long`

## Why

Claude Code recovers from an oversized prompt only when the API error says so in Anthropic's words:
it lowercases `error.message` and looks for `prompt is too long` or `input is too long for requested
model`, reads the token gap from `prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)`, and then
runs reactive compaction (2.1.288 binary, `b4n` / `fdt` / `mDt`). opencodex already classifies the
refusal (`code: "context_length_exceeded"`, status 400) but keeps the routed provider's wording, for
example `Your input exceeds the context window` or the proxy-owned
`PROVIDER_INPUT_TOO_LARGE_MESSAGE`. Claude Code then shows a fatal API error instead of compacting.

This layer is the safety net wp2 relies on: wp2 marks 872k windows as 1M on runners that do not
inherit `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so such a session can outgrow the real window before
proactive compaction fires. With this layer the first refusal compacts the session instead of
ending it.

## Scope

IN: the Anthropic error envelope builder and every Claude-wire producer that already passes
`code: "context_length_exceeded"` through it. OUT: status mapping (already 400), Codex/Responses
wire messages, the native Anthropic passthrough body (Anthropic already writes `prompt is too long`).

## Diff

### MODIFY `src/claude/outbound.ts`

Before (`:73-75`):

```ts
export function anthropicErrorBody(status: number, message: string, type?: string, code?: string): Rec {
  return { type: "error", error: { type: type ?? anthropicErrorType(status), message, ...(code ? { code } : {}) } };
}
```

After:

```ts
/**
 * Claude Code compacts reactively only when an oversized-prompt refusal is worded the way the
 * Anthropic API words it: it looks for `prompt is too long` (or `input is too long for requested
 * model`) in the message and reads `prompt is too long: <actual> tokens > <limit> maximum` for the
 * gap (2.1.288 binary). Routed providers word the same refusal differently, so a
 * context_length_exceeded envelope is rewritten into that form, keeping the counts when the
 * upstream text states them. Without this the client ends the turn on a fatal error instead of
 * compacting (devlog/_plan/261009_claude_1m_default/010).
 */
const CLAUDE_PROMPT_TOO_LONG_RE = /prompt is too long|input is too long for requested model/i;
const STATED_CONTEXT_COUNTS_RE = /maximum context length is (\d+) tokens[\s\S]*?(?:resulted in|you requested) (\d+) tokens/i;

export function claudePromptTooLongMessage(message: string): string {
  if (CLAUDE_PROMPT_TOO_LONG_RE.test(message)) return message;
  const counts = STATED_CONTEXT_COUNTS_RE.exec(message);
  if (counts) return `prompt is too long: ${counts[2]} tokens > ${counts[1]} maximum`;
  return `prompt is too long: ${message}`;
}

export function anthropicErrorBody(status: number, message: string, type?: string, code?: string): Rec {
  const text = code === "context_length_exceeded" ? claudePromptTooLongMessage(message) : message;
  return { type: "error", error: { type: type ?? anthropicErrorType(status), message: text, ...(code ? { code } : {}) } };
}
```

Every producer inherits the rewrite through the builder; none is edited:

| Producer | Path |
|---|---|
| Translated SSE `response.failed` | `src/claude/outbound.ts:441-471` (`fail` -> `anthropicErrorBody`) |
| Translated JSON `status: failed` | `src/server/claude-messages.ts:1460-1461` (`anthropicErrorResponse`) |
| Translated non-OK HTTP | `src/server/claude-messages.ts:1338-1386` (`anthropicErrorBody(..., contextError ? "context_length_exceeded" : undefined)`) |
| Direct Messages encoder | `src/protocols/encoders/messages.ts:186-201`, `:429-438` |
| Native Messages (pre-stream `fail`) | `src/server/messages-native.ts:349-352` (inherits through the builder) |

(The native lane, including the architect's D1 note on `messages-native.ts:901`, is covered in the next section.)

### Native Messages lane (audit blocker 1, round 2: folded, not rebutted)

A configured `anthropic`-adapter provider can reach the native lane with any window
(`src/server/messages-native-eligibility.ts:136-149`), so wp2 can widen a route served here. The
lane is normalized locally; `classifyError` (shared with the Codex wire) is not touched.

NEW in `src/claude/outbound.ts` beside `claudePromptTooLongMessage`:

```ts
/** Provider wordings of an oversized-input refusal, for lanes that relay a provider's own error text. */
const CONTEXT_OVERFLOW_TEXT_RE = /prompt is too long|input is too long|context window|context length|maximum context|too many tokens|model token limit/i;

export function isContextOverflowText(message: string): boolean {
  return CONTEXT_OVERFLOW_TEXT_RE.test(message);
}

/**
 * SSE payload rewrite for the native Messages lane: an `error` event that refuses an oversized
 * input gets the Anthropic wording; every other payload passes through byte-identical.
 */
export function claudeOverflowSsePayload(payload: string): string {
  if (!payload.includes("\"error\"")) return payload;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return payload; }
  if (!isRec(parsed) || parsed.type !== "error" || !isRec(parsed.error)) return payload;
  const error = parsed.error;
  const message = typeof error.message === "string" ? error.message : "";
  const sized = error.type === "invalid_request_error" || error.type === "request_too_large";
  if (!sized || !(error.code === "context_length_exceeded" || isContextOverflowText(message))) return payload;
  const next = claudePromptTooLongMessage(message);
  return next === message ? payload : JSON.stringify({ ...parsed, error: { ...error, message: next } });
}
```

MODIFY `src/server/messages-native.ts`:

- HTTP (`nativeMessagesErrorResponse`, `:865-906`): read `details.code` beside `details.type`;
  `const overflow = classified.code === "context_length_exceeded" || upstreamCode === "context_length_exceeded" || ((response.status === 400 || response.status === 413) && isContextOverflowText(safeMessage));`
  and pass `overflow ? claudePromptTooLongMessage(safeMessage) : safeMessage` to `anthropicErrorBody`
  (status and envelope shape unchanged).
- Streaming (`:747-770`): when `nativeInstance` (`:309-310`, the configured-instance identity, so a
  custom provider merely named `anthropic2` is not exempt) is absent, wrap `source` right after
  `echoRequestedModel` and before the stream/collect split, so both consumers see the same payload, with
  `relaySseWithPayloadRewrite(source, claudeOverflowSsePayload, translatorBudget)` (the helper the
  OAuth tool-name restore already uses, `src/server/sse-payload-rewrite.ts:257`). Real Anthropic
  pools skip the wrapper: they refuse oversized input pre-stream in their own wording, and the
  passthrough hot path keeps its single relay.
- Collected stream (`:785-792`): when the folded error passes the same test, answer
  `fail(400, claudePromptTooLongMessage(text), "invalid_request_error")` instead of 502.

Tests (new 010 test file, native harness pattern from `tests/claude-integration/`):

- HTTP 400 `{"type":"error","error":{"type":"invalid_request_error","message":"Your request exceeded model token limit: 262144"}}` from a custom `anthropic`-adapter provider -> client message starts `prompt is too long`.
- HTTP 400 with `"code":"context_length_exceeded"` and unfamiliar text -> rewritten.
- HTTP 413 with overflow wording -> rewritten, status 413 kept.
- HTTP 429 `rate limit ... tokens` -> untouched.
- SSE `rate_limit_error` whose message says `context window` -> untouched (type gate).
- Streaming: upstream `event: error` with `invalid_request_error` + `model token limit` -> relayed frame rewritten; a `content_block_delta` whose text contains `"error"` passes byte-identical.
- Collected (non-stream caller, streaming upstream): overflow error -> 400 with the rewritten message.

### MODIFY tests whose exact text changes

- `tests/claude-integration/claude-outbound.test.ts:939`: `message: "Cursor context limit exceeded"` -> `message: "prompt is too long: Cursor context limit exceeded"`.
- `tests/responses/protocol-direct-encoders-messages.test.ts:331` and `:337`: `message: "Synthetic input limit"` -> `message: "prompt is too long: Synthetic input limit"`.
- `tests/server/replay-refusal-parity.test.ts:308` uses `toContain` on the original text and still holds.

### NEW `tests/claude-integration/claude-prompt-too-long.test.ts`

Registered in `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`.

Cases (activation scenario -> observable effect):

1. Plain upstream text: `anthropicErrorBody(400, "Your input exceeds the context window", undefined, "context_length_exceeded")` -> message `prompt is too long: Your input exceeds the context window`, code kept.
2. Stated counts: OpenAI wording `This model's maximum context length is 272000 tokens. However, your messages resulted in 301234 tokens.` -> `prompt is too long: 301234 tokens > 272000 maximum`; and the message matches Claude Code's own parser regex `/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i` with groups 301234 / 272000.
3. Already Anthropic-worded: `prompt is too long: 1000 tokens > 900 maximum` and `Input is too long for requested model.` pass through unchanged.
4. Other codes untouched: `rate_limit` / `translation_buffer_limit` / no code keep the original message.
5. End to end on the translated SSE path: `responsesSseToAnthropicSse` with a `response.failed` frame carrying `context_length_exceeded` and `PROVIDER_INPUT_TOO_LARGE_MESSAGE` -> terminal `error` frame whose message lowercased includes `prompt is too long`.

## Verification

- `bun run typecheck`
- `bun test tests/claude-integration/claude-prompt-too-long.test.ts tests/claude-integration/claude-outbound.test.ts tests/responses/protocol-direct-encoders-messages.test.ts tests/server/replay-refusal-parity.test.ts`
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` (new file registration)
- Full suite: exact-head CI.

## Risks

- Counts are only carried over when both OpenAI phrases are present (`maximum context length is L
  tokens` and `resulted in` / `you requested A tokens`); any other wording is prefixed verbatim, so
  no number is guessed (architect reflection D1). Test case 2b: `maximum context length is 272000
  tokens; 3 tokens of overhead` (no request phrase) -> prefixed, no counts.
- Native Anthropic text is already compliant; the rewrite is a no-op there.

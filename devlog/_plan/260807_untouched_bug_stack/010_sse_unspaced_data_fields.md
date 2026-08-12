# 010 — #1170: SSE parsers reject unspaced `data:` fields

## Defect

The SSE spec makes the space after `data:` optional; a compliant producer may
send `data:{"choices":[...]}`. Four adapter-side parsers require the space and
silently drop every frame without it, so a stream from such a provider looks
like a completed turn with no content.

Strict call sites on `origin/dev@6d04574d0`:

- `src/adapters/openai-chat.ts:950` — `if (!line.startsWith("data: ")) return "continue";`
- `src/chat/outbound.ts:674`
- `src/claude/outbound.ts:865` (and the `event: ` sibling at `:864`)
- `src/claude/outbound.ts:591-605` — a **second, separate** parser in the same
  file, missed on the first pass; it does its own `startsWith("event: ", ...)`
  and `startsWith("data: ", ...)` against a raw frame with byte-budget
  accounting interleaved
- `src/web-search/parse.ts:190`
- `src/server/claude-messages.ts:174` — another site, not named in the report

Lenient call sites that prove the intended behavior:

- `src/lib/sse-decoder.ts:193-208` — strips at most one leading ASCII space
- `src/server/relay.ts:262-269`
- `src/adapters/google.ts:618-620`

The split is the bug: the same wire format is accepted on the relay path and
rejected on the adapter path.

## Change

Export one pure helper from `src/lib/sse-decoder.ts`, beside the decoder whose
semantics it mirrors:

```ts
export function sseFieldValue(line: string, field: string): string | null;
```

Returns `null` when the line is not that field. Otherwise returns the value with
at most one leading ASCII space removed — one, not `trimStart()`, because
leading whitespace beyond the first character is payload.

Then replace the strict prefix checks with calls to it — **six sites, not
five**. `src/claude/outbound.ts` has two independent parsers (`:591-605` and
`:864-865`); both need it, and both need it for `event` as well as `data`, since
the `event: ` check carries the identical defect.

The `:591-605` site is the delicate one: it reserves and commits translator
budget per fragment, so the edit must change only which offset the fragment
starts at, leaving every `reserveTransient` / `commitRetained` /
`releaseRetained` call and its byte accounting untouched.

Deliberately not doing: migrating these collectors to `decodeServerSentEvents`.
They own different buffering, budget accounting, heartbeat, and EOF-failure
behavior. Replacing six short prefix checks is the whole change; swapping
six stream state machines is not.

Four local copies of `slice(5)` would also work and would be worse — this class
of bug is exactly what happens when the same parsing rule is written six times.

## Preserve

Each caller's existing `.trim()` on the extracted payload stays where it is. The
helper does not trim, so callers that intentionally keep payload whitespace are
unaffected.

## Two adjacent defects, deliberately not fixed here

The audit surfaced two more spec deviations in the same parsers. Naming them so
the next reader does not assume this phase covered them:

1. **Frame delimiting.** `src/claude/outbound.ts:567` and
   `src/server/claude-messages.ts:171` split on `\n\n` only, so a CRLF producer
   (`\r\n\r\n`) is not framed correctly.
2. **Multiline `data` joining.** `src/claude/outbound.ts:605` and
   `src/server/claude-messages.ts:174` concatenate consecutive `data` fragments
   with no separator; the spec joins them with `\n`.

Both are real, and both are frame-level rather than field-level — fixing them
means changing buffering and joining semantics, which is a different blast
radius from swapping a prefix check. This phase stays field-level so the diff
stays reviewable. The tests below add CRLF and multiline cases as
**characterization** tests that record current behavior, so whoever fixes the
framing has a baseline and cannot regress the prefix fix while doing it.

## Tests

Each asserts real content arrives rather than a silently empty turn.

| File | Test | Assertion |
|---|---|---|
| `tests/openai-chat-hardening.test.ts` | `accepts unspaced data fields and finish_reason without DONE (#1170)` | text delta, `done`, stop reason, usage |
| `tests/chat-completions-endpoint.test.ts` | `collectChatCompletion accepts unspaced data fields` | final `message.content` |
| `tests/claude-outbound.test.ts` | `collectAnthropicMessage accepts unspaced event and data fields` | completed text and stop reason |
| `tests/web-search-parse.test.ts` | `parseSidecarSSE accepts unspaced data fields` | completed text and source extraction |
| `tests/claude-outbound.test.ts` | `raw-frame parser accepts unspaced event and data fields` | the `:591-605` parser, with budget accounting intact |
| `tests/claude-messages-endpoint.test.ts` | `usage extraction accepts unspaced data fields` | the `src/server/claude-messages.ts:174` site: usage extraction and finalization |
| `tests/claude-outbound.test.ts` | `characterizes CRLF framing and multiline data joining` | records today's behavior for the two deferred defects |

Every one of these fails before the change: the frames are dropped and the
assertions see empty output. Each of the six production call sites has a test
that covers it.

## Blast radius

Unknown-line handling, multiline `data` joining, CRLF, `[DONE]`, translator
accounting, and fail-closed EOF. The helper is additive and pure, so the risk is
concentrated in whether each call site's replacement preserves its own trim and
continue/terminate semantics. Read each of the six in full before editing.

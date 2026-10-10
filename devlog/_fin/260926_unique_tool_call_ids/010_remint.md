# Unique tool-call ids for positionally-minting chat upstreams

Defect: `src/adapters/registry.ts` `openai-chat` entry. The adapter forwards
`tool_calls[].id` upstream-verbatim, which is correct for an upstream that mints a fresh random id
per call (measured: `zai-org/glm-5.3-flash` mints `call_<24 hex>`, never repeating). An upstream
that derives the id from the call's **position in its response** instead mints the same `call-0-0`
on every turn of a conversation (measured: `deepseek-ai/deepseek-v4.1-flash` behind the same
gateway — three sequential turns, `call-0-0` every time; non-streaming mints `call-<toolIdx>`).
A Messages client has already paired that id with an earlier call, drops the duplicate, and is left
with a tool call carrying no result: the turn folds to an assistant message with no content, the
model re-issues the same call, and the conversation loops without ever erroring. The client's own
debug log confirms it sees no duplicate — `tool_uses=[call-0-0]` / `tool_results=[call-0-0]` with
zero `api_retry` — so the loop is not a retry storm but a silently-dropped pairing.

Reproduced with real Claude Code against a mock upstream that always mints `call-0-0`:
**unpatched, 2186 stream events, 1 unique id, exit 124 (loop); patched, 3 unique ids
(`call-0-0`, `call-0-0-2`, `call-0-0-3`), `subtype: success`, exit 0.**

Change:

- New leaf `src/adapters/openai-chat/tool-call-id-remint.ts`: `createToolCallIdReminter(reserved)` and
  `reservedToolCallIdsFromHistory(messages)`. First occurrence of an id is emitted byte-identical —
  prompt-cache keys, reasoning-replay lookups and already-unique upstreams are untouched; only a
  **repeat** is rewritten, to the smallest unused suffix that fits the 64-char Anthropic id bound.
  The suffix is `-<n>`, never `_<n>`: an id extending another as `<earlier>_<digits>` is read by the
  client as batch sub-call N of `<earlier>`, which pairs the second call's result to the first. That
  shape was measured separately: with an `_<n>` remint the same harness accumulated 10 placeholder
  results; `-<n>` produced none.
- New wrapper `src/adapters/unique-tool-call-ids.ts`: remints `tool_call_start` on both the
  streaming and buffered paths, seeded from `parsed.context.messages` in `buildRequest` — the only
  point that sees the caller's history, which is the authority on which ids are taken because it is
  the side that discards duplicates. Emission-only: ingest-time rewriting would strip a pending
  streamed call of the identity its own delta fragments match against.
- `src/adapters/registry.ts`: the `openai-chat` factory now wraps in `withUniqueToolCallIds`, the
  same shape as the existing `withClinePassDeepSeekV4ToolReplayCompatibility` wrapper.
- `src/adapters/openai-chat.ts` is **untouched**: it sits at its 822-line ratchet cap with zero
  headroom, and the remedy is a sibling file, not a raised number (`AGENTS.md:255-271`).

Tests (new `tests/adapters/openai/openai-chat-tool-call-id-remint.test.ts`, registered in both
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`): a positional
upstream driven through three real turns emits three distinct ids; a first turn with no history
emits the upstream id byte-identical; the suffix shape is asserted directly; repeated occurrences
within one response stay distinct; a reserved suffix is skipped; every rewrite stays conforming and
within the length bound; a non-conforming id is sanitized rather than dropped; the history scan
reads both the assistant call and the tool result. Verified to fail against a pass-through wrapper
(`["call-0-0","call-0-0","call-0-0"]`) and pass with the fix.

Docs: `structure/providers-and-adapters.md` gains the `src/adapters/unique-tool-call-ids.ts` row and
the `tool-call-id-remint.ts` leaf. `structure/providers/chat-compat.md` would have been the natural
home but sits at exactly its 600-line budget.

# A2 — #4148 mid-conversation Claude `role: system` breaks the prompt-cache prefix

Raw research: `_research/4148.md`.

## Verdict

Real, and deliberate in origin. `cee918ce3` folded in-messages `role: "system"`
into `instructions` so native ChatGPT would not 400 on a `system` input item, and
`tests/claude-integration/claude-inbound.test.ts:313` still locks that shape. The
2026-07-11 note that folding is "the only shape that works on every route" is
stale: Responses accepts chronological `role: "developer"` items.

## Root cause

`src/claude/inbound.ts:322-336` pushes **every** `role: "system"` message onto
`systemParts`, including ones that arrive after user/assistant turns, and
`:348` assigns the join to `body.instructions`. `src/responses/parser.ts:144-145`
pushes `data.instructions` onto `systemPrompt` before anything else, so each
injected reminder mutates the prompt head and invalidates the KV prefix. (An
earlier draft cited `parser.ts:204-206`; that span is the `context_compaction`
encrypted-content path, not the instructions read.) The Desktop
`prompt_cache_key` fallback hashes the
same `systemParts` (`inbound.ts:373-394`), so the cache key rotates too.

## Chosen fix

In `translateAnthropicRequest`, emit each non-empty in-messages system message as
a chronological input item:

```
{ type: "message", role: "developer", content: [{ type: "input_text", text }] }
```

Stop pushing it onto `systemParts`. Top-level Anthropic `system` keeps flowing
through `systemToInstructions` into `body.instructions` unchanged.

**Not `role: "system"` in `input`.** The schema allows it (`src/responses/schema.ts:46-49`)
but ChatGPT Codex rejects it, `parseRequest` re-hoists it (`parser.ts:246-250`),
and the canonical Responses forward folds text-only system items back into
`instructions` (`src/adapters/openai-responses.ts:1472-1512`). `developer` is
first-class (`schema.ts:40-44`, `parser.ts:253-258`) and keeps timeline order.

**Scope decision — taken here, and it is a policy choice rather than a mechanical
one.** All in-messages system messages become developer items, not just the ones
after the first user turn. `_research/4148.md` marks this exact fork as POLICY.
The leading-only alternative keeps `:313` green but still mutates `instructions`
whenever the client injects a fresh leading system message each turn, which is the
reported failure, so it does not close the issue. Say which choice was taken in
the PR body so a reviewer can object to it.

## Out of scope, stated in the PR body

`src/adapters/openai-chat.ts:722-748` re-hoists all text developer messages into
a leading `system` chat message for non-`api.openai.com` Chat Completions, locked
by `tests/adapters/openai/openai-chat-system-order.test.ts:21-47`. That is what
keeps the reporter's DeepSeek/SenseNova path broken, and reversing it is a separate
compatibility tradeoff. OpenCode Go's Muse is `openai-responses`, so the inbound
fix reaches it. `src/chat/inbound.ts:264` has the same anti-pattern for Chat
inbound; not this issue.

## Regression test

`tests/claude-integration/claude-inbound.test.ts` (already registered). New case:

- `system: "S"`; turn 1 `user u1`, `system r1`; turn 2 `user u1`, `system r1`,
  `assistant a1`, `user u2`, `system r2`
- `turn1.instructions === turn2.instructions === "S"`
- `turn2.input` roles `["user","developer","assistant","user","developer"]` with
  texts `u1, r1, a1, u2, r2`
- no input item has `role === "system"`
- `responsesRequestSchema.parse` and `parseRequest` both succeed
- with no `metadata.user_id`, `turn1.prompt_cache_key === turn2.prompt_cache_key`

Rewrite `:313` to the new contract; it is the test that encodes the old hoist.
Leave `:66`, `:429`, `:439-492` alone — they use top-level `system`.

## Known consequence

Anthropic and Google outbound present developer items as chronological `user`
(`src/adapters/anthropic.ts:711-726`, `src/adapters/google.ts:310`). Semantic
drift from privileged system text, but prefix-stable, which is the point.

## PR

`fix(claude): keep mid-conversation system messages in the timeline` — branch
`lane-a/2-4148`, PR base `lane-a/1-4129`. Closes #4148.

# U6 — what `message_start` is allowed to claim about usage

Source: issue #4857. Verified against `f1dfda8e48`.

## What is wrong, stated precisely

`messageSnapshot(model)` in `src/claude/outbound.ts` hard-codes
`usage: { input_tokens: 0, output_tokens: 0 }`, and `ensureStarted()` emits
`message_start` with that snapshot. Real usage reaches the client only through
`anthropicUsage(...)` on the terminal `message_delta`.

This is not an accounting defect. `~/.opencodex/usage.jsonl` records the right
numbers, Claude Code does not read the first frame, and compaction and cost are
unaffected. It is a display-contract defect: real Anthropic populates
`message_start.message.usage.input_tokens` with the prompt size, a third-party
client that follows that documented contract reads `0`, and Paseo's context
ring shows a few hundred tokens for a 97k-token session.

## Two things this unit must not do

It must not manufacture a number that is not known when `message_start` is
emitted. An estimate is indistinguishable from a measurement once it is on the
wire, and a client that trusts the contract would then be wrong in a new way
instead of the old one.

It must not buffer the response to learn the usage before emitting the first
frame. That trades a display gap for a latency regression on every turn, and
the streaming surface exists precisely so the client sees output early.

Both are ruled out, so "always correct `input_tokens` in `message_start`" is
not an achievable goal and is not the completion criterion.

## The seam that makes a real fix possible anyway

`message_start` is already lazy. `ensureStarted()` is not called when the
stream opens — it is called from the first event that produces output, and from
`finish()`. So any usage the upstream has already reported by the time the
first content arrives is in hand before the frame is written. Using it is not
buffering and not estimation; it is reading a value that arrived first.

That splits the upstreams into two populations, and the policy differs by
population rather than by guesswork:

**Early-confirmed usage.** The upstream reported input usage before the first
content event. `message_start` carries the real `anthropicUsage(...)` values,
including `cache_read_input_tokens` and `cache_creation_input_tokens`. A
first-frame reader is correct from the first frame.

**No early usage.** The upstream has reported nothing by then, which the issue
correctly identifies as the common case for the Responses path.
`message_start` keeps the zeroed snapshot, because the Anthropic wire shape
requires the key and there is no honest value to put in it. Nothing is invented
and nothing is delayed. The terminal `message_delta` stays authoritative, as it
is today.

The two populations must not contradict each other or the final accounting.
Concretely: whatever `message_start` claims, the terminal `message_delta`
still carries the full `anthropicUsage(...)` result for the turn, and
`usage.jsonl` is unchanged by this unit. A client that reads only the last
frame sees exactly what it sees today.

## Regression coverage

`tests/claude-integration/claude-outbound.test.ts` is the existing home, so no
new test file and no layout entry.

The current suite asserts usage almost entirely on `message_delta`, which is
why a zeroed first frame never registered as a regression. The new assertions
pin the split rather than a constant:

1. Upstream reports input usage before the first content event: `message_start`
   carries that input count, and cache read/creation values survive the
   `anthropicUsage` transform.
2. Upstream reports usage only at the end: `message_start` carries the zeroed
   snapshot and the terminal `message_delta` carries the real numbers. This
   case is asserted as the documented policy for an unknowable value, not as
   the correct output of the translator in general.
3. In both cases the terminal `message_delta` reports the same totals it
   reports today, so display and accounting cannot disagree.

Case 2 is deliberately worded in the test so that a later change which starts
estimating the first frame has to delete an assertion that says why it was
zero, rather than silently flipping a number.

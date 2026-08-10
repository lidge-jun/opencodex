# 060 — #545 Claude Desktop classifier retries

Stack layer 3. Work class C4 by promotion: the change lands on an Anthropic
OAuth execution path, so `MAINTAINERS.md` security review applies even though
no credential handling is touched.

## The reported symptom

In Claude Desktop 3P gateway-key mode with an Anthropic OAuth provider, Claude
Code's Auto Mode permission classifier is truncated at exactly 64 output tokens
with `max_tokens` and retries up to five times. The reporter's own aggregate:
1,084 truncated requests against 143 that completed under 64 tokens. Every tool
approval costs 12–22 seconds.

## The standing hypothesis was wrong

The recorded analysis said the classifier's 64-token budget "has to accommodate
the prepended identity block, and that is where the retries come from."

That cannot be the mechanism. The identity block is prepended to the **system**
prompt (`src/adapters/anthropic.ts:752-757`), and `max_tokens` caps **output**.
Input and output are different budgets; a longer system prompt cannot arithmetically
consume output allowance.

This repository had already reached that conclusion once and forgotten it:
`devlog/_fin/260728_bug_bundle_resolution/030_claude_system_dedup.md` abandoned
an identity-dedup patch for exactly this reason. Re-deriving a rejected theory
is what a devlog is supposed to prevent.

## The actual mechanism

A round-trip fidelity loss, three hops long.

**Hop 1 — the client says "no thinking".** The reporter's inbound capture
carries `thinking: {type: "disabled"}` alongside `max_tokens: 64` and
`stop_sequences: ["</block>"]`.

**Hop 2 — ocx drops the instruction.** `src/claude/inbound.ts:494-506` treats
disabled thinking as *nothing to translate*:

```ts
const thinkingDisabled = isRec(thinking) && thinking.type === "disabled";
if (!thinkingDisabled && (isRec(thinking) || outputConfigEffort !== undefined)) {
  ...
  body.reasoning = reasoning;
}
```

`reasoning` stays `undefined` — the same state produced by a request that never
mentioned thinking at all. The existing test pins this
(`tests/claude-inbound.test.ts:96-97`): both "disabled" and "omitted" assert
`reasoning` is `undefined`. Two different intentions, one representation.

**Hop 3 — omission means the opposite upstream.** The adapter emits `thinking`
only for a real non-`none` effort (`src/adapters/anthropic.ts:769-770`), so the
outbound request omits the field. Anthropic documents that for Sonnet 5 an
omitted `thinking` field means *adaptive thinking is on by default*, and that
thinking tokens count against `max_tokens` (retrieved 2026-08-04:
[what's new in Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5),
[extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)).

So the model thinks, thinking eats the 64-token budget, and generation stops
before `</block>` is ever emitted. The classifier never sees its stop sequence,
Claude Code retries, and the loop runs to its five-attempt ceiling. The 64
tokens is the caller's own value and is faithfully preserved
(`src/adapters/anthropic.ts:750`) — that part of the prior analysis was right.

The client asked for no thinking. It got thinking. That is the whole bug.

## Design

Give "disabled" a representation that survives the trip, using the sentinel the
parser already understands — `"none"` is documented at
`src/adapters/anthropic.ts:766-769` as the disable sentinel.

`src/claude/inbound.ts`:

```diff
-if (!thinkingDisabled && (isRec(thinking) || outputConfigEffort !== undefined)) {
+if (thinkingDisabled) {
+  body.reasoning = { effort: "none", summary: "none" };
+} else if (isRec(thinking) || outputConfigEffort !== undefined) {
```

`src/adapters/anthropic.ts` — emit the explicit disable before the existing
non-`none` branch, gated on models that both default to thinking-on and accept
an explicit disable:

```diff
+if (parsed.options.reasoning === "none" && supportsExplicitThinkingDisable(parsed.modelId)) {
+  body.thinking = { type: "disabled" };
+} else
 if (typeof parsed.options.reasoning === "string" && parsed.options.reasoning !== "none") {
```

### Audit correction: `usesAdaptiveThinking()` is the wrong gate

The first draft reused `usesAdaptiveThinking()`
(`src/adapters/anthropic.ts:411-421`) on the reasoning that it already
version-gates the right families. It does not — it answers a different
question, and the audit caught two ways it is wrong:

- `ADAPTIVE_THINKING_FAMILY_MINIMUMS` includes `fable: [0, 0]`
  (`src/adapters/anthropic.ts:405`), so **every** Fable model matches. Fable 5
  always has thinking enabled and rejects an explicit disable, so this gate
  would emit a body that 400s. Worse, `tests/anthropic-reasoning.test.ts:139`
  already asserts that `claude-fable-5` with `"none"` sends **no** thinking
  config — the draft would have required breaking a passing test to ship a
  production 400. That test was right and the plan was wrong.
- Opus 4.7/4.8 match the predicate but leave thinking off when the field is
  omitted, so they need no disable at all.

The predicate's own comment says what it is for: which families 400 on
`thinking.type: "enabled"` versus on `adaptive`. That is a *wire-shape*
question. "Does omission mean thinking is on, and is an explicit disable
accepted?" is a *capability* question, and the two sets genuinely differ.

So this phase adds a separate `supportsExplicitThinkingDisable()` predicate,
seeded narrowly with the family this issue actually reproduces on —
`claude-sonnet-5` — and widened only per model with vendor evidence. Narrow is
also the right risk posture for an OAuth execution path.

**Pre-write search (DEV-NECESSITY-01).** Reuse was checked first and rejected
on evidence rather than skipped: `usesAdaptiveThinking()` is the only existing
model predicate in this adapter, and it answers a different question. The new
predicate borrows its parsing shape so date-pinned and suffixed ids behave
identically.

Explicitly unchanged: `max_tokens`, `stop_sequences`, the OAuth identity block,
terminal mapping, retry behavior, native passthrough.

## Tests

`tests/claude-inbound.test.ts:96` — the pinned expectation changes from
`undefined` to `{effort: "none", summary: "none"}`. Line 97 (omitted thinking →
`undefined`) must **stay** `undefined`: that assertion is what proves disabled
and omitted are no longer the same state, which is the entire fix.

`tests/anthropic-reasoning.test.ts` — Sonnet 5 + `"none"` emits
`thinking: {type: "disabled"}`; Sonnet 5 with reasoning omitted still omits
`thinking`; and the **existing** `claude-fable-5` + `"none"` assertion at
`:139-144` stays green unchanged, which is the regression proving the gate did
not widen past its evidence.

Round-trip regression — the reporter's exact shape in, and assert the final
adapter body carries `max_tokens: 64`, `stop_sequences: ["</block>"]`,
`thinking: {type: "disabled"}`, and the OAuth identity still first in `system`.

## Honest limits

The unit tests prove the wire shape, not the retry disappearing. Confirming
that requires a live Claude Desktop 3P + Anthropic OAuth session showing the
classifier terminating on `</block>` instead of `max_tokens`. The PR says so
rather than claiming the symptom fixed.

No public Anthropic documentation was found specifying the exact Claude Code
OAuth identity string requirement; that remains repository knowledge from live
behavior. The fix leaves it untouched, so nothing depends on proving it here.

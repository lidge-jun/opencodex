# wp2 — one visible answer per turn

Consumes: `000_research.md` mechanism 1.

## Problem

Kiro emits answer-like ordinary text and then calls the private completion tool
in the SAME inference. The adapter releases the prose as `phase: "commentary"`
and the completion `answer` as `phase: "final_answer"`;
`src/bridge.ts` closes the commentary message on the phase change and opens a
new assistant message. The client renders two assistant messages whose text is
nearly identical. This is what the user saw.

The existing suite pins this pair, so the fix necessarily REPLACES an asserted
expectation rather than adding to it:

```
tests/kiro-stream.test.ts
{ type: "text_delta", text: "Done.", phase: "commentary" },
{ type: "text_delta", text: "Done.", phase: "final_answer" },
```

## Constraint that shapes the design

Progress prose is load-bearing UX: a long tool-using turn streams commentary so
the user is not left staring at nothing. Withholding ALL commentary until the
turn resolves would trade a cosmetic duplicate for a silent turn, which the
repository's own comments call out (`#520` gates exist precisely to avoid
re-emitting or losing flushed progress).

So the buffering must be NARROW: hold back only the trailing commentary run that
has not yet been followed by a real tool call, and only while the completion tool
is still capable of arriving. Release it unchanged the moment a real tool starts,
the stream ends without a completion answer, or the bounded fallback engages.

## Options

1. **Consume the same inference's retained text on a valid completion.** (CHOSEN —
   narrowed in audit round 1, corrected in round 2.) No new buffer is needed:
   required-mode commentary is ALREADY deferred. But skipping the inner flush is
   NOT sufficient, and this is the correction that matters:

   - The inner flush is at `src/adapters/kiro.ts:1467`.
   - `parseKiroAttempt` INDEPENDENTLY drains whatever remains in `deferred` at
     `src/adapters/kiro.ts:996-999`, after the inner generator returns.

   So merely skipping the inner flush emits the final answer first and then the
   commentary from the outer drain — the duplicate survives, in reversed order.
   The deferred collection must be CONSUMED on a valid completion: discard and
   release the redundant `text_delta` events, preserve and release every
   non-text event, and leave nothing for the outer drain. That necessarily
   touches retention ownership, so the earlier claim that this change stays
   clear of the retention machinery is withdrawn.

   `text_fallback` has the SAME shape through a DIFFERENT collection: it retains
   in `fallbackEvents`, and `src/adapters/kiro.ts:1470-1477` emits all of them
   and then the completion answer. The rule must therefore apply independently
   inside EACH inference:

   - required inference + valid completion -> suppress its deferred text, keep
     non-text events, emit the completion answer;
   - text_fallback inference + valid completion -> suppress that inference's
     retained text, keep non-text events, emit the completion answer;
   - never retain one inference's progress across the next inference.
2. **Retain commentary ACROSS the bounded fallback.** Rejected by the audit: the
   second inference can be long, so withholding first-attempt progress across it
   would make the turn look dead and contradicts the deliberate "first attempt
   already flushed" gate.
3. **Suppress only on redundancy.** Emit commentary live, and skip the completion
   answer if it is substantially the same text. Rejected: "substantially the same"
   is a similarity heuristic, and a wrong guess either drops the real answer or
   keeps the duplicate.
4. **Bridge-side coalesce.** Merge a commentary message and an immediately
   following final answer into one assistant message. Rejected as the primary
   seam: the phase distinction is deliberate protocol information, and the same
   split is correct when the commentary genuinely preceded tool work.

Because the deferral already exists, this is a change to WHEN the deferred run is
released, not a new retention mechanism — which also keeps it clear of the
retention/budget machinery where duplication bugs have previously lived.

## Criteria

1. A single inference emitting answer-like prose plus a completion answer yields
   exactly ONE visible answer to the client.
2. Commentary followed by a REAL tool call is still emitted live and in order.
3. A CLEAN required-mode inference — text or reasoning present, no real tool, no
   completion answer, no explicit non-completion stop reason — still shows its
   progress prose and enters the bounded fallback exactly once. (Narrowed in
   audit round 2: the unqualified form was false for real tools, provider and
   protocol failures, and explicit stops such as `MAX_TOKENS` or
   `CONTENT_FILTERED`.)
4. A Responses-protocol-level assertion, not only adapter events: the user-visible
   duplicate must be proven gone through the bridge. Adapter-event coverage cannot
   prove this, because the split happens in the bridge on the phase change. The
   assertion belongs in `tests/server-kiro-completion-e2e.test.ts`: one upstream
   request, exactly one visible assistant answer, one terminal completion, and the
   near-duplicate prose absent.
5. The existing `tests/kiro-stream.test.ts` expectation that asserts the
   commentary/final pair is UPDATED, not deleted — the replacement states the new
   contract for the same scenario.
6. `text_fallback` ordinary text plus a valid completion also yields exactly one
   visible answer.
7. The translator budget returns to baseline after suppressed events — suppression
   must release retention, not leak it.

## Release paths that must remain intact

Enumerated from source in audit round 2; each is a control the implementation may
not regress:

| trigger | release point |
|---------|---------------|
| a real tool starts (`sawRealTool`) | `src/adapters/kiro.ts:1172-1177`, released with the tool event |
| clean no-completion turn needing fallback | flush before `needsFallback` returns, `src/adapters/kiro.ts:1535-1542` / `1600-1603` |
| stream / protocol / provider failure | outer failure drain, `src/adapters/kiro.ts:996-999` |
| explicit non-completion stop | released before the incomplete/error branches, `src/adapters/kiro.ts:1545-1598` |
| plain-text fallback without completion | retained text promoted to `final_answer`, `src/adapters/kiro.ts:1488-1501` |
| empty / reasoning-only fallback | diagnostics released before the structured incomplete, `src/adapters/kiro.ts:1503-1517` |

## Out of scope

- The terminal-boundary fix (wp1).
- Changing what `phase` means in the Responses protocol.

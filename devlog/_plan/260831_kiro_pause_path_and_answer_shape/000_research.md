# Kiro post-answer tool calls, round two: why the prompt fix failed

The user reported the same defect a second time, with a hard pair of
requirements: never recur, and do not regress anything.

## The first fix is live and did not work

PR #3012 (`f5a625cf3`) appended terminal semantics to both injected surfaces.
That code was serving when the defect recurred:

| Fact | Value |
| --- | --- |
| Serving proxy | PID 55727, port 10100, version 2.37.0 |
| Proxy start | 09:23:37 |
| Adapter file mtime | 01:28 (same day, before the start) |
| `f5a625cf3` ancestry | ancestor of the serving HEAD |
| Failure | 09:27 |

So prompt wording is not a sufficient mechanism for this defect. That is the
finding that governs this unit.

## What actually happened

A 1454-char answer-shaped message and the next `exec` call came out of ONE
inference, 4ms apart (message `00:27:23.114`, call `00:27:23.118`), with
`sendCount: 1` and no second upstream request. This was never "the model keeps
working after the turn ended" — there was no second turn to keep working in.

The message text is the proof. It ends:

> ...이 호출 경계 동작은 문서에 아직 정확히 안 들어가 있습니다. 넣어둘까요.레퍼런스에
> 있는 "scope persists" 서술이 실측과 어긋나니 그 부분부터 고치겠습니다.

A permission question, glued with no separator to a sentence that overrides the
question and proceeds. Two emissions merged into one message: the model asked
the user something and then answered itself, inside one inference.

The adapter behaved exactly as designed. `defer()` holds staged text, a real
tool call proves the turn continues, and the staged prose is released as
`commentary`.

## Root cause: there is no sanctioned way to pause

In `required` mode the model has three expressible moves and none of them is
"I have a question, hold for the user":

- Ordinary prose does not end the turn, by explicit contract.
- The completion tool means "the task is fully complete and no more work or tool
  calls are needed" — which a pending question is not.
- A real tool call continues the turn.

`KIRO_COMPLETION_RETRY_MESSAGE` closes the last door explicitly: *"Do not ask
the user for another task or emit another progress-only message."*

So a model that wants to ask has no explicitly endorsed blocking-question move.
Pausing is mechanically expressible — the ask tool is advertised and works — but
nothing in the injected contract endorses it, and the one instruction the model
sees at the moment it fails to complete reads as a ban on asking. Continuing to
work is the only move the contract actively endorses, which is what it did.

## The regression boundary, measured

Across 644 Kiro rollouts, same-inference prose (>=600 chars) followed by a real
tool call occurs 26 times. Only 4 have a tail that asks the user something. The
other 22 are ordinary progress narration and must keep working unchanged.

Prose length cannot separate them:

- 4 question-tailed: 1329, 1454, 1697, 1938 chars.
- 22 legitimate: 608 ... 3141 chars.

The ranges overlap completely. Any length or volume threshold that catches the
four also catches legitimate narration, and any threshold that spares the 22
also spares the defect. There is no structural discriminator for the general
prose-plus-tool shape, which an independent read-only design audit confirmed
from the code: at `flushOpen` the adapter knows only that a non-completion tool
was emitted, its restored identity, and its arguments. `stopReason` cannot help
either — Kiro emits `END_TURN` for progress prose, and the adapter deliberately
ignores it when a real tool exists.

## Rejected candidates

**Gate the answer-shaped prose.** Rejected: it requires a text heuristic to tell
the 4 from the 22, and the measurement above shows no non-heuristic signal
exists. A regex would decide whether the user sees their agent's work.

**Discard prose when a real tool follows** (what `consumeSupersededByCompletion`
does on the completion path). Rejected: on the real-tool path no replacement
answer ever arrives, so all 22 legitimate progress messages would silently
vanish rather than arrive later.

**Isolate the ask tool** (relay `request_user_input`, fail closed on any later
real tool from the same inference). Rejected as the primary mechanism: measured
8 `request_user_input` calls across 644 rollouts, and the
ask-then-another-tool shape occurs **0** times. It guards a case that does not
happen. Shipping a guard for an unreachable path with a test that cannot fail is
the exact trap this unit's predecessor already fell into once.

## What the evidence does support

`request_user_input` already terminates a Kiro turn cleanly. Measured three
times in the failing session itself: staged prose, then the ask call, then the
turn yields and the human answers. The pause path exists and works — the model
simply did not take it, because the contract never told it to and the retry
message reads as a ban on asking.

The completion channel is also content-agnostic: a completion answer yields
`final_answer` and `done(endTurn: true)` regardless of what the answer says. A
question delivered there ends the turn correctly today.

So the gap is not enforcement, it is expressibility. The contract describes two
states (still working, fully done) for a model that has three (still working,
done, blocked on the user). The fix is to make the third state expressible and
to stop forbidding it.

## Honest statement of limits

This unit cannot make the defect impossible without model compliance, and it
will not claim otherwise. Deterministic prevention would need a structural
upstream signal that does not exist: Kiro accepts only automatic or no tool
choice, so the proxy cannot force a typed progress/pause/complete protocol. The
bad and good event streams are observationally equivalent at the adapter.

What this unit can do is remove the contradiction that made the defect the
model's *only* endorsed move: make the blocked-on-user state expressible, and
stop forbidding it. That is one change and it is testable. It introduces no
adapter-side regression for the 22 — the non-regression test guards their
structural output byte for byte — but it is a prompt change, so it can still
shift what the model chooses to emit. Adapter behavior is pinned; model
behavior is influenced, not fixed.

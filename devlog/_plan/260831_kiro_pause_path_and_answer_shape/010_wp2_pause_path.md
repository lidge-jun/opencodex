# wp2 — make the blocked-on-user state expressible

One change, in the injected contract, carried on every surface that describes
when to complete. It removes the contradiction that made continuing to work the
model's only endorsed move. No adapter enforcement is added, because no
non-heuristic signal exists to enforce on.

## A blocking question is a valid final answer

The pause state rides the channel that already terminates correctly. A
completion answer yields `final_answer` and `done(endTurn: true)`
**regardless of what the answer says** — verified in `kiro.ts` at the
completion terminal. So a question delivered there ends the turn today, with no
new event type, no new phase, and no change to `endTurn` semantics for real
tools.

`KIRO_COMPLETION_INSTRUCTIONS` therefore gains one clause: when the model needs
a decision from the user before it can continue, that question IS its final
answer — deliver it through the completion tool and stop, instead of writing the
question as prose and then answering itself.

The completion tool's own schema carries the same clause. That description is the
surface the model reads while CHOOSING a tool, and it admitted only "fully
complete"; a model holding a blocking question reads the tool as unavailable and
keeps working, which is the defect. Round one changed only the terminality half of
this description and left the eligibility half narrow, which is part of why prose
alone did not move the outcome. The `answer` property description is widened the
same way, since it is what tells the model what may go in the field.

This is deliberately NOT conditioned on an ask tool being present. An earlier
draft keyed it on `request_user_input` appearing in the emitted catalog, which
would have named a tool that is absent from most turns and contradicted the
nudge's rule that instruction-only names are not callable (the failure mode
`0325a5afd` fixed for the catalog nudge). The completion tool is always present
when this instruction is emitted — that is the condition under which the
instruction exists at all — so the clause can never name something uncallable.

`KIRO_COMPLETION_RETRY_MESSAGE` currently ends with *"Do not ask the user for
another task or emit another progress-only message."* In context that forbids
soliciting NEW work, but it reads as a blanket ban on asking, and it is the one
instruction the model sees at exactly the moment it failed to complete. It is
narrowed to keep forbidding a request for another task while making a blocking
question an explicitly acceptable final answer.

Both sites are compared by constant, never by inline literal
(`currentUim.content !== KIRO_COMPLETION_RETRY_MESSAGE`), and both pinning
tests assert against the constant, so editing the text cannot desynchronize the
equality checks that keep the bounded retry from stacking.

This depends on model compliance and is labeled as such. It is the reason this
unit does not promise impossibility: the tests prove the contract is delivered,
not that the model obeys it.

## Ask-tool isolation: considered and dropped

An earlier draft added a `flushOpen` invariant: once a turn emitted the ask
tool, a later real tool call from the same inference would fail closed. It is not
being implemented, for three independent reasons.

It is unreachable. Measured across 644 Kiro rollouts: 8 `request_user_input`
calls, and the ask-then-another-real-tool shape occurs **0** times.

It cannot be keyed safely. `nameMap` aliases every REQUESTED tool before
admission, and admission can omit tools, so `nameMap` membership does not prove
a tool was emitted. Doing it correctly means threading an explicit emitted-ask
identity through `buildRequest`, the fallback state, and `parseKiroStream`.

It can false-positive. `OcxTool` carries no "asks the user" marker, and the
parser reduces ordinary function tools to the same generic shape, so an unrelated
bare function named `request_user_input` is indistinguishable from Codex's ask
tool. Claiming it "cannot affect any ordinary tool" was an overclaim.

Three costs and a measured zero benefit. The previous unit already shipped and
then reverted a guard for an unreachable path; this one declines it before the
commit instead of after.

## What is NOT changed, and why

No prose-shape gate. No length threshold. No discard of staged commentary. The
measurement in `000_research.md` shows the 4 defect cases (1329-1938 chars) and
the 22 legitimate ones (608-3141) overlap completely, so every such rule is a
coin flip on whether the user sees their agent's work.

No change to `src/router.ts`, `src/server/lifecycle.ts`, or
`src/server/responses/core.ts`: the Lab core boundary is unrelated and
`tests/core-lab-boundary.test.ts` guards it. No change to the shared
`tool-catalog-nudge` sentence or its pinned test.

## Tests

**Red-first, contract shape:** every emitted completion contract carries the
pause clause, and the retry message permits a blocking question as a final
answer. Driven red against the current strings before the edit.

**Non-regression, the 22:** staged progress prose followed by `exec` still
yields the prose as `commentary` and `done(endTurn: false)` with the tool call
relayed, byte-identical to today, parameterized across the measured lengths
608 / 1329 / 1454 / 1938 / 3141. This is the test that protects the user's
"회귀없도록" requirement, and it must pass unchanged both before and after the
diff.

## Budget truncation: measured unreachable, pinned by test

The completion contract is charged last against
`MAX_KIRO_INJECTED_INSTRUCTION_CHARS` (16384), so in principle a large enough
injected context could slice the pause clause mid-sentence. Measured against a
hostile catalog (80 requested tools, 64-character names, 6000-character
descriptions):

| Charged item | Chars |
| --- | --- |
| Omission notice | 922 |
| Catalog nudge | 2432 |
| Total before the contract | 3354 |
| Headroom | 13030 |
| Contract | 696 |

Both charged inputs are structurally capped — the notice names at most 12 tools,
the nudge is bounded by the 48-tool and 64-character limits — and the caller's
system prompt is not charged to this budget at all. So no reachable input
approaches the slice boundary.

A reservation guard is therefore dead code, and the previous unit already proved
its test would be vacuous: it passed with the guard removed. Instead this unit
pins the property that makes truncation unreachable, at BOTH hostile extremes,
asserting the contract arrives COMPLETE including its closing pause clause:

- **Largest nudge:** `MAX_KIRO_TOOL_COUNT` admitted tools with unique 64-character
  names and one-character descriptions. Every admitted tool is named in the nudge,
  so this maximizes the charged nudge. Nothing is omitted, which the test asserts
  so it cannot pass while silently charging less than it claims.
- **Notice plus nudge:** oversized descriptions on twice the tool limit, which
  forces admission to omit and charges the omission notice on top of the nudge.
  The test asserts the notice is actually present for the same reason.

The 6000-character-description shape alone would not have been enough: it reduces
the admitted count and therefore shrinks the nudge, so it never probes the
largest charged input. Both tests fail if a future change lets the notice or the
nudge grow without bound. A reservation's test could not detect its own removal.

## Verification

`bun run typecheck`, the focused Kiro suites, and `bun run privacy:scan`. The
full local suite is excluded by explicit user instruction; CI covers it.

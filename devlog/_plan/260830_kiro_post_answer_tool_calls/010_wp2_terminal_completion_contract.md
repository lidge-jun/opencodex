# wp2 — make the completion tool's terminal semantics explicit

## Change

Two injected surfaces describe the private completion tool. Both need the same
fact, and the schema description is the one that travels with the tool the
nudge enumerates.

`src/adapters/kiro.ts`, `kiroCompletionTool()` description: mark the tool as a
terminal channel rather than an ordinary work tool, make completing an
obligation rather than a permitted option, and state that the call ends the
turn, returns no tool result, and admits nothing after it. This sits directly on
the tool object the model is choosing between, so it is read in the same place
the model decides whether to call `exec` again.

Exact target string:

> Terminal completion channel, not an ordinary work tool. When the task is fully
> complete and no more work or tool calls are needed, you must call this tool
> exactly once instead of providing the final answer as ordinary assistant text.
> Put the complete user-facing final answer in \`answer\`. The call is complete
> when issued: it ends the turn, returns no tool result, and no text or tool call
> may follow it.

`src/adapters/kiro-constants.ts`, `KIRO_COMPLETION_INSTRUCTIONS`: keep the
existing commentary-vs-completion rules verbatim and append the terminal clause,
so the prose contract cannot contradict the schema.

Exact appended string:

> This completion tool is not an ordinary work tool. When the task is complete,
> call it instead of emitting answer-shaped ordinary assistant text. The call is
> terminal and is the exception to generic tool-result counting: it is complete
> when issued, ends the turn, returns no tool result, and no text or tool call
> may follow it.

## What must not change

The commentary rule stays. "Ordinary assistant text is mid-task commentary and
does not end the turn" and "continue using tools after progress updates" are
the behavior that keeps a mid-task turn alive; the new wording constrains only
what happens after the completion call itself. A model must still be free to
call ten more tools before it completes — the fix is that after completing, it
must stop.

The tool stays in the wire catalog and in the nudge enumeration. The nudge
states that instruction-only names are not callable, so delisting the
completion tool would advertise a tool the model is told to refuse.

No change to `src/router.ts`, `src/server/lifecycle.ts`, or
`src/server/responses/core.ts`: the Lab core boundary is unrelated to this
defect and `tests/core-lab-boundary.test.ts` guards it.

## Regression test

`tests/kiro-adapter.test.ts` gets a focused case asserting the rendered wire
payload carries terminal semantics on BOTH injected surfaces: the completion
tool's schema description and the injected prose contract. Driven red before
the fix.

What this test proves and does not prove: it proves the contract reaches the
model on both surfaces, which is the deliverable. It does not prove the model's
selection rate improves — that is a live behavioral property measured from
attempt diagnostics (`completionCalls` per required-mode attempt), recorded in
`000_research.md` at 25/4069 before the change. The change is prompt hardening
against a measured selection failure, not a parser fix.

## Verification

`bun run typecheck` plus the focused Kiro suites. The full local suite is
excluded by explicit user instruction for this unit; CI covers it on the PR.

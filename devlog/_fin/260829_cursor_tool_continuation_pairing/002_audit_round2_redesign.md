# 002 — Audit round 2: the remote suite rejected the approach, and it was right

Trigger: the full `bun run test` suite on `ssh lidge` at commit `2aaf7c7ad` failed with exactly one
test, twice (the suite runs it in two groups):

```
(fail) 363-B: tool result reaches the model via rootPromptMessagesJson >
       assistant tool CALL is NOT replayed as [Tool Call] text (model-prompt leak guard)
```

## What that guard says

`tests/cursor-tool-continuation.test.ts:87-103`:

```ts
    // Regression: a prior assistant tool call MUST NOT leak into the model-visible prompt as literal
    // "[Tool Call]" text. The model few-shot-mimics that marker and emits later parallel/mixed tool
    // calls as inert text instead of real tool frames (halting multi-tool continuations).
    expect(serialized).not.toContain("[Tool Call]");
    // composer-2.5 still needs the paired tool RESULT echo in the model-visible prompt.
    expect(serialized).toContain("FILE CONTENTS HERE");
```

This is a **prior fix for the opposite failure mode of the same defect class**, and the mechanism
is the same one my patch relied on: models imitate replayed envelope shapes. My change would have
traded "the model re-runs a tool" for "the model stops emitting real tool frames" — arguably worse,
since a turn that emits inert text never calls a tool at all.

`src/adapters/cursor/request-builder.ts:223-235` records the same rejection independently, which
`001` F8 noticed but mis-dispositioned: I read it as a risk to *cover with a sniffer* when it was
in fact a constraint to *obey*. Adding `[Tool Call]` to `ECHO_MARKERS` would only have retried the
turn after the damage, not prevented the mimicry.

## Why the RCA still stands

The defect in `000_rca.md` is real and reproduced: a replayed result carries a `call_id` for an
invocation the model cannot see, and it re-runs the command while narrating a phantom interrupt.
What `010` got wrong was the *remedy*, not the diagnosis. Two requirements must hold at once:

1. The model must be able to see WHICH invocation produced a replayed result (fixes 260829).
2. There must be no standalone call-shaped template for it to copy (preserves 363-B).

## Redesign

Name the invocation as one descriptive line INSIDE the result envelope, instead of emitting a
separate entry:

```
[Tool Result]
[tool_result]
call_id: call_echo_1
name: exec_command
invoked: exec_command with {"cmd":"echo AAA"}
is_error: false
output:
AAA
```

- Requirement 1 holds: the result is self-describing, so no `call_id` dangles.
- Requirement 2 holds: `invoked: …` is prose inside a result the model already never emits itself.
  There is no `[Tool Call]` block anywhere in the payload — asserted for all three model classes.

Implementation (`src/adapters/cursor/protobuf-request.ts`):

| Element | Role |
|---------|------|
| `toolInvocationLine(call)` | renders the single `invoked: <name> with <args>` line |
| `toolCallArgumentsText(args)` | `JSON.stringify` in a `try`, `[unserializable arguments]` on throw |
| `toolCallsByCallId(messages)` | indexes assistant calls by decoded call id, once per request |
| `toolResultToText(message, call?)` | inserts the line when a call matched; unchanged output when none did |

Both replay surfaces consume it: `rootPromptMessages` (gated on `echoToolResultInRoot`, so
`composer-2.5` is covered per `001` F2) and the `conversationTurns` external branch. `envelope-echo.ts`
is reverted to its original three markers — no new marker exists to sniff.

An unmatched `call_id` produces no invocation line rather than a fabricated one; inventing an
invocation the transcript cannot support would be a different lie than the one being fixed.

## Verification after redesign

| Check | Result |
|-------|--------|
| `bun x tsc --noEmit` (local) | exit 0 |
| `tests/cursor-tool-result-invocation.test.ts` (7 new) | 7 pass |
| `tests/cursor-tool-continuation.test.ts` (incl. 363-B) | pass |
| 6 Cursor suites (blob, repetition-breaker, envelope-echo-retry, request-builder, tool-continuation, new) | 184 pass / 0 fail |
| `tests/cursor-blob.test.ts` | reverted to untouched — the redesign needs no edit to an existing expectation |

That last row matters: the first approach required weakening an existing test's step count. The
redesign changes no existing assertion, which is the honest signal that it fits the invariants
already encoded in the suite rather than renegotiating them.

## Process note (LOOP-PESSIMIST-01)

The dispatched plan auditor produced nothing and was retired (`001`). My direct audit confirmed the
root cause but missed this blocker, because it searched for tool-result replay sites and helper
signatures rather than asking whether the repository had already REJECTED the remedy. The remote
full-suite run caught it. Concretely: a grep for the literal string being introduced
(`rg '\[Tool Call\]' tests/`) would have found the guard in one step, before any code was written.
Recorded as the cheap check to run whenever a change introduces a model-visible marker.

VERDICT (round 2): PASS — approach replaced, both invariants satisfied, no existing expectation weakened.


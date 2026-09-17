# U4 — CodeBuddy scaffold guard misses bare tool names (#4852)

## What is wrong

`scaffold-guard.ts` refuses a CodeBuddy turn only when a DSML calls line is
followed by an invoke line whose target starts with `functions.`:

    DSML_INVOKE_PREFIX = <｜｜dsml｜｜ invoke name="functions.

The reporter drove the shipped 2.57.0 filter directly, one block per tool name.
`functions.exec`, `functions.Bash` and `functions.apply_patch` are refused;
`Bash`, `exec`, `shell` and `apply_patch` all leak. The routed model writes the bare
name, so every marker misses and the whole scaffold block is forwarded as
assistant text. #4596 still reproduces on the released build for that reason and
no other: the calls line matches, the delta-boundary handling works, and the
namespace prefix on the invoke target is the only gap.

## The fix, and the size it must stay

Drop `functions.` from the invoke prefix and require a name character after the
opening quote. Nothing else moves.

The narrowness that matters is the **two-line grammar**, not the namespace. A
calls line alone is harmless prose; a calls line immediately followed by an
invoke line is the scaffold. That distinction is what keeps a page discussing the
tags from being refused, and it is untouched here. Column-zero-only matching,
fenced-Markdown suppression, and the bounded held suffix all stay as they are.

Keep the partial-prefix logic consistent with the shorter constant: the
end-of-chunk hold in `prefixAtEnd` and the `DSML_INVOKE_PREFIX.startsWith(invokeRest)`
branch both hold less now, which is correct, but both have to be re-read against
the new length rather than assumed.

## Scope limit

This is a refusal guard. Do not widen it into a general "execute this text as a
tool call" feature — that is a different design with a different threat model,
and the delegation rules it out explicitly. The guard's job is to refuse, and
`CODEBUDDY_SCAFFOLD_ERROR_CODE` stays the only outcome.

## Files

`src/adapters/codebuddy/scaffold-guard.ts` and its existing test file. Independent
branch off `dev`; `Closes #4852`.

## Regressions to add

Bare `Bash`, `exec`, `shell` and `apply_patch` invoke lines are refused; the
`functions.`-prefixed cases from #4596 stay refused, including the one split across
deltas; a bare-name block split at the invoke prefix is refused; prose and fenced
examples quoting the tags are still forwarded unchanged; a calls line with no
invoke line still does not refuse.

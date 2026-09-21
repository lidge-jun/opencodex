# U3 — Incomplete-tool remint: isolation boundary and budget (#4875, closes #4874)

MerryEcho's PR. This unit extends it in place and keeps the `Co-authored-by:`
trailer so the attribution survives the squash.

## What the branch does today

`finalizeTurnEvents` streams "Cursor stream ended with incomplete tool call(s)"
rather than throwing, so the overflow and invalid-argument ladders never see it.
The PR flags that streamed error, and after the send loop exits it invalidates the
inherited checkpoint and remints the conversation for any turn where
`_parsed._cursorIsolateConversation !== true`. The current send is not retried.

## Gap 1 — the isolation boundary is one condition short

Every other remint and checkpoint-scrub site in `cursor.ts` tests two things, not
one: the isolation flag **and** `contextUsageStoreCheckpoints !== false`. The
overflow ladder does it, the provider-state branch at the `done` event does it, and
the post-loop continuation scrub does it. The new site tests only the flag.

`request-builder.ts` sets `contextUsageStoreCheckpoints: false` for
`_compactionRequest`, and `remintConversationId` writes the new id under the stable
thread owner for any turn it considers non-isolated. So a compaction turn that
ends with an incomplete tool stream replaces the parent thread's conversation
override with the compaction conversation, and the next ordinary turn in that
thread resumes it. That is the isolation break CodeRabbit raised on line 523 and
the one the delegation asks to settle before integration.

`request-prepare.ts` does set `_cursorIsolateConversation = true` whenever
`_compactionRequest` is true, so the main server path happens to be covered today.
That is an upstream invariant an adapter-level caller can violate, and the rest of
the file does not rely on it. Add the second condition, which also stops the
`invalidateCursorCheckpoint` call in the same branch from reaching into the
parent's checkpoint.

## Gap 2 — the remint budget

Overflow remint is bounded at `CURSOR_OVERFLOW_REMINT_MAX = 3` per scope key.
Incomplete-tool remint is unbounded.

Sharing the overflow counter is the wrong answer even though it is the smaller
diff. The two events cost different things. An overflow remint **re-sends the
whole turn**, so an unbounded loop amplifies spend, and that is what the counter
exists to stop. An incomplete-tool remint sends nothing; it rotates an id for the
next turn. Letting truncations drain the overflow budget would disarm the
protection that actually guards spend, and letting overflow drain the truncation
budget is equally arbitrary.

Give it its own counter in `thread-continuity.ts`, same scope key, same shape,
`CURSOR_INCOMPLETE_TOOL_REMINT_MAX = 3`, with the same entry bound. Unbounded
rotation is still not acceptable: a model that chronically truncates would get a
fresh Cursor conversation every turn, discarding upstream context and checkpoint
reuse while the user sees only slower, more forgetful answers. After the budget is
spent, stop reminting and record a diagnostic. The streamed error still reaches
the client, which is the honest outcome — if three fresh conversations did not
help, conversation reuse was not the problem.

Clear the scope's counter on a turn that completes without an incomplete-tool
error, so a long-lived thread does not spend its budget over days of unrelated
truncations.

## Gap 3 — the classifier can drift from its producer

`isCursorIncompleteToolCallMessage` matches two lowercased substrings against a
message that `finalizeTurnEvents` composes in another module. Nothing binds them.
Export the message prefix as one constant and have the producer and the classifier
share it, so a reworded error cannot silently disable the recovery.

## Files

`src/adapters/cursor.ts`, `src/adapters/cursor/cursor-errors.ts`,
`src/adapters/cursor/thread-continuity.ts`, `src/adapters/cursor/protobuf-events.ts`,
`src/adapters/cursor/protobuf-request.ts`, `tests/providers/cursor/cursor-adapter.test.ts`,
`tests/providers/cursor/cursor-errors.test.ts`, `tests/providers/cursor/cursor-blob.test.ts`,
`structure/providers/cursor.md`.

## Regressions to add

A compaction turn (`contextUsageStoreCheckpoints === false`) that hits an
incomplete-tool error does not remint and does not touch the stable thread
override; an isolated helper turn keeps its existing non-remint behaviour; the
fourth truncation in one scope does not remint and records the exhaustion; a clean
turn clears the counter; the overflow budget is unaffected by truncations and vice
versa; the classifier matches the message the producer actually builds.

## Held for the host

The branch is based on `e18ca2463` and `dev` has moved. Rebasing is the host's
call, not this lane's. The PR is a fork draft with a 0/4 readiness checklist, and
any push resets it.

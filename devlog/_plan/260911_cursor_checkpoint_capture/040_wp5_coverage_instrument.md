# wp5 — making the coverage question answerable

Branch A landed, so the native wire-model gate now depends on one question: do the captured
bytes actually cover the tool call, or did they merely arrive after it?

## Why this could not be settled by reading harder

`capturedAfterClientTool` is set from arrival order (`cursor.ts:312`), and
`conversationCheckpointUpdate` is classified liveness-only (`live-transport.ts:1221`). Every
diagnostic this adapter emits about a checkpoint reports its size in bytes, and a byte count
cannot distinguish a snapshot that contains the suspended call from one that does not.

The schema can. `ConversationStateStructure.pendingToolCalls` is documented upstream as
"raw JSON stringified tool-call content parts awaiting execution" — a non-zero count on a
suspended turn is the coverage evidence, and the strings themselves are request content that
must never be logged.

## What landed

`cursorCheckpointShape` in `checkpoint-store.ts`: decodes a snapshot and returns **counts
only** for `turns`, `turnsOld`, `rootPromptMessages`, `todos`, `pendingToolCalls`. Failure
returns `undefined`; it never throws into the request path. Wired into
`checkpoint-commit-refused` as `capturedShape`, behind `isDebugEnabled()` so the decode does
not run on a normal request.

That converts the remaining question from "build an instrumented binary and decode bytes by
hand" into "read one log line".

## What is NOT answered yet, and why

The live read needs this code running on a machine with a Cursor login. Attempts to shortcut
it with a standalone harness failed: driving the adapter outside the server never reaches the
credential initialisation the proxy does at startup (`getAccountSet` reports not-logged-in
even after `loadAuthStore`, which points at the keyring path rather than `auth.json`).

Running a second proxy would have worked, but only by either copying the credential store or
sharing the running instance's `OPENCODEX_HOME` and clobbering its pid and admin-token files.
Neither is worth it for a question that answers itself one release later.

**So wp5 is split.** The instrument is done. The live read is a follow-up: after this ships,
run a forced tool call on a Cursor account with `ocx debug provider on` and read
`capturedShape.pendingToolCalls` off `checkpoint-commit-refused`.

- `pendingToolCalls > 0` → the snapshot covers the call; the native gate can be removed with
  the ordering proof upgraded to a coverage proof.
- `pendingToolCalls === 0` → arrival is not coverage, the current gate is correct, and the
  native half of #4245 is not fixable this way. Record it and close.

Either answer is a real outcome. What was not acceptable was guessing, which is what the
original triage did and what this unit has now avoided four separate times.

# 020 — Subagents page roster autosave

## Problem

On the Subagents dashboard page, adding, removing, or reordering a featured model
only changes local state; nothing persists until the user clicks Save.

## Diff

`gui/src/pages/Subagents.tsx`

- Replace `save()` with `persistRoster(next)`: `toggle` and `move` compute the next
  list from the current `chosen`, set it optimistically, and persist it.
- Serialize writes: while a PUT is in flight, keep only the newest requested list in
  a ref and send it when the current request settles, so rapid edits end at the
  last list the user made.
- `committed` always advances to the last successful write, including a write
  that a queued list has already superseded, because the server holds it.
  Only the newest write's `applied` list is copied into `chosen`.
- A failed write with a queued successor skips the restore and still sends the
  successor. A failed final write restores `committed.chosen` and shows the error.
- `saveInFlight` stays true across the whole drain, so a roster refresh cannot
  slip into the gap between one response and the next send.
- Controls stay enabled during a write (no `busy` lockout per click).

`gui/src/components/subagents-workspace/SubagentsWorkspace.tsx`

- Remove the Save button row and the `onSave`/`busy` props it needed.
- Update the header comment ("reorder + save" → autosaved).

Fallback list and delegation sections keep their existing controls.

GUI tests: `gui/tests/subagents-classic.test.tsx` (PUT now follows a toggle, no
Save click), `gui/tests/subagents-busy-race.test.tsx` (rewrite around
latest-write-wins serialization and failure restore), and
`gui/tests/subagents-fallback.test.tsx` (`.swi-save-row` queries and
"no roster PUT" assertions).

## Verification

`cd gui && bun test --isolate tests`, `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, a browser
check against a source proxy on a scratch port and `OPENCODEX_HOME` that
toggles a model and confirms the PUT and the persisted config, plus a screenshot
for the PR description.

# wp4 — Rollback surface redesign

Diagnosis in 003. Independent of wp2/wp3; branches off `dev` directly.

## New component

`gui/src/pages/integrations/RollbackHistory.tsx`. Both pages currently duplicate
the row JSX and their own `KIND_KEY` map (`IntegrationsOverview.tsx:53`,
`FileIntegrationPage.tsx:47`); one `KIND_KEY` moves here.

Exports:

- `RollbackRow` — one journal row: kind, optional client, timestamp, and either
  the Undo/Restore-point button or the expired badge. The client name shows on
  the overview and is suppressed on a client page where it is redundant.
- `LatestChange` — the single newest row, unframed, for the overview.
- `RollbackHistory` — newest row visible plus a collapsed `<details>` holding
  older rows, six at a time.

`PAGE = 6` matches `LANE_PAGE` in `claude-desktop-lane.ts`, the existing
precedent for bounded reveal in this GUI.

No total count is rendered. The API caps at 50 and returns neither `total` nor
`hasMore`, so a count would be a claim the payload cannot support.

## IntegrationsOverview.tsx

Render `<LatestChange>` directly below the summary strip, so Undo sits above the
fold and the summary's "last change" value gains the row it refers to.

The older global rows move into a collapsed `<details>` where the flat list used
to be (currently lines 554-584). They are NOT deleted.

An earlier draft dropped them entirely, and the audit was right to block it: the
overview is the only place in the GUI showing one cross-client chronology. Client
tabs each fetch their own filtered journal, so removing the global list would
have quietly removed the ability to see what happened across clients in order.
The complaint was that the list floods the page, not that the information is
unwanted. Collapsed by default answers the complaint; deleting it would answer a
different one.

## FileIntegrationPage.tsx

Replace the flat list with `<RollbackHistory>` near the status and path. Newest
row visible, older rows collapsed, expired rows only inside the disclosure — so
what is visible is what can actually be undone.

## State branching

Both pages currently do `data ?? []` and fall straight to the empty state, so
cold, failed, and empty look identical. Branch on `historyResource.state.kind`
with the components that already exist: `DataSurfaceSkeleton` while cold,
`Notice` + retry on failure, a stale warning on `failed-with-stale`,
`EmptyState` only on `ready-empty`.

## RestoreDialog.tsx

Adopt `ConsequenceDialog`'s lifecycle: `ref`, `showModal()`, cleanup `close()`,
backdrop dismiss, `role="document"`, focus restoration. Today it renders
`<dialog open>` with inline full-screen styles, so background controls stay
reachable and focus is never trapped — on a dialog that confirms overwriting a
config file.

## styles-integrations.css

- One list boundary with `border-top` separators, replacing the border per row
  at line 62. This is what removes the "다닥다닥" texture.
- Classes for the latest-change row, the disclosure summary, and show-more.
- Fix `.integration-client-head h4` to `h3` (line 48) — the JSX renders `h3`.
- `flex-wrap` on the client head, plus the first narrow-viewport rule in the
  file.
- Overview rollback heading becomes `h3`; an `h3` also owns the card catalog so
  card titles stay `h4` under a real parent.

## Tests

`gui/tests/integrations-rollback-history.test.ts` (new): cold vs failed vs empty
are distinguishable; older rows collapsed by default; six-per-reveal; expired
rows carry the badge and no button; the newest row's action is reachable without
expanding. Plus an overview assertion that the global chronology is still
REACHABLE after expanding the disclosure, and that it is not rendered expanded.

`gui/tests/integrations-surfaces.test.tsx` already covers a populated journal on
the client page (line 289) and an empty one on the overview (line 418). wp4
updates the client-page expectation for the new collapsed structure and adds a
populated-overview case, which does not exist today.

## Verification

Focused GUI tests, `bun run typecheck`, `bun run lint:gui`, and screenshots at
desktop and mobile widths showing the page with a populated journal.

## Deliberately not here

An HTTP `limit` parameter, and journal-row retention. Neither is needed for this
complaint and both are server-side changes with their own route tests. Recorded
as follow-ups.

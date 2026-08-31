# Why the Integrations page reads as noise

Read against the current tree, 2026-08-31.

## What the user is seeing

"로그 밑에 막 다닥다닥 뜨는 히스토리" — the rollback journal. The real numbers:

- The route `/api/client-integrations/journal` accepts only `client`. There is
  no HTTP `limit` parameter; `?limit=` is ignored
  (`src/server/management/integration-routes.ts:313`).
- It calls `store.listOperations()` with no limit, so `listOperations`' own
  default applies: **50 rows**, newest first (`src/integrations/journal.ts:138`).
- Both consumers render the ENTIRE response with no slice —
  `IntegrationsOverview.tsx:561` and `FileIntegrationPage.tsx:196`.
- Every row carries its own `1px` border and `border-radius`
  (`styles-integrations.css:62`). Fifty bordered strips stacked at 6px gaps is
  precisely the "다닥다닥" texture.

So the flooding is real, and it is worse than one list: the overview shows the
global journal and every file client tab shows the same journal filtered. The
same operation is rendered twice in two places.

Two related facts worth recording. Snapshot retention is 10 per client
(`journal.ts:54`), so of 50 visible rows at most 10 are restorable and the rest
render an "expired" badge — the list is mostly inert. And journal ROWS are never
pruned, so `journal.jsonl` is parsed in full on every request before the slice.

## Defects, worst first

1. **History floods and duplicates.** Above.
2. **Loading, failure, and empty are indistinguishable.** Both components do
   `data ?? []` and then render the empty state, so a cold fetch, a failed
   fetch, and a genuinely empty journal look identical. No retry, no stale
   warning — even though `useDataSurface` exposes `state.kind` for exactly this.
3. **Undo is buried.** On the overview it sits below the summary, the API-key
   row, onboarding copy, up to 15 cards, and an empty panel. The most valuable
   recovery action on the page is viewports away from the switch that caused it.
4. **RestoreDialog is not modal.** It renders `<dialog open>` with inline
   full-screen styles instead of `showModal()`, so background controls stay
   reachable and focus is neither trapped nor restored.
   `ConsequenceDialog.tsx:34` in the same directory does it correctly.
5. **Summary claims exceed its data.** "Last change" reads only the file-client
   journal, so a Codex/Claude/Desktop/Grok change is invisible. Counts paint
   zero while sources are still unsettled. The "no clients detected" panel tests
   only FILE clients but its copy does not say so.
6. **Heading levels skip.** Overview goes `h2` straight to `h4` with no `h3`.
   CSS targets `.integration-client-head h4` while the JSX renders `h3`.
7. **Card saturation.** No literal card-in-card, but a raised summary, a raised
   API row, 15 bordered cards, a bordered empty panel, and 50 bordered history
   rows give every level the same visual weight.
8. **No responsive block at all** in `styles-integrations.css`.

## Patterns already in this repo

Nothing here needs a new design system.

- **Bounded pagination:** Claude Desktop reveals six rows at a time behind a
  `btn btn-ghost btn-sm` show-more (`claude-desktop-lane.ts:11`,
  `ClaudeDesktop.tsx:671`). `LANE_PAGE = 6` is the local precedent.
- **Disclosure:** `Logs.tsx:1112` uses native `<details>/<summary>` for
  secondary detail. There is no generic Accordion component, and adding one is
  out of scope.
- **State branching:** `DataSurfaceSkeleton`, `DataSurfaceStatus`,
  `EmptyState`, `Notice` already exist.
- Virtualization (`Logs.tsx:518`) is overkill for at most 50 rows.

## The redesign (wp4)

**Overview.** Drop the journal block entirely. In its place, one unframed
"latest change" line directly below the summary: client, operation, time, and
its Undo or Restore-point action. Recovery moves above the fold and the
summary's "last change" scope becomes visible instead of implied.

**Client tab.** Newest row stays visible next to the status and path. Older rows
move into a collapsed-by-default `<details>`, revealed six at a time. Expired
rows live only inside that disclosure, so the visible surface is the part that
can actually be undone.

No total count is displayed: the API caps at 50 and returns neither `total` nor
`hasMore`, so any number shown would be a claim we cannot support.

**Shared component.** The row JSX is currently duplicated in both files with
their own `KIND_KEY` maps. wp4 extracts one integrations-domain component.

**Styling.** One list boundary with `border-top` separators instead of a border
per row. Fix `.integration-client-head h4` to `h3`, add `flex-wrap`, add a
narrow-viewport rule.

**Also in wp4.** `RestoreDialog` adopts `ConsequenceDialog`'s modal lifecycle,
and the history resources branch on `state.kind` so cold, failed, and empty
stop looking alike.

An HTTP `limit` parameter is deliberately NOT in wp4. It would shrink the
payload without fixing the full-file parse or the unbounded on-disk journal, and
the UI cap makes it unnecessary for this complaint. Recorded as a follow-up.

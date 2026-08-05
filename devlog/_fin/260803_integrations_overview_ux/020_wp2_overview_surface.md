# WP2 — the overview renders what WP1 models, and the cards move

## IN

1. `gui/src/pages/integrations/IntegrationsOverview.tsx` — read five more
   sources, render `buildOverviewRows`, make cards navigate.
2. `gui/src/styles-integrations.css` — the card-link overlay and the unknown
   badge's placement. No new color.
3. `gui/tests/integrations-overview-rows.test.ts` is WP1's; mounted behavior
   goes in `gui/tests/integrations-surfaces.test.tsx` beside its neighbors.

OUT: the file-client sub-pages, the tab strip, the server.

## Making a card clickable without breaking the switch

The card already holds two controls. Wrapping the whole thing in a button or an
anchor nests interactive elements, which is invalid HTML and collapses keyboard
semantics: the switch becomes unreachable or the card fires when the user meant
to toggle.

Use the stretched-link pattern instead. The card title becomes a real
`<button>`, and a pseudo-element on that button covers the whole card:

```css
.integration-card { position: relative; }
.integration-card-link::after { content: ""; position: absolute; inset: 0; }
.integration-card-actions, .integration-card-head .badge { position: relative; z-index: 1; }
```

What this buys, and why it beats a card-level `onClick`:

- One tab stop for navigation, on the element whose accessible name is the
  client's name. A card-level handler would need `tabIndex={0}` plus manual
  Enter/Space handling, and would announce as a generic clickable div.
- The switch and the settings button sit above the overlay in the stacking
  order, so they receive their own clicks. No `stopPropagation`, no guessing
  from `event.target` which control the user meant.
- Text selection inside the card still works everywhere the overlay is not
  needed.

The ghost "설정" button stays. It is the same destination as the card, which
is redundant for a mouse — but it is the affordance that says the card leads
somewhere, and removing it on the day the card becomes clickable would leave
the destination invisible until hover.

## Fetching five more sources

Five `useDataSurface` calls beside the two that exist, each with
`enabled: active` and **no** `pollMs` (`011` §1: `/api/claude-code` is 36 KB and
`/api/keys` took 466 ms — acceptable once on a visible tab, not on a timer).
`refresh()` fans out to all seven.

`clientsSettled` comes from the states resource's own kind: anything other than
`cold`/`retrying-cold` means the list has answered at least once. That is what
separates "the six file clients are still loading" from "the server did not
return this client".

## Summary strip

The four cells keep their labels. `감지됨` and `적용 중` now count every row,
which is the entire point. `업데이트 필요` counts every `stale` row, so a
drifted Desktop profile is finally visible from the overview.

A fifth cell appears **only** when at least one source is unknown, reading
`확인 중 {n}`. A permanent cell that reads 0 in the healthy case is noise; a
cell that appears when something could not be read is a signal. It is the
honest counterpart to the counts above it — without it, six applied out of
eleven and six applied out of nine look identical.

`모두 해제` still only disables file clients. Its `disabled` condition already
derives from the file-client list, and it must keep doing so: the button's
confirmation text promises to remove opencodex-owned blocks from config files,
which is not what disabling Claude Code or unrouting Codex would mean.

## The empty state must not fire on eleven rows

Today's empty branch asks whether any of the six file clients is installed. With
Codex and API keys always installed, that branch is now unreachable in practice
— and it should be, since the page always has something to show. Narrow the
condition to what it actually meant: show the "no clients detected" panel only
when no *file* client is installed, and show it below the grid rather than
instead of it. Otherwise a user with no file clients loses the five rows that
are working.

## Acceptance

- [ ] With all five sources answering, the grid renders 11 cards and the
      summary counts them.
- [ ] Clicking a card's body navigates to that client's hash; clicking its
      switch toggles without navigating.
- [ ] Enter on a focused card title navigates.
- [ ] Claude Desktop's card navigates to `integrations/claude/desktop`.
- [ ] A failed source renders a muted "확인 중" badge and no switch.
- [ ] The unknown cell is absent when every source settled.
- [ ] Existing `integrations-surfaces` tests stay green, including the toggle
      and bulk-disable paths.

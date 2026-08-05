# WP2 audit

Verdict: **PASS with one amendment.**

## 1. Stretched link vs. the switch — checked against the real control

`Switch` in `gui/src/ui.tsx` renders a plain `<button type="button">`, and
`.switch` in `styles.css` has no `position` of its own. So the z-index lift the
plan assigns to `.integration-card-actions` needs `position: relative` on that
container — which it does not have today either. Both must be set, or the
overlay swallows the switch and the toggle silently stops working.

That failure mode is invisible in a screenshot and only shows up when someone
clicks. The existing mounted test "a card toggles its own client without a trip
to the sub-page" drives the real switch through a real click, so it catches
exactly this. Keep it green rather than adding a redundant test.

## 2. The badge is inside the head, above the overlay

The plan lifts `.integration-card-head .badge` above the overlay. Reconsidered:
a badge is not interactive, and lifting it means a click on the badge does not
navigate — a dead zone in the middle of a clickable card. Do **not** lift it.
Only the two real controls get `z-index`.

## 3. Amendment: the title button must not be a nested control either

`.integration-card-head` holds an `<h4>` and the badge. The plan turns the title
into a button, which means a `<button>` inside an `<h4>`. That is valid — a
heading may contain phrasing content — and it keeps the accessible heading
structure the page already has. Confirmed as written, with one requirement the
plan left implicit: the button gets `text-align: left` and inherits the heading
font, or it renders as a centered small-font control and the card head visibly
changes for the five rows that are not new.

## 4. Orphaned CSS found

`styles.css` still carries `.nav-entry-claude` rules — including
`.nav-entry-claude .switch` — left behind when `a56a4aea6` removed the sidebar
Claude row. WP3 reuses the entry rules and must delete the `.switch` ones: the
restored entry is navigation only, and leaving a switch style behind invites
the next person to put the mutation back.

Noted here, executed in WP3.

## Amended acceptance

Carried from `020`, plus:

- [ ] `.integration-card-actions` sets `position: relative` as well as
      `z-index`.
- [ ] The state badge is NOT lifted above the overlay.
- [ ] The card title button reads visually identical to the `<h4>` it replaces.

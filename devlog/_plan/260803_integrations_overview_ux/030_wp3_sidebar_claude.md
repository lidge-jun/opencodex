# WP3 — Claude returns to the sidebar, as navigation only

## Why it left, and what comes back

`a56a4aea6` collapsed the API / Claude / Grok pages into one `#integrations`
route and took the Claude connection switch out of the sidebar in the same
move. The switch leaving was right: a navigation row that owns a mutation is a
trap, and `ClaudeCode` owns `GET/PUT /api/claude-code` on its own surface.

What went with it by accident was the nav **entry**. Claude Code is the deepest
surface in the app — auth mode, model map, sidecars, context windows, and the
Desktop profile below it — and it now costs two clicks and a tab scan from
anywhere in the GUI.

So: the row comes back, the switch does not. `nav.claude` is still present in
all six locale files, so nothing new is translated.

## The routing problem

`NAV` maps one entry to one `Page`, and `Page` has no `claude` member.
`navigateToPage(id, subPath?)` already takes a sub-path — the sidebar's update
button uses `navigateToPage("dashboard", "update")` — and
`INTEGRATION_TAB_HASHES` already registers `integrations/claude`, so the
destination needs no router change at all.

What the entry needs is a shape `NAV` cannot express: a target hash that is not
the bare page, and an active condition that is not `page === id`. Widen the
`NAV` entry type with two optional fields rather than special-casing Claude in
the render:

```ts
type NavEntry = {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
  /** Sub-path passed to navigateToPage; the row targets a page tab. */
  subPath?: string;
  /** Hash prefixes that keep this row current. */
  activeHashes?: readonly string[];
};
```

Claude's entry is `{ id: "integrations", subPath: "claude", activeHashes:
["integrations/claude"] }`. A prefix match covers `integrations/claude/desktop`
with no second entry.

## Two rows for one page

Both Claude and Integrations resolve to `page === "integrations"`, so
`page === id` would light them both at once. Active state moves to the hash:

- A row with `activeHashes` is current when the normalized hash starts with one
  of them.
- A row without them is current when the page matches **and** no sibling row's
  `activeHashes` claims the current hash.

That second clause is the whole trick. Without it, opening Claude leaves
Integrations lit as well, and the sidebar says the user is in two places.

The row order puts Claude directly above Integrations: it is a shortcut into
that page, and separating them would read as an unrelated section.

## Cleanup

`021 §4` found orphaned `.nav-entry-claude` rules in `styles.css`, including
`.nav-entry-claude .switch` and its focus ring. The switch rules go — the
restored row is navigation only, and leaving a switch style behind is an
invitation to put the mutation back. The entry rules stay and are what the row
uses.

## Acceptance

- [ ] The sidebar has a Claude row between Storage and Integrations.
- [ ] Clicking it lands on `#integrations/claude` with the Claude tab selected.
- [ ] It is current on `#integrations/claude` and on
      `#integrations/claude/desktop`; Integrations is not.
- [ ] Integrations is current on `#integrations` and on every non-Claude tab.
- [ ] The row contains no switch and issues no request.
- [ ] `.nav-entry-claude .switch` rules are gone from `styles.css`.

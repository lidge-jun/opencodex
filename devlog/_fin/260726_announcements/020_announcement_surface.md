# 020 — WP-C: the announcement surface

Depends on WP-B. Consumes `GET /api/announcements` and
`POST /api/announcements/dismiss`.

## Surface by consequence

`000_plan.md` decision 4, made concrete:

| `kind` | Surface | Dismissal |
|---|---|---|
| `decision` | modal, one at a time, oldest first | explicit button; closing without choosing does NOT dismiss |
| `info` | sidebar badge → panel listing pending items | per-item, from the panel |

The distinction is enforced in code, not left to the author's discretion at call
time: an `info` item must not be able to raise a modal. Otherwise every
announcement becomes a `decision` within two releases and rule 1 is dead.

## NEW `gui/src/components/AnnouncementPanel.tsx`

Renders the pending list. Reuses the accessible modal shell from
`gui/src/components/OAuthTosWarningModal.tsx` (backdrop-dismiss button, focus
handling) rather than a second dialog implementation.

## MODIFY `gui/src/App.tsx`

A badge on the existing sidebar footer showing the pending count, opening the
panel. No new nav row — the sidebar already carries eight entries plus the footer
cluster, and an announcement is not a destination.

Fetching follows the deferred pattern the react-doctor lint requires
(`setTimeout(0)` inside the effect, as in `ClaudeDesktop.tsx` and the Grok page):
a synchronous `setState` in an effect trips the cascading-render rule.

## Empty state

With an empty catalog the badge does not render at all — not a zero badge, not a
"nothing to see" panel. UX-STATE-01 says an empty state must explain why it
exists; here there is nothing to explain, so the correct treatment is absence.

## i18n

Shell keys (`announcements.title`, `announcements.dismiss`,
`announcements.empty`) in all six locales. Per-announcement text lives with its
catalog entry's `titleKey`, so adding an item means adding its strings to six
locales — the parity test added earlier this session enforces that, which is a
deliberate friction: it makes declaring an announcement a considered act.

## TESTS — `gui/tests/announcement-surface.test.ts` (NEW)

- no pending items → no badge rendered;
- pending `info` items → badge with the count, panel lists them;
- an `info` item cannot open the modal path (the guard is real, not conventional);
- dismissing posts the id and removes it from the list;
- all six locales carry the shell keys.

## Verification (C)

| Command | Expected |
|---------|----------|
| `gui: bun run test` | pass |
| `bun run lint:gui` | clean |

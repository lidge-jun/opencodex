# 040 — PR4: "Menu bar & widget" becomes its own Usage view

## Behavior after

- `#usage` is the usage report. `#usage/companion` shows only the companion settings panel.
- A tab strip at the top of Usage (same pattern as Logs & Debug) switches between the two with
  hash navigation, so Back/Forward and deep links work. The report's section strip no longer
  lists "Menu bar & widget", and the report no longer scrolls into it.
- The native panel's Settings button, which already targets `usage/companion`, lands on it.
- The companion view renders even when the report is empty or failed.
- Provider choices for the hidden-provider controls come from the report when it loaded, and
  otherwise from `GET /api/config` provider keys (the same endpoint the GUI's config loaders
  use), fetched by the companion view itself. A test renders the companion view with a failed
  usage fetch and asserts the provider controls come from config.
- `hashBelongsToPage` in `gui/src/app-routing.ts` accepts `usage/companion`; a routing test
  asserts it is not normalized back to `usage`.

## Diff

`gui/src/app-routing.ts` (accept the sub-hash), `gui/src/pages/Usage.tsx` (tabs, split view),
tests `gui/tests/usage-layout.test.ts` and routing tests, `structure/companion.md`, docs-site
macOS guide. Labels reuse existing i18n keys where possible; any new key lands in all locales.

## Accept

Focused Bun tests, `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, and a browser
screenshot of both views from a temporary proxy on a spare port with a temporary home.

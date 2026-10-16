# WP1 — Single-line quota strip with scroll controls and account deep link

## Problem

The quota summary strip above every dashboard page (`QuotaSummaryBar`) lays its chips out
with `flex-wrap: wrap`. With seven or more providers it grows to a second row, and a narrow
window can wrap a chip's own label. Clicking a chip only pins the detail popover; there is no
way to jump from "xAI Grok 74% !" to the place where that provider's accounts are managed.

## Behavior after this unit

- The chip list is one row at every width. Chips never shrink or wrap internally.
- When the chips overflow, the list scrolls horizontally (scrollbar hidden) and a « button on
  the left and a » button on the right page the strip by ~80% of its visible width. Each button
  is disabled at its end; both are absent when nothing overflows. State is recomputed on
  scroll, on resize (ResizeObserver on the list), and when the rows change.
- Clicking a chip navigates to `#providers?provider=<name>&tab=accounts`. The Providers page
  selects that provider and opens its Accounts tab (Codex accounts / OAuth accounts / API keys,
  whatever `providerAuthSurface` resolves) through the existing `revealProviderAccounts`
  path. Clicking the same chip while that hash is already current re-dispatches `hashchange`
  so the link re-applies (e.g. after the user switched to the Overview tab).
- Hover and keyboard focus still open the per-window popover. It is `position: fixed` and
  placed from the chip's bounding rect, because an `overflow-x: auto` list would clip an
  absolutely positioned child. It closes when the list scrolls.

## Diff-level plan

1. `gui/src/protocol-deep-links.ts`
   - add `ProviderDeepLinkTab = "settings" | "accounts"`.
   - add `providerAccountsHash(provider)` → `providers?provider=<enc>&tab=accounts`.
   - add `readProviderDeepLinkTab(hash)` → `"accounts"` only for an exact `tab=accounts`
     on the providers route, otherwise `"settings"` (keeps every existing link unchanged).
   - add `openProviderAccounts(provider)`: `navigateHash`, or dispatch a `hashchange`
     event when the hash already matches.
2. `gui/src/pages/providers-deep-link.ts`
   - the request carries `tab`; the hook takes an optional `onAccounts(name)` callback.
   - on apply: tab `accounts` with `onAccounts` → call it (it selects the provider itself);
     otherwise `select(name)` as today.
   - returned settings focus is non-zero only for a settings-tab link, so an accounts link
     never also forces the Settings tab.
3. `gui/src/pages/Providers.tsx` — pass `revealProviderAccounts` as `onAccounts`; update
   the hash comment. `revealProviderAccounts` only sets Providers' own state, so calling it
   during render follows the same "adjust state during render" pattern the hook already uses.
4. `gui/src/components/quota-summary-bar/QuotaSummaryBar.tsx`
   - chip `onClick` → `openProviderAccounts(row.provider)`; drop the click-to-pin state.
   - popover open on hover or focus; Escape closes; fixed placement from
     `getBoundingClientRect` via CSS variables `--qs-pop-top` / `--qs-pop-left`, clamped to
     the viewport.
   - wrap the list in a scroller with « / » buttons; overflow state from scroll metrics.
   - chip `title` adds the "open accounts" hint.
5. `quota-summary-bar.css` — `flex-wrap: nowrap`, `overflow-x: auto`, hidden scrollbar,
   `flex-shrink: 0` + `white-space: nowrap` on items/chips, scroll button styles, fixed popover.
6. i18n: `quotaSummary.scrollPrev`, `quotaSummary.scrollNext`, `quotaSummary.openAccounts`
   in all ten locale catalogs.
7. Tests: extend `gui/tests/protocol-deep-links.test.ts` (hash round trip + tab parse),
   `gui/tests/providers-deep-link.test.tsx` (accounts link calls `onAccounts`, no settings
   focus), new `gui/tests/quota-summary-bar.test.tsx` (happy-dom render: chip click sets the
   accounts hash; scroll buttons hidden without overflow, shown/disabled with stubbed metrics).

## Out of scope

Quota derivation (`quota-summary.ts`), the server quota API, Codex Set's Multi-auth page.

## Verification

`bun run typecheck`, `bun run lint:gui`, focused gui tests
(`protocol-deep-links`, `providers-deep-link`, `quota-summary-bar`, `quota-summary`),
i18n catalog tests, `bun run build:gui`, a browser screenshot of the strip at a narrow width.

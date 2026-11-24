# Desktop Getting started without Start at Login, and a hideable card

Base: `origin/dev` @ `d61cca122d`. Branch `codex/fb2100-home-checklist`. Class C2 (GUI slice, visible).

## Problem

Inside the OpenCodex desktop app, Home -> Getting started reads "2 of 3 done" with step 3
**Turn on Start at Login**. The desktop install and first run already turn Start at Login on
(`desktop/src-tauri/src/first_run.rs`), so the step is noise inside the app, and the card
cannot be put away once a person no longer needs it.

## Decisions (maintainer, 2026-11-21)

1. In the desktop shell (`isDesktopShell()` from `gui/src/lib/desktop-shell.ts`) Home and
   the Set up hub drop the Start at Login step. Home reads "X of 2", the Set up hub "X of 3".
   The browser dashboard keeps its existing step, including the Desktop wording it shows when
   the app manages startup.
2. The Getting started card has a **Hide** control. The choice is stored in `localStorage`
   (`ocx-home-getting-started-hidden`), so it is remembered per dashboard origin and browser
   profile (the desktop webview has its own). Hiding removes only that card; Recent errors,
   the stat tiles and the profile card stay.
3. The Set up hub shows "Getting started is hidden on Home" with **Show on Home** while the card
   is hidden. Right after hiding, Home shows a one-line note with **Undo** in the card's place
   for the rest of that visit, which also keeps keyboard focus from falling to the page body.

Start at Login detection (`src/service/desktop-startup.ts`) and the Startup page are untouched.

## Diff plan

- ADD `gui/src/getting-started-visibility.ts`: storage key, `readGettingStartedHidden`,
  `useGettingStartedHidden()` (`useSyncExternalStore` over `localStorage` plus the
  `storage` event; a rejected write keeps the choice for the session).
- ADD `gui/src/i18n/getting-started-copy.ts`: `gettingStarted.*` rows, all 11 locales;
  spread from `shellV2Copy()` so no locale catalog changes.
- EDIT `gui/src/pages/Home.tsx`: filter the autostart step in the desktop shell; Hide button,
  hidden state and the Undo note; Recent errors spans the row when the card is hidden.
- EDIT `gui/src/pages/SetupHub.tsx`: filter the autostart step in the desktop shell; hidden
  notice with Show on Home.
- ADD `gui/tests/home-getting-started.test.tsx` (screen-level, failing first). `gui/tests` is
  outside the root test-layout inventory, so no layout registration.
- EDIT `docs-site/src/content/docs/guides/desktop-app.md` where it describes the checklist;
  keep localized guides from contradicting English.

## Verification

`cd gui && bun ../scripts/test-with-pinned-bun.ts --isolate tests/home-getting-started.test.tsx
tests/startup-checklist-desktop.test.tsx tests/home-errors.test.tsx tests/home-management-health.test.tsx`,
`bun run typecheck`, `bun run lint:gui`, `cd gui && bun run lint:i18n && bun run build`,
`bun run test:changed`, docs-site build if docs change. Screenshots from an isolated
`OPENCODEX_HOME` proxy: browser and a desktop-shell user agent, before and after.

## Audit fold (gpt-6.1-terra plan audit, NEAR-PASS)

- P1 copy typing: `shellV2Copy` declares `Record<ShellV2Key | GettingStartedKey, string>`, so `TKey`
  (inferred from the English catalog) carries the new keys in all 11 catalogs.
- P1 store: one module snapshot. Writes notify same-window subscribers directly; the `storage`
  event reconciles other windows; a failed read or write keeps the in-memory value for the visit.
- P2 focus: Home moves focus to Undo only after a click on Hide, never on load or external change.
  Hide's accessible name is "Hide Getting started" (contains the visible "Hide").
- P2 verification: review-ready adds the full GUI suite (`cd gui && bun run test`), and the existing
  browser-with-Desktop-health cases in `startup-checklist-desktop` and `startup-checklist-refresh` stay.

## Code review fold (same reviewer, round 2, NEAR-PASS)

- P1 readable-write, unreadable-read storage: the store keeps the last local choice per storage
  object and answers with it when `getItem` throws, even after a successful write.
- P2 the `storage` listener reconciles only events whose `storageArea` is this localStorage, so a
  `sessionStorage.clear()` elsewhere cannot drop an unsaved choice.
- The Set up hub test now asserts focus lands on the "back on Home" confirmation.
- Implementation note: the Set up hub is the **Checklist** tab under **Route**, so the restore hint
  names that path from the live navigation labels (`{place}`).

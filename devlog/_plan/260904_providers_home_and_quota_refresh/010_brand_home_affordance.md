# 010 — Make the product brand a home control

Work-phase `wp1`. Depends on 000.

## Problem

`gui/src/App.tsx` renders `brand` as an inert `<div className="brand">` in two
places. Users click the logo to go home; nothing happens.

## Decision

Convert the brand into a real control that navigates to `#dashboard`, in BOTH
placements, and do not add any other home affordance anywhere.

Element choice: `<button type="button">`, not `<a href="#dashboard">`.
The app already routes through `navigateToPage`/`navigateHash` helpers that own
history semantics; an anchor would write the hash directly and bypass the
drawer-close and history-push behavior the rest of the nav relies on. Every
other navigation control in the sidebar is already a `<button className="nav-item">`,
so a button matches both the code and the a11y story.

## Diff plan

### gui/src/App.tsx

The `brand` const currently produces a `<div className="brand">` containing the
logo image, `.name`, and `.ver`. Replace the wrapper with a button, keeping the
children byte-identical so no CSS child selector breaks:

```tsx
const brand = (
  <button
    type="button"
    className="brand brand-home"
    onClick={() => { navigateToPage("dashboard"); setNavOpen(false); }}
    aria-label={t("nav.home")}
    title={t("nav.home")}
    {...(page === "dashboard" ? { "aria-current": "page" as const } : {})}
  >
    {/* unchanged children */}
  </button>
);
```

Constraints this must satisfy:

- `navigateToPage` is the deliberate-navigation helper the sidebar rows use, so
  it pushes a history entry. Back therefore returns to Providers, which is the
  behavior a user expects from a home click.
- `setNavOpen(false)` is required because the second render site is inside the
  off-canvas drawer; navigating without closing leaves the drawer over the
  destination. The sidebar nav rows already do exactly this.
- `aria-current="page"` only when already on dashboard, matching the
  `nav-item` convention in the same file.
- The `brand` const is defined once and rendered twice, so both the mobile
  topbar and the drawer head inherit the behavior from one edit.

### gui/src/styles.css

A `<button>` brings UA defaults that would visibly change the header. Add a
reset scoped to the new class, next to the existing `.brand` rules:

```css
.brand-home {
  appearance: none;
  background: none;
  border: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
```

Keep the existing `.brand` layout declarations untouched — they already own
display/gap/padding, and the mobile-topbar override
(`.mobile-topbar .brand { flex: 1 1 auto; min-width: 0; padding: 4px; }`)
must keep applying, which it does because the class list still starts with
`brand`.

Focus visibility: the app already ships a global focus-visible treatment; verify
it lands on `.brand-home` and only add a scoped rule if it does not.

### i18n

Add one key, `nav.home`, to every locale under `gui/src/i18n/`:

| locale | value |
|--------|-------|
| en | `Go to dashboard` |
| ko | `대시보드로 이동` |
| ja | `ダッシュボードへ` |
| zh | `前往仪表板` |
| zh-TW | `前往儀表板` |
| de | `Zum Dashboard` |
| fr | `Aller au tableau de bord` |
| ru | `Перейти к панели` |
| tr | `Panoya git` |

Place it adjacent to the existing `nav.*` block in each file so the key order
stays consistent with house style.

## Verification

- `bun run typecheck`
- `bun run lint:gui`
- Focused test asserting the brand is a button carrying an accessible name and
  that activating it routes to dashboard, plus locale parity for `nav.home`.
- Live: click the logo at `#providers` and observe the URL become
  `#dashboard`; screenshot.

## Explicit non-goals

No breadcrumb, no "홈으로" row in the Providers header, no change to the
existing 대시보드 sidebar row.

# 010 — WP1: sidebar footer collapses to one icon row

Depends on: nothing. Lands as PR 1 of the stack.

## Goal

The sidebar footer currently spends five rows on preference/promo chrome (language select,
theme button, "프록시" label + 2 orbs, GitHub link + star + update). After: one icon row
(globe · theme · GitHub · update) and one orb row (session-logout? · stop · restart). No text
labels; every control keeps `aria-label` + `title`. The star orb leaves the chrome entirely.

## File change map

### MODIFY gui/src/App.tsx (L322-375)

Before (structure):
```tsx
<div className="sidebar-foot">
  <div className="lang-toggle"><IconGlobe/><Select … placement="right" portal={false} …/></div>
  <button className="theme-toggle" …><ThemeIcon/> <span className="mode">{t(THEME_TKEY[theme])}</span></button>
  <div className="sidebar-action-row">
    <span className="sidebar-action-label">{t("dash.actions")}</span>
    <div className="sidebar-action-orbs">{logout?}{stop}{restart}</div>
  </div>
  <SidebarGithubRow apiBase={sharedBase} onOpenUpdate={…}/>
</div>
```

After:
```tsx
<div className="sidebar-foot">
  <div className="sidebar-foot-row" role="group" aria-label={t("sidebar.preferences")}>
    <div className="lang-toggle lang-toggle--icon">
      <Select
        value={locale}
        options={LOCALES.map(l => ({ value: l.code, label: localeDisplayName(l.code) }))}
        onChange={v => setLocale(v as Locale)}
        label={t("lang.label")}
        placement="right"
        portal={false}
        trigger={<span className="sidebar-orb" title={t("lang.label")}><IconGlobe aria-hidden /></span>}
      />
    </div>
    <button type="button" className="sidebar-orb" onClick={cycleTheme}
      aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}
      title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
      <ThemeIcon />
    </button>
    <SidebarGithubRow apiBase={sharedBase} onOpenUpdate={…} />
  </div>
  <div className="sidebar-foot-row" role="group" aria-label={t("dash.actions")}>
    {logout orb (unchanged)}{stop orb (unchanged)}{restart orb (unchanged)}
  </div>
</div>
```

DECISION (audit blocker 3): `Select` (gui/src/ui.tsx:96-112) has no `trigger` prop and gets
none. Keep the existing `<Select … placement="right" portal={false}>` inside
`.lang-toggle.lang-toggle--icon`; CSS sizes the trigger to a 28px orb and hides its text/chevron
children (`.lang-toggle--icon .select-trigger { width:28px; height:28px; padding:0; border-radius:50% }`,
`.lang-toggle--icon .select-trigger > span, .lang-toggle--icon .select-trigger > svg { display:none }`
— the trigger's children are exactly one `<span>` (label) and one `<IconChevron>` svg (ui.tsx:305-306),
so both are hidden (round-3 blocker 1: `:not(svg)` kept the chevron). The sibling
`<IconGlobe aria-hidden/>` is absolutely positioned over the now-empty trigger with `pointer-events:none`. The `trigger={…}` line in the
After snippet is NOT written; read it as "existing Select, icon-sized by CSS".

### MODIFY gui/src/components/sidebar-github-row.tsx

- Delete the star orb JSX (L134-145), `handleStar`, `starOverride`, `starring`, `starPoll`,
  `STAR_POLL_MS`, `StarState`/`StarStatus` types, `IconStar` import. The star action is RELOCATED, not deleted (audit blocker 1: the update dialog has no star
  control today). NEW `gui/src/components/github-star-button.tsx`: move `handleStar`,
  `starOverride`, `starring`, `starPoll`, `STAR_POLL_MS`, `StarState`/`StarStatus` and the
  button JSX (sidebar-github-row.tsx L54-99, L134-145) verbatim into
  `export function GithubStarButton({ apiBase })` rendering a `.btn.btn-ghost.btn-sm` with the
  same labels. Mount it in `gui/src/pages/dashboard-dialogs.tsx` inside the `<dialog>` card as
  `{updateOpen && <GithubStarButton apiBase={d.apiBase} />}` (`DashboardDialogs` receives the `Dash` bag as `d`, dashboard-dialogs.tsx:12-22, and does not destructure `apiBase`; `d.apiBase` is the existing field) — EXPLICIT conditional (round-3
  blocker 1: the dialog element is always mounted and only toggles `display`, L24-33), so
  closing unmounts the component and cancels its `useKeyedClientResource` poll. Consent rule unchanged: still a human click.
- The GitHub link becomes an icon orb: `<a className="sidebar-orb" href={REPO_URL} target="_blank" rel="noreferrer" aria-label={t("common.github")} title={t("common.github")}><IconGithub/></a>`.
- Update orb unchanged (dot when `updateAvailable`).
- Wrapper: `<>{link}{update}</>` — the row container is now App's `.sidebar-foot-row`.

### MODIFY gui/src/styles.css

- L336-338 `.sidebar-github-row`, `.sidebar-github-link`, `.sidebar-github-actions` → DELETE.
- L351 `.sidebar-orb--starred` → DELETE.
- L373-382 `.lang-toggle` family: keep the dropdown rules (`.lang-toggle .select-dropdown*`);
  replace the row rule with `.lang-toggle--icon { position: relative; }` and hide the
  trigger text.
- L383-386 `.theme-toggle*` → DELETE.
- L394-400 `.sidebar-action-row`, `.sidebar-action-label`, `.sidebar-action-orbs` → replace
  with `.sidebar-foot-row { display:flex; align-items:center; gap:4px; padding: 4px 10px; }`.
- L2309-2312 mobile orb sizing: unchanged.

### MODIFY gui/src/i18n/*.ts (9 locales)

- ADD `sidebar.preferences` ("Preferences" / "환경설정" / …).
- DELETE `sidebar.star`, `sidebar.starred`, `sidebar.starUnauthenticated`, `sidebar.starFailed`
  only if no other consumer (`rg -n 'sidebar.star' gui/src`) — the update dialog may use
  them; verify at B. `dash.actions` stays (aria-label of the orb group).

### Tests

- MODIFY gui/tests/sidebar-rows.test.ts: the padding assertions for `.lang-toggle`,
  `.theme-toggle`, `.sidebar-action-label`, `.sidebar-github-row` describe the old rows;
  rewrite to assert `.sidebar-foot-row` exists with `gap: 4px` and that `.theme-toggle`,
  `.sidebar-action-label`, `.sidebar-github-row` no longer exist in CSS.
- MODIFY gui/tests/locale-dropdown-bounds.test.ts: selectors still target
  `.lang-toggle .select-dropdown-beside` → unchanged if the class is kept.
- MODIFY gui/tests/app-sidebar-actions.test.ts: L58 asserts absence of a class — still true.
- NEW gui/tests/sidebar-footer-minimal.test.ts: source oracle — App.tsx contains no
  `sidebar-action-label`, sidebar-github-row.tsx contains no `IconStar` and no
  `/api/github/star`; i18n en has `sidebar.preferences`.
- NEW gui/tests/github-star-button.test.tsx (happy-dom): with a fetch stub, opening the update
  dialog renders GithubStarButton; GET `/api/github/star` fires once on mount; clicking POSTs
  `/api/github/star` and the label flips to `sidebar.starred` on `{ok:true}`; closing the dialog
  unmounts it (no further GETs after advancing fake timers).
- Render test (happy-dom, pattern from `i18n-language-switch.test.tsx`): mount App, assert
  the footer has exactly 4 preference orbs and 2-3 action orbs, each with non-empty
  `aria-label`; language change through the Select still flips `document.documentElement.lang`.

## Verifiers (run at P before attest)

- `bun test ./gui/tests/sidebar-rows.test.ts ./gui/tests/locale-dropdown-bounds.test.ts ./gui/tests/app-sidebar-actions.test.ts ./gui/tests/i18n-language-switch.test.tsx` — exit 0 today; reads App.tsx/styles.css directly.
- `cd gui && bun run lint:i18n` — reads i18n + pages.
- `cd gui && bun run build`.

## Accept criteria

- ko 1440 screenshot: footer = 2 rows of orbs, no text labels below the nav.
- DOM: `.sidebar-foot` contains 0 `.sidebar-action-label`, 0 `.sidebar-github-link` text,
  every `button`/`a` inside has `aria-label`.
- Language switch still works (render test).
- Star: `rg -n 'github/star' gui/src` → only the dialog / API client, never App/sidebar.

## Bypass fields

tier E2 (tests) · surface: bun test in CI `gates` · bypass: `--no-verify` local, CI still runs · residual: none · wording: "early warning".

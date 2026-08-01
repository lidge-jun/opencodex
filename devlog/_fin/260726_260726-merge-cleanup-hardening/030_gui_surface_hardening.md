# 030 — WP3: GUI surface hardening of the merge resolutions

Scope: the GUI code this session's merge touched — the `Claude.tsx` tab wrapper
that took over the `claude` route, the six locale files whose conflict I
resolved by hand, and the Desktop status affordances.

Outcome: **NOOP**. Four checks, no real defect. Details below so a later reader
can tell "inspected and clean" from "never looked".

## Check 1 — locale key-set parity (the highest-risk item)

This is where a hand-resolved conflict is most likely to do quiet damage: the
`de.ts` conflict was resolved twice, because the first resolution restored the
pre-split `} as const; export type TKey = keyof typeof de;` tail while `dev` had
already migrated the file to `Record<TKey, string>`.

Extracted every key from all six locales and diffed the sets:

```
en.ts 1257 keys   de.ts 1257   ko.ts 1257   ja.ts 1257   zh.ts 1257   ru.ts 1257
de: IDENTICAL key set   ko: IDENTICAL   ja: IDENTICAL   zh: IDENTICAL   ru: IDENTICAL
```

Desktop-specific keys (`claudeDesktop.*` plus `claude.tab*`): 56 in every
locale. No key was dropped or duplicated by the resolution. `bun x tsc -p
gui/tsconfig.app.json` also passes, which is the compile-time half of the same
guarantee (`de.ts` is typed `Record<TKey, string>`, so a missing key fails the
build).

## Check 2 — untranslated values

Compared every Desktop key's value against `en`: 8 identical per locale, 9 for
`de`. Inspected each — they are product and model nouns that are correctly
identical across languages (`Claude Desktop`, `Opus`, `Fable`, `Sonnet`,
`Haiku`, `Code`, `Desktop`, `effort`). The `de`-only extra is
`claudeDesktop.alias` = `"Alias"`, which is the real German word, not a missed
translation; `ko`/`ja`/`zh`/`ru` use 별칭 / エイリアス / 别名 / Псевдоним.
No defect.

## Check 3 — tab wrapper correctness

`gui/src/pages/Claude.tsx` implements the ARIA tabs pattern properly:
`role="tablist"` with `aria-label`, `role="tab"` + `aria-selected` +
`aria-controls` per button, matching `role="tabpanel"` + `aria-labelledby`
panels, roving `tabIndex` (0 on the active tab, -1 on the other), and
Arrow/Home/End key handling that moves focus after the state change via
`requestAnimationFrame`. Panels are both `hidden` and conditionally mounted, so
the inactive page issues no fetches. No defect.

## Check 4 — the nav-level Claude toggle still targets the right endpoint

`App.tsx` keeps polling and PUTting `/api/claude-code` for the sidebar switch.
That is correct and unchanged by the wrapper: the toggle governs Claude Code
inbound routing, while the Desktop profile has its own `/api/claude-desktop`
endpoints reached from inside the Desktop tab. The wrapper changed which
component the route mounts, not what the toggle controls. No defect.

## Verification (C)

| Command | Result |
|---------|--------|
| `bun run lint:gui` | eslint clean, exit 0 |
| `gui: bun run test` | 216 pass, 0 fail |
| locale key-set diff (all 5 vs en) | identical |

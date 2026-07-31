# 160.14 — Dashboard i18n: en / ko / zh-CN Language Router

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C3 (cross-cutting — every GUI surface + new i18n module)
- **Source:** user request — "대시보드에 언어 en / ko / cn 세가지 언어 라우터도 놔두고 번역해서 패치"

## What

The 10100 dashboard now ships in **English, 한국어, 中文 (zh-CN)** with a sidebar language
switcher. The locale persists, sets `<html lang>`, and every user-facing string is translated.

## Design — zero-dependency typed i18n

The GUI has no runtime deps beyond React (own icons, own UI primitives), so i18n follows the
same ethos rather than pulling in i18next.

- `gui/src/i18n/en.ts` — **source of truth**; its object's keys define `TKey`.
- `gui/src/i18n/ko.ts`, `zh.ts` — `Record<TKey, string>`, so a missing/renamed key is a **compile
  error** (all three currently hold 109 keys).
- `gui/src/i18n/index.tsx` — `LanguageProvider` (React context), `useT()`, `useI18n()`, `LOCALES`,
  and a `<Trans>` helper.
  - Persistence: `localStorage["ocx-lang"]`; fallback chain **stored → `navigator.language` → en**.
  - Side effect: sets `document.documentElement.lang` to `en` / `ko` / `zh-CN`.
  - `t(key, vars?)` interpolates `{var}` via split/join (no `replaceAll` lib dependency).
  - `<Trans k cmd vars?>` renders a translation's leftover `{cmd}` slot as a `<code className="chip">`
    — used for inline CLI commands (`ocx init`, `ocx start`, `spawn_agent`) inside otherwise
    translated sentences.

## Switcher

Sidebar-foot button (reuses `.theme-toggle` styling, beside the theme toggle) cycling
**English → 한국어 → 中文**. Shows the **native name** (never flags, per i18n best practice);
icon-only on mobile (`.mode` hidden). `gui/src/icons.tsx` gained `IconGlobe`.

## Touch points

- `gui/src/main.tsx` — wrap `<App>` in `<LanguageProvider>`.
- `gui/src/App.tsx` — nav + theme labels via `t()`; language switcher.
- `gui/src/pages/{Dashboard,Providers,Models,Subagents,Logs}.tsx` — all strings → `t()`.
- **Providers.tsx**: status tone was derived from English substring matching
  (`status.includes("Saved")`) — i18n breaks that, so it now carries an explicit `ok` boolean
  set at each `notify(msg, ok)` call.
- **Logs.tsx**: request times format with `toLocaleTimeString(localeTag)` (Intl, per locale).

## Verification

- `gui bun run build` (tsc -b && vite build) → clean (28 modules; dicts compile-checked).
- Live proxy: Dashboard screenshotted in **en / ko / zh** — nav, metric tiles, table headers,
  empty/grouped states all translate; switcher cycles and updates `<html lang>` (`en` → `ko` →
  `zh-CN`); Models page re-renders live to 模型 on switch and the language persists across
  navigation.

## Notes
- Committed in `dd128a6` (gui-only, pathspec commit). The repo had a concurrent agent merging an
  unrelated backend PR during this work; the i18n change is gui-only and independent.
- Provider/adapter technical badges (`oauth`, `passthrough`, adapter names, model ids, `Base URL`)
  are intentionally left untranslated — they are identifiers, not prose.

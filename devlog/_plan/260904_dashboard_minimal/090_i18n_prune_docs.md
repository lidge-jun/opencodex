# 090 — WP9: prune orphaned i18n keys, sync docs-site

Depends on: 010-080 all landed on dev.

## Procedure

1. Orphan detection: for every key in `gui/src/i18n/en.ts`, `rg -n --fixed-strings '"<key>"' gui/src --glob '!i18n/*'`
   (plus the `Trans k=` and `as TKey` dynamic patterns: `models.v2Mode_`, `startup.summary.`,
   `logs.detail.reason.` — keep any key whose prefix appears in a template literal). Script it
   as `gui/scripts/find-orphan-keys.mjs` (NEW, ~40 lines) and run it; the output list is the
   deletion set. Expected members: `dash.subtitle`, `dash.activeProviders`,
   `dash.availableModels`, `dash.workspace.*`, `dash.version`, `dash.uptime`, `dash.multiAgent*`,
   `dash.shadowCall*`, `dash.delegation*`, `sidebar.star*`, `integrations.subtitle`,
   `integrations.summary.lastChange`, `usage.card.activeDays`, `usage.subtitle`,
   `startup.backToDashboard`, `logs.subtitle`, `pws.dashboard.subtitle`, `models.orderHint`
   (if the tooltip reuses it, it stays).
2. Delete each from all 9 locale files (they are flat objects; `sed` per key is fine).
3. `cd gui && bun run lint:i18n` must stay green; `gui/tests/locale-parity.test.ts` ("every locale key
   set matches the English source") is the verifier that all nine moved together.
4. docs-site: `rg -n -i 'dashboard|대시보드' docs-site/src/content/docs --files-with-matches`;
   update pages that describe the dashboard tabs, the sidebar star button, the Models
   controls row, or the Integrations tab strip. English source first, then the translated
   locales must not contradict it (AGENTS.md docs-sync rule).

## Tests

- NEW gui/tests/i18n-orphans.test.ts: runs the same orphan scan and asserts the list is empty
  (so future dead keys fail CI). Allowlist dynamic prefixes explicitly.

## Verifiers

`bun test ./gui/tests/locale-parity.test.ts ./gui/tests/i18n-orphans.test.ts ./gui/tests/fr-localization.test.ts`, `cd gui && bun run lint:i18n`, `cd gui && bun run build`, and `cd docs-site && bun run build` if present.

## Accept criteria

- Orphan scan returns 0; nine locales same key set; docs-site builds.

## Bypass fields

E2 · CI gates + the new orphan test · `--no-verify` · residual: dynamic-key allowlist can hide a true orphan · "early warning".

# 090 — WP9: prune orphaned i18n keys, sync docs-site

Depends on: 010-080 all landed on dev.

## Procedure

1. Orphan detection: for every key in `gui/src/i18n/en.ts`,
   `rg -n --fixed-strings '"<key>"' gui/src --glob '!gui/src/i18n/**'` (audit blocker 7: the glob
   is repo-root-relative; `!i18n/*` excluded nothing). The script additionally drops any hit whose
   path starts with `gui/src/i18n/` before counting consumers.
   (plus the `Trans k=` and `as TKey` dynamic patterns: `models.v2Mode_`, `startup.summary.`,
   `logs.detail.reason.` — keep any key whose prefix appears in a template literal). Script it
   as `gui/scripts/find-orphan-keys.mjs` (NEW, ~40 lines) and run it; the output list is the
   deletion set. Expected members: `dash.subtitle`, `dash.activeProviders`,
   `dash.availableModels`, `dash.workspace.*`, `dash.version`, `dash.uptime`, `dash.multiAgent` (label only; `dash.multiAgentGuidance*` stays: SubagentDelegationSection.tsx:118-126 consumes it; `sidebar.star*` stays: GithubStarButton consumes it),
   `dash.shadowCall*`, `dash.delegation*`, `integrations.subtitle`,
   `integrations.summary.lastChange`, `usage.card.activeDays`,
   `startup.backToDashboard`, `logs.subtitle`, `pws.dashboard.subtitle`, `models.orderHint`
   (if the tooltip reuses it, it stays).
2. Delete each from all 9 locale files (they are flat objects; `sed` per key is fine).
3. The real i18n gate is `gui/tests/locale-parity.test.ts` + `bun run typecheck`
   (`Record<TKey,string>`); `cd gui && bun run lint:i18n` is only the hardcoded-string oxlint
   rule and proves nothing about catalog parity (audit blocker 7).
4. docs-site file map (audit blocker 3): `docs-site/src/content/docs/guides/web-dashboard.md`
   L59-62 ("Dashboard sections are addressable … `#dashboard/providers` and `#dashboard/models`
   open the other two") → "`#dashboard` is the overview; older `#dashboard/providers` and
   `#dashboard/models` bookmarks redirect to `#providers` and `#models`." Same paragraph in the
   7 locale copies `docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/guides/web-dashboard.md` (verified by `ls`; there is no de or zh copy)
   (ko: L53; list with `ls docs-site/src/content/docs/*/guides/web-dashboard.md`). Also grep each
   for star/별표, "Available models"/"사용 가능한 모델", "Active providers", and the Models
   controls-row wording and rewrite to the post-030/040 surface. Per-locale before/after is
   written at this phase's P after 010-080 landed (copy depends on what shipped); the English
   sentence above is the source.

## Tests

- NEW gui/tests/i18n-orphans.test.ts: runs the same orphan scan and asserts the list is empty
  (so future dead keys fail CI). Allowlist dynamic prefixes explicitly.

## Verifiers

`bun test ./gui/tests/locale-parity.test.ts ./gui/tests/i18n-orphans.test.ts ./gui/tests/fr-localization.test.ts`, `cd gui && bun run lint:i18n`, `cd gui && bun run build`, and `cd docs-site && bun run build` if present.

## Accept criteria

- Orphan scan returns 0; nine locales same key set; docs-site builds.

## Bypass fields

E2 · CI gates + the new orphan test · `--no-verify` · residual: dynamic-key allowlist can hide a true orphan · "early warning".

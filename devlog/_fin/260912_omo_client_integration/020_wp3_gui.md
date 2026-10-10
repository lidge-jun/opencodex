# wp3 — the Integrations page

**Scope note after two audit rounds.** Everything above the line lands in wp2,
not here. `tests/gui/integrations-invariants.test.ts` binds the GUI lists to the
backend list; the locale keys are reached through `TKey` (`keyof typeof en`) at
their use sites and every other catalog is a `Record<TKey, string>`, so a new key
must exist in all nine locales to compile; and the GUI test literals and the two
translation allowlists fail the moment the source lists move. This document is
the map of those surfaces; wp2 executes all of it, including the test edits.

wp3 keeps what genuinely cannot be done before the code exists: looking at it.

The page the user named, `#integrations/`, reads five lists that are compared
against `EXPORT_CLIENT_IDS` by `tests/gui/integrations-invariants.test.ts`, three
exhaustive records the compiler forces, and two lists that are neither.

## Compared against the backend list

- `FILE_INTEGRATION_CLIENTS` in `gui/src/pages/integrations/integration-api.ts`
  (the GUI's own list; `INTEGRATION_CLIENT_IDS` is the backend's, in
  `src/integrations/registry.ts`)
- `CLIENTS` in `gui/src/components/apikeys-workspace/client-config-clients.ts`
- the keys of `CLIENT_LABEL_KEYS` in the same file
- `FILE_INTEGRATION_CLIENTS`
- the hashes in `INTEGRATION_TAB_HASHES`

## Forced by typecheck

- `FILE_LABEL_KEY` in `gui/src/pages/integrations/overview-clients.ts`
- `SEMANTICS_KEY` and `TAB_LABEL_KEY` in `FileIntegrationPage.tsx`
- `INTEGRATION_MARKS` in `gui/src/components/integration-marks.ts`, which is an
  exhaustive `Record<OverviewClientId, string | null>` — so a new client cannot
  reach the page without an explicit asset decision

## The silent hazards

`TABS` and `FILE_CLIENTS` in `gui/src/pages/integrations/integration-tabs.ts` are
neither exhaustive records nor covered by the invariant test. Omitting omo from
either leaves typecheck and the invariants green while the tab simply does not
render — exactly the failure the user would see and we would not.
`gui/tests/integrations-tab-coverage.test.ts` stands in that gap and must be
confirmed still to do so.

`gui/src/app-routing.ts` is not a third. `tests/gui/integrations-invariants.test.ts`
already requires a routable hash per `EXPORT_CLIENT_IDS` entry, and the tab
coverage test re-checks that every tab hash is routable. It still has to be
edited; it just fails loudly rather than silently.

## Mark

`CLIENT_MARKS.omo` points at a first-party asset in
`gui/public/provider-icons/`, with provenance recorded in that directory's
`README.md` and in `003_brand_mark_provenance.md`. Membership in
`MONOCHROME_CLIENT_MARKS` depends on the artwork having a single neutral ink:
a single-ink mark is drawn as a themed mask so it does not vanish against one of
the two themes, and a multi-ink or brand-colored mark stays an image so masking
cannot flatten a palette or repaint a trademark.

If omo publishes nothing usable, the honest outcome is `null` and the monogram
tile — `integration-marks.test.ts` currently pins that no client is in that
state, so the pin changes rather than a lookalike logo being invented.

## i18n

Three keys across nine locales (`en`, `de`, `fr`, `ja`, `ko`, `ru`, `tr`, `zh`,
`zh-TW`): `integrations.tab.omo`, `integrations.semantics.omo`,
`api.clientConfig.clientOmo`.

"omo" is a product name and stays untranslated, which means adding the tab and
client keys to `ZH_TW_KEEP_ENGLISH` in `gui/tests/locale-parity.test.ts` and
`INTENTIONAL_ENGLISH` in `gui/tests/fr-localization.test.ts`. The semantics
string is prose and is translated in all nine.

## GUI tests to update

`gui/tests/client-config-panel.test.tsx`, `gui/tests/integrations-api.test.ts`,
`gui/tests/integrations-overview-rows.test.ts`, `gui/tests/integration-marks.test.ts`,
`gui/tests/client-marks-assets.test.ts`, `gui/tests/locale-parity.test.ts`,
`gui/tests/fr-localization.test.ts`, `gui/tests/integrations-tab-coverage.test.ts`.

---

## What wp3 still owns

- Building this worktree's GUI and serving it, rather than reading whatever build
  the long-running proxy already has.
- Confirming the row, the tab and the mark actually render — the mark as the omo
  face rather than a filled plate, at the size the row draws it.
- Copy-editing `integrations.semantics.omo` against what the page shows. wp2
  writes the string; wp3 is where it gets read in place and fixed if it reads
  badly beside its thirteen neighbours.

# wp3 — Aside GUI surface

Depends on wp2. Five invariant-compared lists, three exhaustive maps, two
hand-maintained lists the compiler cannot see, three i18n keys times nine
locales, and the docs tables.

## Invariant-compared (test fails if omitted)

- `gui/src/components/apikeys-workspace/client-config-clients.ts`: `"aside"` in
  `CLIENTS`, `aside: "api.clientConfig.clientAside"` in `CLIENT_LABEL_KEYS`.
- `gui/src/pages/integrations/integration-api.ts`: `"aside"` in
  `FILE_INTEGRATION_CLIENTS`, which widens `FileIntegrationClientId`.
- `gui/src/app-routing.ts`: `"integrations/aside"` in `INTEGRATION_TAB_HASHES`.

## Typecheck-enforced maps

- `overview-clients.ts`: `FILE_LABEL_KEY.aside`.
- `FileIntegrationPage.tsx`: `SEMANTICS_KEY.aside`, `TAB_LABEL_KEY.aside`.

## The two lists nothing checks

`TABS` and `FILE_CLIENTS` in `gui/src/pages/Integrations.tsx` are plain arrays,
not exhaustive records, and the invariant test does not read them. Omitting
Aside from either leaves every gate green and the tab simply absent.

Closed concretely: `gui/tests/integrations-tab-coverage.test.ts` (new) imports
`FILE_INTEGRATION_CLIENTS` and asserts every id appears in both `TABS` and
`FILE_CLIENTS`, deriving the expectation rather than restating a literal list, so
the next client added cannot repeat the omission. That file is named in the
verification command below.

## Existing GUI tests that must be updated

These carry exact literals and fail until edited. wp3 owns each edit rather than
discovering it at run time:

- `gui/tests/integrations-overview-rows.test.ts:224`: the unsettled-row count is
  15 today and becomes 16 with Aside; also add the Aside row assertion.
- `gui/tests/integrations-api.test.ts:19`: the exact
  `FILE_INTEGRATION_CLIENTS` tuple.
- `gui/tests/client-config-panel.test.tsx:173`: the exact `CLIENTS` tuple, plus
  the Aside label key.
- `gui/tests/locale-parity.test.ts:32`: `ZH_TW_KEEP_ENGLISH` gains the two brand
  labels.
- `gui/tests/fr-localization.test.ts:16`: `INTENTIONAL_ENGLISH` likewise.

## i18n

`integrations.tab.aside` = "Aside" and `api.clientConfig.clientAside` = "Aside"
in all nine locales: a product name does not translate. Both go into
`ZH_TW_KEEP_ENGLISH` (`gui/tests/locale-parity.test.ts`) and
`INTENTIONAL_ENGLISH` (`gui/tests/fr-localization.test.ts`).

`integrations.semantics.aside` is prose and IS translated. English:

> Writes the opencodex provider block into Aside's model catalog for the signed-in
> account. Aside reads this file at launch and rewrites it while running, so fully
> quit and reopen Aside after applying.

The restart clause matters: the Aside daemon overwrites `models.json` while
running (001). `integrations.dialog.desktop.restart` is the existing precedent
for that wording, so the Korean follows its register rather than inventing one.

## Client mark

`CLIENT_MARKS.aside` if wp5 verifies a first-party asset. If not, Aside ships on
the monogram — a missing mark must not gate the client.

## Docs

`reference/cli/agents.md`: client union, flag table, destination row
(`~/.aside/u/<account>/models.json`). `guides/integrations.md`: an Aside row,
plus the missing `zcode` row found during research. Translated CLI reference
pages follow `42adf4996`.

## Verification

`bun test gui/tests/integrations-tab-coverage.test.ts
gui/tests/integrations-overview-rows.test.ts gui/tests/integrations-api.test.ts
gui/tests/client-config-panel.test.tsx gui/tests/integrations-surfaces.test.tsx
gui/tests/locale-parity.test.ts gui/tests/fr-localization.test.ts`, then
`bun run typecheck` and `bun run lint:gui`. Rendered screenshot of the Aside card
and its tab.

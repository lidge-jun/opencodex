# Every surface a new export client must reach

Derived from `git show c6fa2563d` (the `prime` client, 29 files) plus the
invariant tests. This is the checklist wp2 and wp3 execute.

## Backend (wp2)

- `src/clients/config-export.ts`: `asideHomeDir`/`asideAccountDir`/
  `asideConfigPath` helpers, `"aside"` in `ExportClientId`,
  `buildAsideContribution`, and the `EXPORT_CLIENTS.aside` spec. The spec needs
  all nine fields: `filename`, `destination`, `apiKeyEnv`, `exportHint`,
  `build`, `format`, `summarize`, `buildContribution`, `loopbackOnly`.
- `src/integrations/registry.ts`: `INTEGRATION_CLIENTS.aside` with `configPath`
  and `detectDir`. No `sourcePreservingYaml` (JSON) and no `writerLock`, same as
  `pi` and `prime`.
- `src/cli/registry.ts`: the `export` entry's static `usage`/`summary` client
  union. Acceptance itself comes from `EXPORT_CLIENT_IDS` via
  `isExportClientId` in `src/cli/export-command.ts`, so this is help text only.
- `tests/aside-client.test.ts`: new, modeled on `tests/prime-client.test.ts`.

`bun run skill:surface` is NOT implicated: its generator reads `CAPABILITIES`,
and a new `--client` value creates no capability.

## Existing tests that assert exact lists (wp2)

These fail until updated, which is the point:

- `tests/client-config-export.test.ts`: ordered `EXPORT_CLIENT_IDS`.
- `tests/client-config-export-new-clients.test.ts`: the loopback-only set.
- `tests/integrations-invariants.test.ts`: the client count, and `SEED` is a
  `Record<IntegrationClientId, string>` so typecheck forces an Aside fixture in
  Aside's own JSON shape.
- `tests/integrations-state.test.ts`: the loopback-only set.

## GUI (wp3)

Five surfaces the invariant test compares against `EXPORT_CLIENT_IDS`:
`INTEGRATION_CLIENT_IDS`, the GUI `CLIENTS` tuple, `CLIENT_LABEL_KEYS` keys,
`FILE_INTEGRATION_CLIENTS`, and the hashes in `INTEGRATION_TAB_HASHES`.

Plus three exhaustive `Record<FileIntegrationClientId, TKey>` maps that
typecheck catches: `FILE_LABEL_KEY` in `overview-clients.ts`, and
`SEMANTICS_KEY` + `TAB_LABEL_KEY` in `FileIntegrationPage.tsx`.

**The two silent hazards.** `TABS` and `FILE_CLIENTS` in
`gui/src/pages/Integrations.tsx` are NOT exhaustive records and NOT covered by
the invariant test. Omitting Aside from either leaves typecheck and the
invariants green while the tab silently does not render. wp3 asserts both in a
GUI test rather than trusting the compiler.

## i18n (wp3)

Three keys across nine locales (`en`, `de`, `fr`, `ja`, `ko`, `ru`, `tr`, `zh`,
`zh-TW`): `integrations.tab.aside`, `integrations.semantics.aside`,
`api.clientConfig.clientAside`.

"Aside" is a product name, so the tab and client labels stay English in every
locale. That means adding them to `ZH_TW_KEEP_ENGLISH` in
`gui/tests/locale-parity.test.ts` and `INTENTIONAL_ENGLISH` in
`gui/tests/fr-localization.test.ts`. The semantics string is prose and IS
translated.

## Docs (wp3)

`docs-site/.../reference/cli/agents.md` client union, flag table, and
destination table; `docs-site/.../guides/integrations.md` client table. Commit
`42adf4996` established that translated CLI reference pages are synchronized
too.

The integrations guide currently lists ten clients and omits `zcode` — a real
gap found during this research. wp3 adds the missing `zcode` row alongside
`aside` rather than leaving a known hole next to a new entry.

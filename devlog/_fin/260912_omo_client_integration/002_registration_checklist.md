# Every surface a new export client must reach, as of 2026-09-12

The Aside unit wrote this list on 2026-08-31
(`devlog/_fin/260831_aside_client_and_integrations_ux/002_registration_checklist.md`).
Two things have moved since: `tests/` was reorganised into domain directories,
and `raycast` landed as the thirteenth client, with its own app-side status block.
The table below is re-derived against the current tree by word-boundary search
for `raycast`, the freshest template.

## Backend

| file | what omo needs | how failure shows |
|---|---|---|
| `src/clients/config-export/contracts.ts` | `"omo"` in `ExportClientId` | typecheck, everywhere |
| `src/clients/config-export.ts` | `omoAgentDir`, `omoConfigPath`, `buildOmoContribution`, `EXPORT_CLIENTS.omo` | typecheck |
| `src/integrations/registry.ts` | `INTEGRATION_CLIENTS.omo` | typecheck |
| `src/cli/registry.ts` | the `export` usage union and the prose summary | no exact-list gate; `tests/cli/cli-help.test.ts` checks only a prefix of the union |
| `src/cli/help.ts:84` | the `(13 clients)` literal | `tests/cli/cli-help.test.ts:79` |

The count literal lives in `help.ts`, not `registry.ts`, hand-written on purpose
so `ocx --help` does not import the export registry.
`tests/cli/cli-help.test.ts:79` asserts it in lockstep with
`EXPORT_CLIENT_IDS.length`, so it is a focused-test obligation rather than a
cosmetic edit.

`/api/client-config` is served from `src/server/management/model-routes.ts:516`,
not `config-routes.ts` as the 2026-08-31 doc says; it reads the registry and
needs no per-client edit. `ExportClientId` likewise moved to
`src/clients/config-export/contracts.ts:84`.

`src/integrations/ownership-policy.ts`, `state.ts` and `writer.ts` need nothing:
the first is a `zcode`-only exception, and the other two read the registry.
`bun run skill:surface` is not implicated — a new `--client` value creates no
capability.

## GUI

| file | what omo needs | how failure shows |
|---|---|---|
| `gui/src/components/apikeys-workspace/client-config-clients.ts` | `CLIENTS`, `CLIENT_LABEL_KEYS`, `CLIENT_MARKS`, possibly `MONOCHROME_CLIENT_MARKS` | invariant test + typecheck |
| `gui/src/components/integration-marks.ts` | `INTEGRATION_MARKS.omo` | typecheck (exhaustive record) |
| `gui/src/pages/integrations/integration-api.ts` | `INTEGRATION_CLIENT_IDS` | invariant test |
| `gui/src/pages/integrations/integration-tabs.ts` | `TABS` and `FILE_CLIENTS` | **silent** — only `gui/tests/integrations-tab-coverage.test.ts` |
| `gui/src/pages/integrations/overview-clients.ts` | `FILE_LABEL_KEY` | typecheck |
| `gui/src/pages/integrations/FileIntegrationPage.tsx` | `SEMANTICS_KEY`, `TAB_LABEL_KEY`, `FILE_INTEGRATION_CLIENTS` | typecheck + invariant test |
| `gui/src/app-routing.ts` | `integrations/omo` hash | **silent** |
| `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,zh,zh-TW}.ts` | three keys each | `locale-parity` |

## Docs

`docs-site/src/content/docs/reference/cli/agents.md` plus `fr`, `ja`, `ko`, `ru`,
`tr`, `zh-cn`, `zh-tw`; `docs-site/src/content/docs/guides/integrations.md` plus
`fr`, `tr`, `zh-tw`.

## Tests that fail until updated

`tests/config/client-config-export.test.ts`,
`tests/config/client-config-export-new-clients.test.ts`,
`tests/gui/integrations-invariants.test.ts`,
`tests/clients/integrations-state.test.ts`,
`tests/clients/sync-client-integrations.test.ts`,
`tests/clients/integrations-merge.test.ts`,
`tests/cli/cli-export-command.test.ts`,
`tests/cli/cli-headless-parity.test.ts`,
`tests/server/management-integration-routes.test.ts`,
`tests/server/management-client-config-route.test.ts`,
`gui/tests/{client-config-panel.test.tsx,integrations-api.test.ts,integrations-overview-rows.test.ts,integration-marks.test.ts,client-marks-assets.test.ts,locale-parity.test.ts,fr-localization.test.ts,integrations-tab-coverage.test.ts}`.

Of these, the ones verified to hardcode a list or a count are:
`tests/config/client-config-export.test.ts:812` (ordered thirteen ids),
`tests/config/client-config-export-new-clients.test.ts:68` and
`tests/clients/integrations-state.test.ts:799` (loopback-only set),
`tests/gui/integrations-invariants.test.ts:94` (`toHaveLength(13)`, plus the
typechecked `SEED` record), `tests/cli/cli-help.test.ts:79` (the client count),
`gui/tests/integrations-api.test.ts:20` and
`gui/tests/client-config-panel.test.tsx:174` (GUI literals), and
`gui/tests/integrations-overview-rows.test.ts:293` (row count 18 to 19 — the
overview carries five non-file rows on top of the clients).

`gui/tests/integrations-tab-coverage.test.ts` still exists and still reads
`TABS`, `FILE_CLIENTS` and the routable hashes, so the 2026-08-31 silent hole is
covered — conditional on `FILE_INTEGRATION_CLIENTS` being updated, since that is
what the coverage test compares against.

## New files

`tests/clients/omo-client.test.ts` needs an entry in both
`scripts/test-layout/layout.json` `explicit` and
`tests/fixtures/test-layout-expected.json`, or `tests/test-layout-tooling.test.ts`
names the missing one.

The explicit entries are not optional here: the `clients` domain regex does not
match an `omo-` prefix, so the seed cannot place the file. Model the test on
`tests/clients/prime-client.test.ts` rather than the Aside one — Aside's test
lives under `providers` because of that same regex, which would be the wrong
precedent to copy.

## Deliberately not copied from the neighbours

Aside's profile machinery (`aside-profile-*`, the per-profile journal routes) and
Raycast's app-side install block and live-server export branch are client-specific
surfaces, not part of registration. omo has neither.

## One list that is a judgement, not a checklist item

There is not one owned-catalog fan-out list, there are four, and they disagree:

| call site | list | what triggers it |
|---|---|---|
| `src/integrations/catalog-refresh.ts` default, used by `model-routes.ts` | `pi, aside, raycast` | model visibility changed from the dashboard |
| `src/server/management/config-routes.ts:240` | `mcode, pi, aside, raycast` | the `/api/sync` route |
| `src/cli/dispatch.ts:455` | `mcode, pi, raycast` | `ocx sync` (Aside follows immediately through its own server owner) |
| `src/cli/index.ts` | `raycast` | proxy start, via a helper literally named `refreshOwnedRaycastCatalog` |

`prime` is in none of them. Updating one and not the others is the failure
mode, so the decision is taken here rather than in passing.

**Decision: omo joins the three general fan-outs — the `catalog-refresh`
default, `config-routes.ts`, and `dispatch.ts` — and not the fourth.** The
refresh only touches clients that are *already connected*
(`catalog-refresh.ts:10`), so this costs a user who never enables omo exactly
nothing, and it is what stops a connected omo catalog going stale the moment the
user changes model visibility. The fourth is not a general list at all: it is a
Raycast-specific startup helper, and adding an unrelated client to it would
write a file on every `ocx start` for no reason.

`tests/clients/sync-client-integrations.test.ts:68` pins the `config-routes.ts`
list as source text and moves with it.

That `prime` is in no list looks like an oversight from when it landed. Fixing
it is not this unit's business; it is recorded here so the next person does not
read prime's absence as a deliberate pattern to copy.

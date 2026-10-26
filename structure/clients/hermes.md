# Hermes Profiles

Hermes follows the shared [client-integration ownership contract](integrations.md); this page records
only how a Hermes profile is selected and owned.

## Profile discovery

Hermes keeps one home per profile. The default profile is the home OpenCodex has always written:
`HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes` (`hermesHomeDir` in
`src/clients/config-export.ts`). A named profile is `<root>/profiles/<name>/` with its own
`config.yaml`, and Hermes runs it with `HERMES_HOME` set to that directory.

`src/integrations/hermes-profiles.ts` mirrors Hermes' own rules (NousResearch/hermes-agent
`hermes_constants.py`). `hermesRootDir` derives the root as `_hermes_root_of` does: no override, or an
override inside the platform home, means the platform home; `<root>/profiles/<name>` means `<root>`; any
other override is its own root. `listHermesProfiles` lists the default profile first, then every directory
under `<root>/profiles` whose name matches `^[a-z0-9][a-z0-9_-]{0,63}$`, is not `default`, carries one
of Hermes' identity markers (`config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json`, `state.db`)
and has no `profiles/.deleted/<name>` tombstone. A symbolic link or junction, as the `profiles` directory
or as a profile, is never listed. A profile whose home is the default home (`HERMES_HOME` pointed at a
profile) is listed once, as the default.

## Selection and ownership

A management request selects a profile with `profile=<name>` on `/api/client-integrations/hermes`, or
with `client=hermes&profile=<name>` on the journal, preview, restore and restore-preview paths.
`GET /api/client-integrations/hermes/profiles` lists every profile with its own state.
`src/server/management/hermes-profile-routes.ts` resolves the selector into a request scope and removes
it before the generic routes in `src/server/management/integration-routes.ts` run, so no Aside handler
reads a Hermes name as an Aside account id. A scoped request, `profile=default` included, skips every
Aside delegation, and its history, restore and delete see only Hermes operations. Without a selector,
or with `profile=default`, the default profile, the root ownership store and the default paths are used
exactly as before.

Each named profile owns `<integrations>/hermes-profiles/<name>/`: its own records, journal and snapshots.
The generic writer runs unchanged with that store, an explicit target (`resolvedPaths`) and
`HERMES_HOME` set to the profile home. Only `providers.opencodex` is written; the profile's
`model.default` and other providers stay as they are. Mutation-flight keys carry the profile name, so a
second profile is busy while another profile's write is in flight, never joined to it.

`hermesProfileBoundary` pins the `profiles` directory and the profile home by device and inode when the
scope is created. `guardedHermesProfileStore` re-checks it synchronously on every store access, and the
writer re-checks it immediately before any write: apply, overwrite and disable through the synchronous
`guard`, restore through `restoreGuard` (restore ignores `guard`, the background-refresh admission
hook, in `src/integrations/writer.ts`). It refuses a directory replaced by a link or junction, a
profile tombstoned meanwhile, a linked ownership store, and an existing record naming a different
`config.yaml`. The last rule keeps a same-named profile under a different Hermes root from taking over
ownership after `HERMES_HOME` moves: it reports `hermes_profile_owner_mismatch` until the profile is
disconnected under its original home.

`src/cli/uninstall-integrations.ts` reads every Hermes profile store before any mutation and disables
each owned profile through the same coordinated writer; a record must name
`.../profiles/<store name>/config.yaml`, and a store naming another client refuses the cleanup.

Hermes has no automatic catalog refresh, for the default profile or any other; a stale profile is
updated by an explicit Apply. The unscoped journal lists the root store only, so named-profile history
is read and undone from that profile's page. The CLI has no profile selector.
`tests/clients/hermes-profile-routes.test.ts` and `tests/clients/hermes-profiles.test.ts` cover
discovery, scoping, journal and undo isolation, plan binding, flights, ownership moves, junction swaps
and uninstall.

# 010 — Phase 1 (hermes_profiles)

## MODIFY / NEW / DELETE map

### NEW src/integrations/hermes-profiles.ts

- `HERMES_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/` (Hermes PROFILE_ID_RE),
  `HERMES_DEFAULT_PROFILE = "default"`, identity markers as Hermes.
- `hermesRootDir(env, home)`: Hermes `_hermes_root_of` over OpenCodex's existing native home:
  HERMES_HOME unset -> native; HERMES_HOME inside native -> native; parent named `profiles`
  -> grandparent; else HERMES_HOME.
- `listHermesProfiles(env, home)`: `{ name: "default", home: hermesHomeDir(env, home) }` followed by
  named profiles under `<root>/profiles`: real directory (lstat, never a symbolic link or
  junction), name matches the id grammar and is not `default`, carries an identity marker, no
  tombstone, and does not resolve to the default home (HERMES_HOME pointing at a profile already
  makes it the default target). Sorted by name. Missing root -> default only.
- `resolveHermesProfile(name, env, home)`: `HermesProfileError` 400 for an invalid name,
  404 when it is not a listed profile.
- `hermesProfileStore(root, name)` at `<integrations>/hermes-profiles/<name>`;
  `listHermesProfileStores(root)` enumerates persisted child stores (uninstall), refusing names
  outside the grammar.
- `hermesProfileEnv(profile, env)`: `{ ...env, HERMES_HOME: profile.home }` — how Hermes itself
  selects a profile; registry/writer/state then resolve that profile's config.yaml.

### NEW src/server/management/hermes-profile-routes.ts

- `GET /api/client-integrations/hermes/profiles` -> `{ profiles: [IntegrationStatus & { hermesProfile }] }`.
- `scopeHermesProfileRequest(ctx, ...)`: when `profile` is present and the request is
  `/api/client-integrations/hermes` or a history path with `client=hermes` (`journal`, `preview`,
  `restore`, `restore/preview`), validate and resolve the profile, register `{ profile, store, env }`
  per Request, and return a ctx whose URL drops `profile`/`client` so the Aside handlers never
  interpret a Hermes name. `profile=default` leaves the root scope. Errors -> 400/404 JSON.

### MODIFY src/server/management/integration-routes.ts

- `integrationStore(ctx?)` and `pathOverrides(ctx?)` consult the request scope; generic call sites
  pass `ctx`. Aside options keep the root store.
- Call the profile list route and the scope resolver at the top of `handleIntegrationRoutes`.
- Scoped preview requires body `clientId: "hermes"`; scoped GET echoes `hermesProfile`.

### MODIFY src/cli/uninstall-integrations.ts

- Read every Hermes child store strictly before mutation; a child naming another client
  refuses. `resolvedPaths` from the record (must be `.../profiles/<store name>/config.yaml`),
  disable through the same coordinated writer; final emptiness check includes Hermes children.

### GUI

- `integration-api.ts`: `hermesProfile?: string` scope on state, journal, preview, restore
  preview, toggle, restore, delete; `loadHermesProfiles`.
- NEW `HermesProfilesPage.tsx`: profile list with state badges; selecting one renders
  `FileIntegrationPage` scoped to it (switch, overwrite, history, undo).
- `FileIntegrationPage.tsx`, `RestoreDialog.tsx`: pass `hermesProfile` through.
- `Integrations.tsx`: Hermes tab renders `HermesProfilesPage`. i18n keys in every locale.

### Docs

- `docs-site/src/content/docs/guides/integrations.md`: Hermes profiles paragraph.
- NEW `structure/clients/hermes.md` registered in `structure/manifest.json`; one pointer line in
  `structure/clients/integrations.md`.

## TESTS

- NEW `tests/clients/hermes-profiles.test.ts`: discovery (markers, tombstone, invalid names,
  symlink refusal, HERMES_HOME-at-profile exclusion, LOCALAPPDATA root), root derivation.
- NEW `tests/clients/hermes-profile-routes.test.ts`: the regression — apply with `?profile=coder`
  writes `profiles/coder/config.yaml`, leaves default untouched, records ownership in
  `hermes-profiles/coder`; journal scoping, restore (undo) and disable per profile; invalid or
  missing profile 400/404; default selection unchanged; uninstall disables profile ownership.

## Verification (C)

- `bun test tests/clients/hermes-profiles.test.ts tests/clients/hermes-profile-routes.test.ts` (red on dev, then green)
- `bun test tests/server/management-integration-routes.test.ts tests/cli/uninstall.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`
- `bun run typecheck`, `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`,
  `bun run lint:gui`, GUI tests, docs-site build. Exit 0 each.

## A-round 1 (FAIL, 4 blockers) — resolutions

1. Flight join (accepted): `scopedFlightKey` prefixes named-profile flight keys with
   `hermes-profile:<name>:`; default keeps `apply`/`disable`/`restore:...`. Named/named and
   named/default concurrent writes return `integration_mutation_busy`. Test: "a second profile is busy...".
2. Aside fallback (accepted): only `profile` is stripped; `client=hermes` stays. Every scoped request,
   `profile=default` included, registers a scope, and the generic routes skip
   `asideJournalResponse`, `asideRestoreResponse` and `asideJournalDeleteResponse` for it;
   `outsideHermesScope` 404s any non-Hermes operation in restore, restore preview and delete, and a
   scoped preview must name `clientId: "hermes"`. Test: foreign pi and Aside op ids, both scopes.
3. Root move (accepted): `hermesProfileBoundary` refuses (`hermes_profile_owner_mismatch`, 409) when the
   child store's record names another config.yaml — at scope creation and again in the writer's
   synchronous `guard` (restore: last step of `revalidate`). The list reports such a profile `unsafe`.
   Test: two roots, same profile name, apply/overwrite/disable all refused, original record retained.
4. Filesystem boundary (accepted, proportionate): the boundary pins `profiles/` and the profile home by
   `dev:ino` and refuses links/junctions, a tombstone appearing, and a linked store root or store
   parent, immediately before the write. Discovery never lists links/junctions. Uninstall reads
   records strictly and checks the `profiles/<store name>/config.yaml` shape. Test: junctioned profile
   not offered; profile swapped for a junction inside the flight is refused with no write.
5. Unscoped history (contract, not aggregated): the unscoped journal lists the root store only;
   named-profile history is read/undone from that profile's page. Documented in structure/clients/hermes.md.
6. GUI keys (accepted): `hermesProfile` is part of the remount key, resource/session cache keys, callback
   deps, and the response identity check (`status.hermesProfile === hermesProfile`).
7. Gates (accepted): layout shard + expected fixture registered; structure INDEX regenerated.

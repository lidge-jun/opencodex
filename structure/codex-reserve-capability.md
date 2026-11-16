# Luna Reserve Capability

`codexReserveEnabled` decides Luna Reserve compatibility; `codexDesktopAuthless` no longer does.
`src/config/reserve-capability.ts` owns the field, its one-time seed and the read
`isCodexReserveEnabled`. The catalog (`isEffectiveCodexReserve`) and request authorization
(`isCodexReserveRequestEligible`) in `src/codex/loopback-target.ts` both read that one predicate,
then apply their own role and listener checks; receiving-listener admission stays the request authority.

The seed copies the legacy authless value once and records `codexReserveMigration`. Every whole-config
writer projects it through `projectPersistedConfigMigrations` (`src/config/persisted-projections.ts`)
against the persisted pre-write document, so a write that also flips authless cannot move Reserve; the
startup step (`src/server/reserve-capability-startup.ts`) persists it early and, on failure, warns and
leaves the legacy reading in place. `PUT /api/settings` seeds the live config before changing either
switch, persists an explicit `false`, refreshes the catalog when Reserve changes, and restores both
fields only if the save fails before publication; after publication it adopts the Reserve fields from the
published file. The startup step adopts the seed in place, because the
loaded object carries file-backed provenance that a copy would lose. The live writer's three-way merge keeps
another process's Reserve change rather than reapplying a stale value. After the marker exists an absent value means off, so deleting the field cannot
reinstate inheritance. Enabling the capability manufactures no permission: the credential-bound upstream
Reserve check (`src/codex/reserve-availability.ts`) still decides each request.
`tests/config/reserve-capability-migration.test.ts` covers the combinations, the writers and the route.

The request-side contract (credential-bound authorization, the refusal for an unopted `gpt-reserve`,
helper restrictions) is in [OpenAI tiers](providers/openai-tiers.md); the catalog row is in
[Catalog](catalog.md).

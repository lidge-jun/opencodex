# Luna Reserve Capability

`codexReserveEnabled` decides Luna Reserve compatibility; `codexDesktopAuthless` no longer does.
`src/config/reserve-capability.ts` owns the field, its one-time seed and the read
`isCodexReserveEnabled`. The catalog (`isEffectiveCodexReserve`) and request authorization
(`isCodexReserveRequestEligible`) in `src/codex/loopback-target.ts` both read that one predicate,
then apply their own role and listener checks; receiving-listener admission stays the request authority.

The seed copies the legacy authless value once and records `codexReserveMigration`; until then Reserve
reads authless. Every whole-config writer projects it through `projectPersistedConfigMigrations`
(`src/config/persisted-projections.ts`) against the persisted pre-write document, and records it only when
the write changes authless (seeding from the persisted value, so the change cannot move Reserve), sets
Reserve explicitly, or carries an already migrated file. Any other write leaves an unmarked document
byte-for-byte alone, which keeps unchanged-save and generation invariants. The startup step
(`src/server/reserve-capability-startup.ts`) records the seed for a file that sets authless and, on
failure, warns and leaves the legacy reading in place; a file that never set authless reads Reserve as
off and is left untouched. The remaining gap is a hand edit that adds authless to such a file before any
seed is recorded: Reserve follows it, exactly as before #4961. `PUT /api/settings` seeds the live config before changing either
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

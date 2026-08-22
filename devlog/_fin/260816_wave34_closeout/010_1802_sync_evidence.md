# 010 — #1802: prove `/api/sync` cannot clobber a hand edit, then close

Roadmap put this under "migrate every writer". The audit found the acceptance condition is **already met** on `dev`; what is missing is proof.

## Why it is already met

- `POST /api/sync` calls `loadConfig()` at the route boundary and passes that fresh object onward (`src/server/management/config-routes.ts:383`, `:390`). It does not use a stale in-memory snapshot.
- `syncModelsToCodex` writes Codex artifacts, not OpenCodex `config.json` (`src/codex/sync.ts:60`, `:153`). The reported clobber path does not exist here anymore.

## Required regression

In `tests/management-config-routes.test.ts` (or the nearest sync-owning test file):

1. Start the server so a live config is held in memory.
2. Hand-edit `config.json` on disk out of band — add a provider and change a `modelCosts` row — so the on-disk state is strictly newer than the server's snapshot.
3. `POST /api/sync`.
4. Assert the on-disk `config.json` still contains the hand-edited provider and cost row byte-for-byte.
5. Assert `loadConfig()` after the call returns those same values.

The test must fail if someone later reintroduces a cached-config read at that route, so assert against the DISK, not the response body.

## Close-out

Merge the test, then close `#1802` explaining that the 2.21.0 save-path fix plus the route-boundary `loadConfig()` already close the sync path, and that this regression now pins it.

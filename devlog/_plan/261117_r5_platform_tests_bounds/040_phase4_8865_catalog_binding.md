# wp4 — #8865: portable model_catalog_json (DEFER, design record)

Classification: DEFER. The fix is understood but changes persisted state on every install and
needs a maintainer decision; this record is what a later lane executes.

## Findings (research at the base, path:line)

- One writer funnel: `src/codex/inject/plan.ts:228-233` picks the path and calls
  `setRootModelCatalogPath` (`src/codex/inject/config-toml.ts:509`); inputs are absolute
  (`src/codex/sync.ts:279,308` via `readCodexCatalogPath`, `src/client/connect.ts:795,804,1110`,
  `src/client/route-intent-apply.ts:151` via `DEFAULT_CATALOG_PATH`). An existing relative value
  is already preserved when it resolves (`config-toml.ts:768-776`).
- Most readers resolve against the Codex home (`src/codex/paths.ts:199-233`,
  `catalog-admission.ts:171-176`, `native-residue.ts:244-256`). Ownership is basename-only
  (`config-toml.ts:602-604`), so a relative value stays "ours".
- Breaks if the journal records a relative path: `src/codex/catalog/restore.ts:76` passes
  `injectedCatalogPath` raw to `readCatalog` and `catalogBackupPathFor` (cwd-relative);
  `src/codex/inject/restore.ts:742,854` publish the raw path and `catalog-self-heal.ts:252-274`
  stat-compares it. `journal-config-restore.ts:160-175` compares raw strings, so a mixed
  absolute/relative pair loses the exact preimage and falls back to the owned-fields strip.
- Upstream: `model_catalog_json` arrived as `Option<AbsolutePathBuf>` in openai/codex #12101
  (rust-v0.105.0), after relative resolution against the config base landed in #7796
  (rust-v0.67.0). Every release that reads the key resolves a relative value against
  CODEX_HOME; older releases ignore the key.

## Design to execute

1. `config-toml.ts`: `portableOwnedCatalogPath(value, home)` returns `basename(value)` when the
   value is absolute, owned, and `dirname(value)` is the same directory as `home` (`samePath` on
   Windows); otherwise the value unchanged.
2. `plan.ts:228-233`: normalize before writing the config, the profile file and the journal.
3. `catalog/restore.ts:76` and `inject/restore.ts:635,851`: resolve the journaled path against
   the owning Codex home before reading, hashing or publishing.
4. `journal-config-restore.ts:160-175`: compare `model_catalog_json` by resolved path.
5. Tests: new cases beside `tests/codex-integration/codex-inject.test.ts:401`; expectation
   updates at `codex-inject-integration.test.ts:861`,
   `history-paginated-transition-destinations.test.ts:208`, `codex-restore-app-rewrite.test.ts:206`.

## Decision needed

- Platform-independent (also fixes OpenCodex-in-WSL writing `/mnt/c/...` for Windows Codex) or
  win32-only.
- Migration of journals that recorded absolute paths, and the write-coordination token
  (`catalogPath` is hashed) differing between versions during an upgrade.


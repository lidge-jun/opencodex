# WP0 plan — catalog erosion: test isolation + per-provider preservation

Date: 2026-07-02
Status: P complete (root cause live-confirmed); B dispatch pending.

## Root cause (confirmed)

Every `bun test ./tests/` run rewrites the REAL `~/.codex/opencodex-catalog.json`
with test fixtures, dropping all real routed entries (cursor/*, xai/*, ...):

- `tests/server-auth.test.ts` (~:576-700) boots the real server with a test
  config (`providers: { openai: { models: ["wide-model", ...] }, other:
  { models: ["other-model"], ... } }`) and POSTs
  `/api/provider-context-caps`.
- That endpoint calls `save(config)` then `refreshCodexCatalogBestEffort()`
  (`src/server.ts:1779/1793`) → `syncCatalogModels(testConfig)`
  (`src/codex-catalog.ts:873`) → `atomicWriteFile(catalogPath, ...)`.
- `readCodexCatalogPath()` resolves via CODEX_HOME/`~/.codex/config.toml`; the
  test overrides only `OPENCODEX_HOME`, NOT `CODEX_HOME` → the write hits the
  user's real catalog.
- The empty-gather preservation guard in `mergeCatalogEntriesForSync`
  (`src/codex-catalog.ts` "routed model fetch returned empty; preserving ...")
  is bypassed because the test gather returns 2 routed entries
  (`openai/wide-model`, `other/other-model`) — exactly the foreign slugs found
  in the eroded on-disk catalog (mtimes 15:25 / 15:59:20 / 16:16:59 today, each
  matching a `bun test` run by the main session or an investigation agent).
- Consequences of an eroded catalog (live-proven + S4 codex-rs source facts):
  fallback metadata (`models-manager/src/model_info.rs:66-103`) sets
  `apply_patch_tool_type = None` (no apply_patch tool), **`supports_parallel_
  tool_calls = false`** (no batching — explains the observed "3 calls then 7"
  split behavior), `shell_type = Default`, ctx 272000. Warning emitted at
  `core/src/session/turn_context.rs:736-743`.
- The 400 "not supported when using Codex with a ChatGPT account" is NOT a
  local codex-rs catalog check — codex maps any HTTP 400 body through
  `CodexErr::InvalidRequest` verbatim (`codex-api/src/api_bridge.rs:59-78`).
  The 400 originated upstream of the CLI (ocx or its routed backend);
  acceptance must re-verify the 400 disappears with a healthy catalog and, if
  not, trace ocx's routing for the eroded-catalog case separately.

## Fix (two layers, both required)

### Layer 1 — test isolation (stop writing the real file)

- MODIFY `tests/server-auth.test.ts`: set `CODEX_HOME` to a per-test temp dir
  (mirroring `tests/codex-catalog-sync-hardening.test.ts:13,36-37`) for every
  test that boots the server or can reach `refreshCodexCatalogBestEffort`.
  Since these tests run in-process (not subprocess), set/restore
  `process.env.CODEX_HOME` in beforeEach/afterEach alongside the existing
  OPENCODEX_HOME handling.
- AUDIT all other tests that boot the server request handler or call
  config-mutating endpoints (`/api/providers`, `/api/provider-context-caps`,
  `/api/models` etc.) for the same gap; apply the same isolation. Candidates:
  every test importing the server or hitting `server.url`.
- Consider a shared helper (tests/helpers or inline) `withIsolatedCodexHome()`
  to prevent recurrence.

### Layer 2 — per-provider preservation in sync (defense in depth)

- MODIFY `src/codex-catalog.ts` `syncCatalogModels`/`mergeCatalogEntriesForSync`:
  preserve existing on-disk routed entries whose provider prefix is NOT among
  the providers the current gather attempted (i.e., providers absent from
  `config.providers` or disabled). A sync from a config that has never heard of
  `cursor` must not delete on-disk `cursor/*` rows. Keep the existing behavior
  of replacing/updating entries for providers that WERE gathered (including
  removing models genuinely gone from that provider).
  - Implementation sketch: pass the set of gathered provider names into
    `mergeCatalogEntriesForSync`; final routed list = fresh entries for
    gathered providers + preserved on-disk entries for non-gathered providers
    (dedup by slug; fresh wins).
  - Keep the existing all-empty guard as-is.
- This also covers the real-world multi-profile clobber case (another ocx
  profile/config syncing the shared catalog path).

### Tests

- New/extended: `tests/codex-catalog-sync-hardening.test.ts` — a sync whose
  config lacks provider X preserves existing on-disk `X/*` entries; a sync
  whose config HAS provider X replaces X's entries; all-empty guard unchanged.
- server-auth tests: assert the real path is untouched (or simply rely on
  CODEX_HOME isolation + a regression test that `readCodexCatalogPath()`
  honors CODEX_HOME).
- Full suite + tsc; then verify live that `bun test ./tests/` no longer
  modifies `~/.codex/opencodex-catalog.json` (mtime/content unchanged), and
  `ocx sync` still adds 18 cursor entries.

## Acceptance

- `bun test ./tests/` leaves the real catalog byte-identical.
- A sync from a cursor-less config preserves cursor entries on disk.
- `cursor/composer-2.5` keeps `apply_patch_tool_type: freeform` across test
  runs and profile syncs; no more fallback-metadata warnings or ChatGPT-auth
  400s after test runs.

## Implementation pass

Date: 2026-07-02

### `src/codex-catalog.ts`

Changes:
- `readCodexCatalogPath()` now resolves `CODEX_HOME` at call time, including
  `realpathSync.native` normalization to match `src/codex-paths.ts` backup IDs.
- Catalog/cache reads inside this module now use the active `CODEX_HOME`
  catalog and models-cache paths instead of stale import-time constants.
- `syncCatalogModels()` computes active gathered provider names from
  `config.providers` minus disabled providers and passes them into
  `mergeCatalogEntriesForSync()`.
- `mergeCatalogEntriesForSync()` keeps the existing all-empty routed-fetch
  guard, and otherwise merges fresh routed rows with preserved on-disk routed
  rows whose provider prefix was not gathered. Fresh slugs win.

Impact:
- In-process tests can isolate catalog writes by setting `process.env.CODEX_HOME`
  after module import.
- Syncs from a partial provider config no longer erase routed rows for providers
  absent from that config.
- Routed providers that expose native-looking IDs still keep native OpenAI rows
  via the existing `goIds`/native-backfill path.

Verification:
- `bun test tests/codex-catalog-sync-hardening.test.ts tests/codex-catalog.test.ts tests/codex-catalog-restore.test.ts tests/codex-refresh.test.ts`
  → `52 pass`, `0 fail`.
- `bun x tsc --noEmit --pretty false` → clean.

### `tests/helpers/isolated-codex-home.ts`

Changes:
- Added a shared `installIsolatedCodexHome()` test helper that creates a fresh
  temp `CODEX_HOME`, writes a minimal `config.toml`, sets the env var, and
  restores/removes it after the test.

Impact:
- Server tests that import modules before hooks can still direct catalog lookup
  to an isolated temp home once `src/codex-catalog.ts` resolves paths at call
  time.

Verification:
- Covered through `tests/server-auth.test.ts` and `tests/api-usage.test.ts`
  setup paths during the required focused/full-suite runs.

### `tests/server-auth.test.ts`

Changes:
- Added per-test isolated `CODEX_HOME` setup/teardown alongside the existing
  `OPENCODEX_HOME` restoration.

Impact:
- Provider-management and provider-context-cap tests no longer point catalog
  refreshes at the real `~/.codex` catalog.

Verification:
- Required focused command ran the file but this sandbox cannot bind loopback
  sockets: `59 pass`, `26 fail`, with failures from `Bun.serve({ port: 0 })`
  reporting `EADDRINUSE`.

### `tests/api-usage.test.ts`

Changes:
- Added the same per-test isolated `CODEX_HOME` helper because the file boots
  the server request handler.

Impact:
- The audited server-booting test file no longer inherits the user's real
  Codex home during server startup.

Verification:
- Full suite ran the file but this sandbox cannot bind loopback sockets; its
  failures are the same `Bun.serve({ port: 0 })` `EADDRINUSE` class.

### `tests/codex-catalog-sync-hardening.test.ts`

Changes:
- Added a routed-entry helper and regression coverage for:
  a cursor-less sync preserving existing `cursor/*` rows while replacing
  gathered-provider rows;
  a cursor-present sync replacing stale `cursor/*` rows while preserving
  other-provider rows;
  the all-empty guard warning/preservation path;
  `readCodexCatalogPath()` honoring a changed `CODEX_HOME` at call time.

Impact:
- The two-layer fix is covered in subprocesses that set `CODEX_HOME` before
  requiring catalog code and also mutate `CODEX_HOME` after import.

Verification:
- `bun test tests/codex-catalog-sync-hardening.test.ts` → `5 pass`, `0 fail`.

### `devlog/_plan/260702_cursor-live-stability-rca/20_wp0-catalog-erosion-fix-plan.md`

Changes:
- Appended this implementation pass.

Impact:
- Records the implementation surface, verification evidence, and sandbox
  limitation for the next agent/human reader.

Verification:
- `git diff --check` → clean.
- Real catalog before/after final full-suite run:
  `stat -f "%Sm"` stayed `Jul  2 20:41:40 2026`;
  `shasum` stayed
  `7be0d990236deda2c409b608942159cdb4f62a5c  /Users/jun/.codex/opencodex-catalog.json`.

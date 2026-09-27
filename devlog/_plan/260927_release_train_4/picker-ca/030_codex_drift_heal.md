# 030 — B10 drift heal cancellation boundary

Depends on: `000_plan.md`. Work phase `wp3`, class C4 because it governs a background write into Codex configuration. The source change stays in `src/codex/catalog-auto-refresh.ts` and its tests.

## File changes (diff-level)

| Path | Change | Before → after |
| --- | --- | --- |
| `src/codex/catalog-auto-refresh.ts` | MODIFY | `healCodexConfigDrift(config)` calls `syncModelsToCodex` with the tick's stale snapshot, awaits provider discovery, and checks `generation` only later → call `injectCodexConfig` directly for missing injected URL root keys. Read `JOURNAL_PATH` with a **bounded, read-only** regular-file/JSON check and obtain its version-1 `injectedCatalogPath` without calling the mutating `journaledInjectedCatalogPath()` helper. Resolve a relative path against the Codex config home; accept only a readable regular catalog whose JSON parses as a catalog, otherwise try the current catalog path with the same test, otherwise pass `null`. Pass `lockTimeoutMs: TICK_DEADLINE_MS` and a synchronous `beforeClientWrite` guard. The guard checks captured timer generation and persisted config at the actual write boundary. A stale or stopped tick defers the heal without a catalog/cache write. Keep post-inject on-disk drift as the sole basis for `healed`. |
| `tests/codex-integration/catalog-auto-refresh-scheduler.test.ts` | MODIFY | Existing heal tests mock full sync and see only the requested port/log → assert direct injector options include the 1-second lock wait and commit guard; stop/restart or persist OFF/new picker order while a deferred injector is waiting, then invoke its guard and prove no stale write/log. A successful on-generation injection is reported healed only after the root key is observed. The ordinary catalog-only converge path remains unchanged. |

## Boundary and activation

The 1-second constant already documents a **commit-lock wait**, not a whole-tick deadline (`src/codex/catalog-auto-refresh.ts:27`; `src/codex/convergence.ts:640`). This phase does not claim a 1-second limit on configuration preparation. `syncModelsToCodex` has no cancellation or deadline option and can perform provider discovery before injection (`src/codex/sync.ts:99,256`); a post-await generation check cannot revoke those writes. A direct config injector already accepts `beforeClientWrite` and `lockTimeoutMs` (`src/codex/inject.ts:98-123`) and checks the guard under its write coordination (`:575-584`). It therefore fits this file's write scope.

`codexConfigDrift` detects a missing journaled `openai_base_url` or realtime URL, **not** catalog-only loss (`src/codex/config-drift-heal.ts:57-79`). The chosen catalog path must preserve a non-default file that the journal says the last injection selected, provided it is readable and structurally valid; the Desktop rewrite may have removed `model_catalog_json` from `config.toml`. `JOURNAL_PATH` (`src/codex/journal.ts:17`) names the file, and `resolveCodexConfigPath` (`src/codex/paths.ts:142`) resolves a relative catalog path. The existing exported path getter is unsuitable for this background observer because its default `readJournal()` removes an invalid journal (`src/codex/journal.ts:237-254`); the lane cannot modify `journal.ts`, so this helper reads only the one needed field without cleanup. A missing/invalid/unreadable journaled catalog falls back to another verified catalog or `null`, never a nonexistent file.

- Stopped generation: enter a deferred injector, call `stopCatalogAutoRefresh`, then trigger the guard and assert refusal before any stubbed write or success log.
- Changed configuration: edit persisted ON settings during the await and trigger the guard; stale values are not injected. Repeat for OFF intent. A later tick can retry from a fresh snapshot.
- External provider: a successful injector may intentionally avoid writing; recheck missing root keys and report `not-healed`, never infer success from the return value.
- Non-default catalog: persist a journaled existing path, remove `model_catalog_json` from the fixture TOML, trigger drift repair, and assert the injector receives that same path rather than the default.
- Invalid journal or path: preserve the journal bytes while the observer refuses them; reject a directory, symlink, unreadable or malformed catalog and fall back to a separately verified catalog or `null`.
- Lock contention: pass `lockTimeoutMs: 1000`, verify refusal is deferred; avoid a busy wait outside the injector.

No new persisted field or enum is introduced; creation, serialization, deserialization and consumer chains are unchanged. A synchronous guard can be bypassed by direct non-tick callers, which retain their own contracts; this phase protects only the auto-refresh drift heal. The final enforcement layer is the injector commit guard, backed by focused tests and hosted CI; process termination during a partially completed external application is outside its guarantee.

## Proof before closing this phase

Run isolated `bun test tests/codex-integration/catalog-auto-refresh-scheduler.test.ts`, relevant direct-inject/cancellation regressions, and `bun run typecheck`. Document whether any full-sync call remains reachable from the drift branch. Keep any broader stale-model race found in the catalog-only path out of this lane's source edits and report it separately.

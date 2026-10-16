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

## Results

The defect was present. The drift branch passed a captured config to `syncModelsToCodex` without a cancellation or lock-wait option (`src/codex/catalog-auto-refresh.ts`, formerly lines 58–77). Full sync can await provider discovery and write catalog/cache before injection (`src/codex/sync.ts:245–283`), while its injector calls carried neither guard nor tick deadline. A stop/restart or persisted settings edit during that await could therefore publish stale work. The plan's direct-inject approach remains the smallest correction within this lane: the drift branch now has no full-sync call (`src/codex/catalog-auto-refresh.ts:115–150`). The separate catalog-only convergence path remains unchanged and is outside this phase.

The repair selects the last journaled catalog path through a bounded read-only version-1 journal read, validates a regular catalog JSON file, and falls back to a separately validated default or `null` (`src/codex/catalog-auto-refresh.ts:51–113`). It calls `injectCodexConfig` with `lockTimeoutMs: 1000` and a synchronous generation-plus-persisted-config guard (`:126–149`). The injector evaluates that guard at its commit boundary (`src/codex/inject.ts:574–584`). The tick suppresses stale-generation reporting, and a successful heal is reported only after the missing root keys are observed on disk (`src/codex/catalog-auto-refresh.ts:149–150,205–211`). This deadline bounds lock acquisition, not all injection preparation, as the plan already specified.

Verification used a fresh isolated `HOME`, `OPENCODEX_HOME`, `CODEX_HOME`, and `TMPDIR` for each Bun command:

- `bun test tests/codex-integration/catalog-auto-refresh-scheduler.test.ts`: 16 pass, 0 fail on the final run. The tests cover stopped/restarted generations, changed ON/OFF settings during a deferred injector, the 1000 ms option, a child-process check that the injector receives the journaled non-default catalog, invalid journal byte preservation, and on-disk heal observation. The direct-inject assertions and full-sync refusal would fail against the old branch. An intermediate run had 15 pass / 1 fail because the test expected `/var` while the Codex-home resolver canonicalized the macOS temp path to `/private/var`; the assertion now compares canonical paths.
- `bun test tests/codex-integration/catalog-auto-refresh-scheduler.test.ts tests/codex-integration/codex-config-drift-heal.test.ts tests/codex-integration/codex-inject-write-lock.test.ts tests/codex-integration/codex-sync-api.test.ts tests/codex-integration/codex-sync-response.test.ts tests/codex-integration/client-injection-guard.test.ts`: 75 pass, 0 fail. This run preceded the final on-disk assertion refinement; the focused suite was rerun afterward.
- `bun test tests/codex-integration/codex-inject.test.ts tests/codex-integration/codex-inject-integration.test.ts`: 160 pass, 0 fail.
- `bun run typecheck`: exit 0, rerun after the final test edit.

The source-ownership map lists `structure/config.md` for `src/codex/` (`structure/INDEX.md:121`), and its scheduler paragraph at `structure/config.md:584` should be updated by the coordinator; that file is outside this lane's write scope.

PR review follow-up: when neither the journaled nor default catalog is usable, drift healing now defers injection and leaves the missing routing roots in place. Catalog-only convergence may create the catalog in that tick, and the next tick retries injection with the new path. The new two-tick regression failed before the fix and passes afterward; isolated scheduler tests passed 19/19, test-layout and file-size ratchet tests passed 27/27, and `bun run typecheck` passed.

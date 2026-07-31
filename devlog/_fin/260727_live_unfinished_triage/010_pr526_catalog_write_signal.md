# 010 — PR #526 processing plan

Item: PR #526, `fix(codex): report whether a sync actually wrote the catalog or cache`.

Planned bucket: `takeover-fix/rebase+tests` after independent review.

Audit update:

- Sol review checked head `1ba588eff663a5be846a8723b90a452dca8cd04c`.
- GitHub reported `MERGEABLE/CLEAN` with passed checks, but the PR branch is far
  behind current `dev`; the checks predate `origin/dev@7fcaa9119`.
- The review also found that `tests/codex-refresh.test.ts` mocks the new boolean
  outcomes, while the real filesystem write/missing/malformed/unwritable paths in
  `src/codex/catalog/sync.ts` still need direct regression coverage.

Scope IN:

- Re-read PR #526 diff against current `dev`.
- Confirm head `1ba588ef`, base `dev`, merge state `MERGEABLE/CLEAN`.
- Confirm CI/checks are success on the current head.
- Inspect changed paths:
  - `src/codex/catalog/sync.ts`
  - `src/codex/refresh.ts`
  - `src/codex/sync.ts`
  - `tests/codex-refresh.test.ts`
  - `tests/codex-sync-api.test.ts`
  - `tests/injection-model-api.test.ts`
- Rebase/refresh tests first; merge only after current-head checks and direct
  write-path coverage are present.

Planned takeover delta:

- Rebase same-repo branch `codex/catalog-written-signal` onto `origin/dev@7fcaa9119`.
- Add direct real-filesystem coverage in `tests/codex-refresh.test.ts` only:
  - valid `opencodex-catalog.json` is rewritten by `syncCatalogModels()` and reports
    `catalogWritten: true`;
  - malformed default catalog is recovered from the runtime catalog and reports
    `catalogWritten: true`;
  - `invalidateCodexModelsCache()` writes the real `models_cache.json` wrapper shape;
  - missing/malformed catalog and unwritable cache-file destination return
    `cacheSynced`/cache write false without creating a false success.
- Keep production code unchanged unless the new tests reveal a real defect.

Scope OUT:

- Do not merge PR #527 in the same work-phase.
- Do not add restart/process-kill behavior here.
- Do not close issue #476 until #527 is handled or the issue scope is narrowed.

Verification:

- `gh pr view 526 --json ...`
- independent Sol review verdict
- targeted test:
  `bun test tests/codex-refresh.test.ts tests/codex-sync-api.test.ts tests/injection-model-api.test.ts`
- push/check/merge URL or blocker comment URL

Execution update:

- Rebased same-repo branch `codex/catalog-written-signal` onto
  `origin/dev@7fcaa9119253d010393cb457427a2868cd935718`.
- Added direct real-filesystem coverage in `tests/codex-refresh.test.ts`.
- Pushed `43d0efff4569711ed192e09d4d87b62fc803153c` to
  `origin/codex/catalog-written-signal`.
- Local pre-push passed:
  - `bun run typecheck`
  - `bun run lint:gui`
  - `bun run test` — 5051 pass, 0 fail, 24881 assertions
  - `bun scripts/privacy-scan.ts`
  - `bun scripts/doctor-gui-if-changed.ts`
- Hosted blocker: GitHub `Issue quality tests / test` failed before tests during
  checkout cleanup:
  `fatal: No url found for submodule path 'devlog/_chase/_cca' in .gitmodules`.
- Live dev baseline has the same inconsistent gitlinks:
  `origin/dev@7fcaa9119` tracks `devlog/_chase/_cca` and
  `devlog/_chase/_litellm` as `160000` gitlinks while `.gitmodules` has no
  mapping. Treat this as a separate dev baseline CI repair before merging #526.

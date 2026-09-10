# 020 — fsync handles, responses-state fixtures, bump CLI path (signatures C1, D, E) + Windows dispatch

Branch `codex/win-fsync-fixtures` on top of 010.

## C1 — read-only fsync (product)

- `src/lib/service-secrets.ts:68` `fsyncRegularFile`: `openSync(path, "r+")`.
- `src/responses/spill-store.ts:387,425`: the copied destination reopened for fsync uses `"r+"`.
- Existing contract test `tests/codex-transition-state-adoption.test.ts:73` already documents the
  Windows rule; add one assertion in `tests/service-secrets.test.ts` that the handle mode is
  writable (spy `openSync`).

## D — responses-state fixtures (harness)

- Generic spill/admission describe blocks: fixture platform `"linux"` so they exercise the sync
  lane; `spill-store.ts::harden` must consult `windowsSecretAclApplies()` consistently.
- Dedicated Windows cases stay `"win32"` and `await flushPendingResponseSpillsForTests()` before
  settled-state assertions.
- `tests/responses-state.test.ts:1277`: inject sync+async principal runners like
  `tests/helpers/responses-state-never-settling-acl-child.ts:44`; move `release()` into a
  `finally` that covers every await after gate creation (this is what wedged :1328 for 60 s).

## E — bump CLI (harness)

`tests/bump-dev-version.test.ts:15`: `fileURLToPath(new URL(...))`, spawn `process.execPath`,
include stderr in the failure message, and make the malformed case assert the specific stderr.

## fuck-powershell

- `cases/env-paths/fsync-readonly-handle-eperm.md`
- `cases/env-paths/file-url-pathname-drive-slash.md`

## Gate

Push both branches, open PRs, then `gh workflow run ci.yml --ref codex/win-dispatch-<sha>` on an
immutable ref of the stacked head. Required: windows 1/4..4/4 SUCCESS. Iterate on failures from
the exact-head logs; never loosen an assertion.

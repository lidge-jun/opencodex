# 010 — Config-dir ACL hardening must be part of the shutdown contract (signatures A, B, G)

Branch `codex/win-acl-lifecycle` off origin/dev.

## src

- `src/config/paths.ts`: promote the test-only flush to `flushConfigDirHardening(configDir: string): Promise<void>`
  that awaits the in-flight entry for that exact directory (no-op when none). Keep the existing
  test helper as a thin wrapper.
- `src/server/index.ts` `startServer`: capture the effective config dir before `loadConfig()`;
  in the composite `server.stop` finalizer (~2312) await `flushConfigDirHardening(dir)` after the
  listeners close, before returning.
- Test: `tests/server-stop-config-hardening.test.ts` — `setPlatformForTests("win32")` (otherwise
  `windowsSecretAclApplies()` at `windows-secret-acl.ts:469` is false and no flight starts), inject
  a controllable async icacls runner via `setAsyncIcaclsRunnerForTests` plus a principal resolver,
  start a server, call `stop(true)`, assert it stays pending until the runner settles, then
  resolves. Every seam restore and the gate release live in `finally` so an assertion failure
  cannot wedge cleanup.

## tests (harness)

Replace recursive `rmSync` with `removeTreeWithRetry` (`tests/helpers/remove-tree.ts`) at:
codex-account-store:37,44,1231,1238; codex-auth-api:259,296; oauth-status-privacy:33,42;
server-kiro-completion-e2e:39; claude-native-passthrough:28; api-usage:103; vision-sidecar-e2e:45;
oauth-login-cli-live-update:57; loopback-listener-integration:109; chat-completions-endpoint:78;
account-pool-management-api:178; claude-messages-endpoint:67; oauth-accounts-api:64;
server-live:37,61; data-plane-admission-identity:232.

`tests/codex-account-store.test.ts`: stub AND restore `setAsyncIcaclsRunnerForTests` alongside the
sync stub; use per-test `mkdtempSync` instead of the fixed repo-local `TEST_DIR` so one failure
cannot poison the rest of the file.

## fuck-powershell

`cases/env-paths/async-child-holds-dir-after-stop.md`: Symptom = rmSync EPERM/EBUSY right after a
clean `server.stop()`; Cause = fire-and-forget `icacls.exe` child + mandatory locking; Workaround =
shutdown contract owns every spawned child; retry-on-EPERM only as a harness fallback.

## Checks

    bun test tests/server-stop-config-hardening.test.ts tests/codex-account-store.test.ts tests/codex-auth-api.test.ts tests/remove-tree-helper.test.ts
    bun run typecheck

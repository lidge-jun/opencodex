# 000 — Windows CI failure inventory (windows-latest, workflow_dispatch)

Runs read: 33590540220 (ef68bd1f2, cursor stack), 33584155821 (2cb592174, regaudit),
33555110133 (af6113a03 = main). Raw logs in `.tmp/win/*.log` (gitignored). Last Windows-green
dispatch: 33290817128 on 223a0a287 (2026-08-30). Every dispatch since has failed on all branches
including `main`, so this is a regression in the range 223a0a287..dev, not the runner.

## Signatures → owning file → class

| # | Signature | Count | Owner (src) | Owner (tests) | Class |
|---|---|---|---|---|---|
| A | `EPERM rm tests/.tmp-codex-accounts-test` / `.tmp-codex-auth-api-test` | 49 / 377 | `src/config/paths.ts:31-48` (`hardenConfigDir` → unawaited `hardenSecretDirAsync`), `src/lib/windows-secret-acl.ts:345` (icacls spawn) | `tests/codex-account-store.test.ts:37,44,1231,1238`; `tests/codex-auth-api.test.ts:259,296` | product lifecycle regression (e5d588669) + harness cascade |
| B | `EBUSY rm Temp/ocx-*` after `await server.stop(true)` | ~14 suites | `src/server/index.ts:2294-2315` (`server.stop` never awaits config-dir hardening) | kiro-completion:39, claude-native:28, api-usage:103, vision-e2e:45, oauth-live:57, loopback-listener:109, chat-completions:78, pool-mgmt:178, claude-endpoint:67, oauth-accounts-api:64, server-live:37/61, data-plane-admission:232 | same root as A |
| C1 | `EPERM fsync` | 3 + 1 child | `src/lib/service-secrets.ts:68` `fsyncRegularFile` opens `"r"`; same in `src/responses/spill-store.ts:387,425` | `tests/service-secrets.test.ts:93,109,130`; `tests/client-connect.test.ts:494` (rotation child) | product portability defect |
| C2 | icacls `ETIMEDOUT` / access-denied warnings | — | `src/config.ts:2728-2742` | `tests/config.test.ts:2945,2962` inject them | NOT a failure (deliberate test output) |
| D | `Responses previous_response_id state` / `admission boundary` ~45 cases; one 60 s timeout | ~45 | `src/responses/state.ts:1024-1028,1057-1059` (Windows queues async spill) | `tests/responses-state.test.ts:821+, 1045, 1277, 1328, 3190+` | harness: generic cases assume sync lane; :1277 lacks principal-resolver injection and releases its gate outside `finally`, wedging :1328 |
| E | `dev version bump rule` ×3 exit 1 | 3 | — | `tests/bump-dev-version.test.ts:15` uses `new URL(..).pathname` (`/D:/a/...`) | harness |
| F | `config.json JSON Parse error` in ocx-overlay-review | — | — | `tests/user-cost-overlay-coderabbit-regressions.test.ts:89,147` writes `{ not json` on purpose | NOT a failure |
| G | 20-odd single failures (WS handshake, passthrough, readyz, api/usage, Cockpit import, …) | ~20 | — | see B table | all B teardown or A cascade; no independent defect |

## Mechanism (A/B)

    loadConfig()/account-store/oauth store → hardenConfigDir()
      → hardenSecretDirAsync() fire-and-forget → icacls.exe holds the dir
      → test/server finishes → rmSync() → EPERM (unlink) / EBUSY (rename)

`server.stop(true)` awaits listeners, background lifecycle and native-main, not this flight.
A flush exists (`src/config/paths.ts:53`) but is test-only. `tests/codex-account-store.test.ts`
stubs `setIcaclsRunnerForTests` only; the async runner (`setAsyncIcaclsRunnerForTests`) stays real.

## Roadmap

- 010 — A/B: production `flushConfigDirHardening(configDir)` awaited in `server.stop`; harness
  `removeTreeWithRetry` at every cleanup site; async runner stub in account-store test.
  fuck-powershell case: `env-paths/async-child-holds-dir-after-stop`.
- 020 — C1 + D + E: `"r+"` fsync handles; responses-state fixture lanes + gate `finally`;
  `fileURLToPath`. fuck-powershell cases: `env-paths/fsync-readonly-handle-eperm`,
  `env-paths/file-url-pathname-drive-slash`. Then dispatch CI on an immutable ref → Windows 1-4/4.
- 030 — regression audit main..dev (parallel reviewers), devlog record.
- 040 — promote dev → preview → main via `scripts/release.ts`; proof; bump dev.

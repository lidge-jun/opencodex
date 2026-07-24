# 040_shim_autorestore_and_discovery_status

## Objective

CLI shim auto-restore + provider discovery status exposure.

## Files

### NEW

| Path | Role |
|---|---|
| `go/internal/codex/autorestore.go` | TS `maybeAutoRestoreCodexShim` / `autoRestoreCodexShim` semantics |
| `go/internal/codex/autorestore_test.go` | restored/deferred/skipped/failure |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/cli/cli.go` | no restore in Dispatch (~L46-90) | call auto-restore before mutating commands except uninstall/install/remove |
| `go/internal/codex/shim.go` | Install/Uninstall only | export/detect helpers for replaced shim + ownership lock |
| `go/internal/config/config.go` | no enable helper or missing | add `CodexShimAutoRestoreEnabled(cfg, env) bool` (exact path if split: `go/internal/config/flags.go` only if config.go unsuitable) |
| `go/internal/management/providers.go` | GET `publicProvider` only (~L25-35) | attach discovery status when liveModels enabled |
| `go/internal/registry/cache.go` | MarkFailure private time (~L66) | `DiscoveryStatus(provider) (state, lastError redacted, cooling bool)` |
| `go/internal/management/api_test.go` | providers 200 shape | discovery field present/absent + redaction |
| `go/internal/cli/cli_test.go` | command routing | skip-restore on install/uninstall |

### DELETE

None.

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| S1 | `status` with replaced shim | temp codex path without marker + state | warn restored; marker present | `codex/autorestore_test.go` |
| S2 | `codex-shim install` | any | auto-restore skipped | `cli/cli_test.go` |
| S3 | restore error | injected fail | warn; command continues | `codex/autorestore_test.go` |
| S4 | GET /api/providers after MarkFailure | cache failure | discovery.status=error; no secrets | `management/api_test.go` |
| S5 | liveModels false | provider config | discovery omitted | `management/api_test.go` |

## Verification

```bash
cd go
go test ./internal/codex ./internal/cli ./internal/management ./internal/registry ./internal/config -count=1
go test ./... -count=1 -timeout 120s
```

## A-gate round 1 — dependency deferral

- Reviewer: Helmholtz (Sol low)
- Verdict: `FAIL` (4 High)
- Synthesis: all 4 accepted. Core chain: (1) auto-restore is materially
  under-specified — TS has two-pass probing, interprocess ownership locking,
  transactional replacement, rollback, state commit recovery, mixed-sibling
  handling (`src/codex/shim.ts:888,1043`); Go shim is single-wrapper with
  basic rename/write rollback. (2) CLI scope says "mutating commands" but TS
  runs for every command except uninstall/remove; Go CLI has no corresponding
  dispatch branches. (3) Discovery API design invents `state/lastError/cooling`
  instead of TS `{status,reason,httpStatus?}`; Go cache records only failure
  timestamps, management API has no cache reference. (4) `liveModels` uses
  built-in registry metadata, not config — S5 cannot be constructed.
- Decision: **DEPENDENCY-DEFERRED** — plan requires a complete rewrite with
  TS-exact contracts before implementation. Infrastructure work, not core
  proxy adapter parity.
- Anchors:
  - TS auto-restore: `src/codex/shim.ts:888`, `src/cli/codex-shim-autorestore.ts:18`
  - TS discovery: `src/codex/model-cache.ts:20`, `src/server/management/provider-routes.ts:72`
  - Go shim gap: `go/internal/codex/shim.go:16,105`
  - Go cache gap: `go/internal/registry/cache.go:20,59`

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

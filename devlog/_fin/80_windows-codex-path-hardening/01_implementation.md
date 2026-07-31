# 80 — Implementation Notes

## Shared Codex Path Module

`src/codex-paths.ts` centralizes all Codex-side paths:

- resolves `CODEX_HOME` according to Codex behavior;
- validates custom `CODEX_HOME` before using it;
- exports config/profile/catalog/cache paths;
- provides minimal TOML string helpers for root-level path parsing.

This removes scattered `homedir()/.codex` assumptions from config injection and catalog sync.

## Config Injection

`src/codex-inject.ts` now writes the modern shape:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://localhost:10100/v1"
wire_api = "responses"
```

Key details:

- root `model_provider` is inserted before the first TOML table;
- existing root or stale opencodex `model_provider` keys are stripped before re-injection;
- old `[profiles.opencodex]` blocks are removed;
- `$CODEX_HOME/opencodex.config.toml` is written as a standalone profile file;
- existing custom `model_catalog_json` root paths are preserved;
- the default generated catalog path comes from `DEFAULT_CATALOG_PATH`, now rooted at resolved `CODEX_HOME`.

## Catalog Sync

`src/codex-catalog.ts` now resolves the catalog path from the active Codex config, falling back to `$CODEX_HOME/opencodex-catalog.json`.

The important behavior is that cache invalidation targets:

```text
$CODEX_HOME/models_cache.json
```

instead of assuming:

```text
~/.codex/models_cache.json
```

This matters on Windows and on any machine where `CODEX_HOME` is custom.

## Service Managers

`src/service.ts` was updated for platform-specific environment preservation.

### macOS launchd

The plist includes:

- `OCX_SERVICE=1`
- `PATH`
- `CODEX_HOME` when present at install/start time

This prevents a custom Codex home from being lost when launchd starts the proxy outside the interactive shell.

### Linux systemd

The user unit includes:

- `Environment="OCX_SERVICE=1"`
- `Environment="PATH=..."`
- `Environment="CODEX_HOME=..."` when present
- append-mode service log paths

This matches the systemd user-service model added in Phase 70, but fixes the Codex-home propagation detail.

### Windows Task Scheduler

Task Scheduler runs through a generated wrapper script:

```text
~/.opencodex/opencodex-service.cmd
```

The wrapper sets:

- `OCX_SERVICE=1`
- `PATH`
- `CODEX_HOME` when present

Then it starts the Bun CLI entrypoint. This avoids relying on Task Scheduler to inherit the shell session environment.

## Windows Stop Verification

`src/cli.ts` now treats process stop as a state transition, not just a command invocation.

The stop path:

- uses `taskkill.exe` from `%SystemRoot%\System32` on Windows;
- validates PID liveness before and after termination;
- waits for process exit;
- escalates where needed on non-Windows with `SIGKILL`;
- only reports success after the process is actually gone.

This fixes false-positive "stopped" states when Task Scheduler or process termination returns before the proxy is really dead.

## Release Workflow

The release CI updates are related operational hardening:

- GitHub Releases now include commit logs;
- dry runs are version-safe and do not accidentally reuse or mutate the wrong release state;
- release metadata is better aligned with the npm version workflow.

These are not Windows-specific, but they landed in the same 80 pull window and should be kept with this phase record.

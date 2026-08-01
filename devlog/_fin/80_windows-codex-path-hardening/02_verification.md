# 80 — Verification / Regression Checklist

## Static Verification

Run from the project root:

```sh
bun run typecheck
```

Expected: TypeScript passes with no errors.

## Runtime Smoke Checks

### Default Codex Home

```sh
unset CODEX_HOME
bun run src/cli.ts sync
```

Verify:

- `~/.codex/config.toml` contains root `model_provider = "opencodex"`;
- `~/.codex/opencodex.config.toml` exists;
- `~/.codex/opencodex-catalog.json` exists;
- `~/.codex/models_cache.json` is invalidated when catalog sync changes model visibility/order.

### Custom Codex Home

```sh
mkdir -p /tmp/ocx-codex-home
CODEX_HOME=/tmp/ocx-codex-home bun run src/cli.ts sync
```

Verify:

- writes go to `/tmp/ocx-codex-home`;
- no new opencodex config/catalog/cache files are written to the default `~/.codex`;
- profile fallback file is `/tmp/ocx-codex-home/opencodex.config.toml`.

## Platform Service Checks

### macOS

```sh
CODEX_HOME=/tmp/ocx-codex-home bun run src/cli.ts service install
plutil -p ~/Library/LaunchAgents/com.opencodex.proxy.plist
```

Verify:

- `EnvironmentVariables.CODEX_HOME` is present when installed with `CODEX_HOME`;
- `OCX_SERVICE=1` is present;
- proxy starts and `bun run src/cli.ts status` reports a live PID.

### Linux

```sh
CODEX_HOME=/tmp/ocx-codex-home bun run src/cli.ts service install
systemctl --user cat opencodex-proxy.service
```

Verify:

- unit contains `Environment="CODEX_HOME=/tmp/ocx-codex-home"`;
- unit contains `Environment="OCX_SERVICE=1"`;
- logs append to the opencodex config log path;
- `systemctl --user status opencodex-proxy.service` is active.

### Windows

```powershell
$env:CODEX_HOME = "$env:TEMP\ocx-codex-home"
bun run src/cli.ts service install
schtasks /query /tn opencodex-proxy
type "$HOME\.opencodex\opencodex-service.cmd"
```

Verify:

- wrapper script exists;
- wrapper script sets `OCX_SERVICE=1`;
- wrapper script preserves `CODEX_HOME`;
- Task Scheduler entry calls the wrapper, not an unquoted inline command.

## Windows Stop Check

```powershell
bun run src/cli.ts start
bun run src/cli.ts status
bun run src/cli.ts stop
bun run src/cli.ts status
```

Expected:

- stop only reports success after the proxy PID exits;
- if `taskkill` returns but the process is still alive, the command reports failure instead of silently succeeding.

## Codex Model Visibility

After sync/start, open a fresh Codex process and verify:

- routed models appear in the model picker or `codex debug models`;
- `codex --profile opencodex` uses the standalone `$CODEX_HOME/opencodex.config.toml`;
- native Codex still works after `ocx restore` or service stop/uninstall.

## Known Constraints

- `model_catalog_json` is startup-loaded by Codex, so an already-running Codex UI may need restart after catalog changes.
- `CODEX_HOME` must already exist when explicitly set, matching upstream Codex behavior.
- Windows service verification needs a real Windows host; macOS/Linux can only validate syntax and generated files for that path.

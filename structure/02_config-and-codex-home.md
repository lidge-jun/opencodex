# Config And Codex Home SOT

## Codex home

`src/codex/paths.ts` resolves Codex state from `CODEX_HOME` when set and valid, otherwise from
`~/.codex`. The managed files are:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

Never assume macOS-only paths. Windows, service installs, and app-launched Codex can all depend on
the resolved `CODEX_HOME`.

`atomicWriteFile` uses a temp file named `{path}.ocx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `ocx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.

## Config injection

`src/codex/inject.ts` inserts root-level keys and an opencodex provider table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

Root TOML keys must be written before the first `[table]`. Re-injection strips stale opencodex
blocks, stale root context-window overrides, and stale opencodex catalog paths before rewriting.

`supports_websockets = true` is appended only when `websocketsEnabled(config)` returns true.

## Profile and fast tier

opencodex also writes `$CODEX_HOME/opencodex.config.toml` as an explicit profile target. Codex config
uses `service_tier = "fast"` and `[features].fast_mode = true`; catalog/request tier metadata may use
`priority`. Do not collapse these spellings into one value.

## Provider output defaults

`OcxProviderConfig.defaultMaxOutputTokens` and `modelMaxOutputTokens` are OpenAI Chat wire defaults,
not context-window metadata. They are applied only when a Responses request omits
`max_output_tokens`; an explicit request value wins, then a model-specific configured value, then
the provider default, then the adapter omits `max_tokens`.

Both fields must stay positive finite integers at disk-config and management validation boundaries.
Registry entries may seed them through `providerConfigSeed`, key-login derivation, OAuth reconcile,
and `routeModel`, but user config overrides registry defaults per field/key.

## Restore

`ocx stop`, `ocx restore` / `ocx eject`, `ocx service stop`, and `ocx service uninstall` must strip
opencodex config and routed catalog entries without damaging native Codex state.

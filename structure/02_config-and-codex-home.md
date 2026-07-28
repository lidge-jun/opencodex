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

OpenCodex never overrides an explicit `CODEX_HOME`. On Windows, `ocx doctor` and `ocx status`
nevertheless diagnose the high-confidence Orca dual-home case: both `CODEX_HOME` and
`ORCA_CODEX_HOME` select Orca's `orca/codex-runtime-home/home`, while the ChatGPT/Codex app uses the
default `%USERPROFILE%\\.codex`. Sync and restore output always prints the exact target Codex home;
display and JSON paths redact the OS username. The diagnostic tells users to invoke OpenCodex with
the app home explicitly rather than silently claiming that an unrelated app was configured. If a
service was installed under the Orca home, it must first be uninstalled from that original Orca
environment and then reinstalled under the app home; changing only the current shell cannot migrate
the recorded service ownership.

[Decision Log]
- 목적과 의도: Make multi-home injection truthful without taking ownership of user environment variables.
- 기존 구현 및 제약 조건: CODEX_HOME is an intentional override, but Orca exports it for its own bundled runtime and the Windows app reads a different home.
- 검토한 주요 대안: Rewrite CODEX_HOME automatically, warn for every custom home, or detect only the Orca-owned signature and report the target path.
- 선택한 방식: Preserve the override, add a narrow Windows/Orca diagnostic, and qualify sync/restore success output with the effective home.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the silent failure while avoiding destructive or noisy behavior for intentional custom homes.
- 장점, 단점 및 영향: Orca users get an actionable warning; other multi-home products remain unchanged until they have an equally reliable signature.

`atomicWriteFile` uses a temp file named `{path}.ocx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `ocx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.

Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
matches regular files named `responses-state.json.ocx.<pid>.<sequence>.tmp`, waits at least 15
minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
temporary files, symlinks, directories, and young/active writes are never touched; directory entries
are consumed incrementally and at most 512 stale files are attempted per process start.

[Decision Log]
- 목적과 의도: Bound disk and conversation-state retention after abrupt process termination.
- 기존 구현 및 제약 조건: Ordinary write failures clean up immediately, but a killed process cannot run that path and Windows may temporarily lock files.
- 검토한 주요 대안: Delete every `.tmp`, rely on manual cleanup, or recover only exact response-state remnants with age and PID guards.
- 선택한 방식: Run a capped, best-effort, unlink-only sweep on lazy response-state startup.
- 다른 대안 대신 이 방식을 선택한 이유: It repairs known remnants without broad authority over unrelated temp files or active writers.
- 장점, 단점 및 영향: Old dead-PID files are reclaimed automatically; locked or conservatively classified files remain for a later retry.

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

Native Codex sub-agent defaults are a separate, explicit opt-in. When
`syncCodexSubagentDefaults` is true and `injectionModel` is set, injection writes marker-owned
`agents.default_subagent_model` and, when configured,
`agents.default_subagent_reasoning_effort`. Unmarked values are user-owned and must never be
overwritten. Disabling the option and fallback restore remove only marker-owned values; journal
restore must preserve later user edits while stripping those managed values.

If the root config selects a provider other than `openai` or `opencodex`, injection must leave the
config byte-for-byte unchanged and skip profile creation/updates and history migration. External
provider managers own that routing configuration, and replacing their provider id can hide
otherwise intact Codex sessions. This ownership check must run before catalog/cache refresh,
journal creation, and the background history migration guardian.

`supports_websockets = true` is appended only when `websocketsEnabled(config)` returns true.

## Profile and fast tier

When opencodex owns routing, it also writes `$CODEX_HOME/opencodex.config.toml` as an explicit profile
target. Codex config uses `service_tier = "fast"` and `[features].fast_mode = true`;
catalog/request tier metadata may use `priority`. Do not collapse these spellings into one value.

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

# 002 — Existing `ocx` CLI surface (research)

Source: explorer lane "Nietzsche" (read-only repo scan, 2026-07-20). Entry chain:
`ocx`/`opencodex` → bin/ocx.mjs (update intercept :246, spawns Bun on
src/cli/index.ts :258, mirrors child exit code :290) → dispatch switch
src/cli/index.ts:451.

## Command inventory (grouped; 40 rows in lane output)

| Command | Behavior | Local vs API | --json | Exit codes |
|---|---|---|---|---|
| (bare) / `--help` / `help [cmd]` | usage text | local (`printUsage` help.ts:119, `printSubcommandUsage` :164) | no | 0; unknown topic → 1 (help.ts:166-169) |
| `--version` | package version | local | no | 0 |
| `init` | interactive provider/port setup | local config + direct provider fetches | no | 1 invalid provider |
| `start [--port]` | foreground proxy daemon | in-process server; service token via `loadServiceTokenFromFile` (index.ts:111) | no | 1 already-running/bad port |
| `stop` / `restart` / `ensure` | daemon lifecycle | API: `stopProxy` → POST /api/stop (process-control.ts:67); `findLiveProxy` | no | 1 on failure |
| `status [--json]` | proxy/paths/service/shim/plugins/OAuth summary | local + unauth `/healthz` (`checkProxyHealth` src/cli/status.ts:84-109); oauth summary via in-process `oauthLoginSummary()` | YES (index.ts:394) | 1 bad args; 0 when proxy down |
| `health [--json]` | identity-checked liveness | API: `findLiveProxy` + `proxyIdentityAt` | YES (index.ts:617-620) | 0 healthy / 1 not |
| `doctor` | read-only diagnostics | local + chatgpt.com probe | no | 0 |
| `debug <scope> <action>` | runtime debug/usage logs on live proxy | API: GET/PUT /api/debug etc. via `findLiveProxy` + `runningProxyUpdateHeaders` | no | 1 proxy down/bad action |
| `gui` | open dashboard (auto-starts proxy) | spawns detached start + `openUrl` | no | 0 |
| `login <provider>` / `logout <provider>` | OAuth browser flow or API-key prompt / remove credential | local credential store + POST /api/providers notify (`notifyRunningProxy` login-cli.ts:17-31) | no | 1 unknown provider/empty key |
| `sync` / `sync-cache` | rebuild Codex model catalog | local files + direct fetches | no | 0 (warnings degrade) |
| `restore`/`eject` [`back`] | restore native Codex config / re-point | local + `findLiveProxy` for `back` | no | 1 no live proxy (`back`) |
| `recover-history --legacy-openai` | history recovery | local | no | 1 without flag |
| `uninstall`/`remove` | full teardown | composed; stop via API | no | 1 any step failed |
| `service [install\|start\|stop\|status\|uninstall]` | OS service management | spawns launchd/Scheduler/systemd; token file `serviceApiTokenFilePath` | no | 1 on failures |
| `codex-shim install\|status\|uninstall` | autostart shim | local shim files | no | 1 unknown subcommand |
| `update [--tag]` | self-update | npm lane in bin launcher | no | 1 stop/integrity failure |
| `provider list\|add\|remove\|show\|set-default` | provider config management | local `loadConfig`/`saveConfig`; secrets masked (`maskSecret` provider.ts:51) | YES per-subcommand | 1 invalid/duplicate/missing |
| `models [--provider] [--json]` | configured models | local `loadConfig` only (models.ts:78-138) | YES | 1 unknown args/unconfigured |
| `claude [args]` / `claude desktop` | launch Claude Code / write Desktop 3P config | spawns binary; API: GET /api/claude-code with api-key fallback (claude.ts:120-121) | no | child passthrough / 1 |
| `v2 [status\|on\|off\|mode\|threads]` | multi-agent surface control | local + spawns `codex features` | no | return-code pattern (`process.exitCode = await cmdV2()`, index.ts:524) |
| `__refresh-version`, `__gui-update-worker` (hidden) | detached helpers | — | no | internal |

## How the CLI reaches the management API (convention to reuse)

- Port/host: `findLiveProxy()` (src/server/proxy-liveness.ts:93) — liveness-first,
  identity-probed, never a blind `config.port`; URL host via `probeHostname()` (:46).
- Auth headers: `runningProxyUpdateHeaders()` (src/oauth/login-cli.ts:9-14) sets
  `X-OpenCodex-API-Key` from `OPENCODEX_API_AUTH_TOKEN`; `ocx claude` falls back to
  `config.apiKeys[0].key` when the env is absent (src/cli/claude.ts:120-121).
- Endpoints consumed today: `/healthz`, POST `/api/stop`, GET/PUT `/api/debug*`,
  POST `/api/providers`, GET `/api/claude-code`, GET `/v1/models?ids=cli`.

## Account/credential gap finding (issue #180 core)

**No CLI command touches codex-auth account listing or switching.**
`rg "codex-auth" src/cli/` → zero hits. No `ocx account`, no CLI equivalent of
`PUT /api/codex-auth/active`, no multi-account quota view, no OAuth account or
apiKeyPool switching. Adjacent surfaces only: `ocx login/logout` (single credential),
`ocx status` OAuth summary, `ocx provider show/list` masked key display. This is the
exact parity gap.

## Help/registration convention for a new command family

1. Add entry to `helpEntries` record (src/cli/help.ts:13-107) shaped
   `HelpEntry { usage, summary, details? }` (:7-11).
2. Add one aligned line to the hardcoded `printUsage()` text (help.ts:119-158) —
   the two are independent; both must be updated.
3. Dispatch: `ocx help account` resolves via index.ts:49-52; `ocx account --help`
   intercepted by index.ts:54-57 (`hasHelpFlag` help.ts:160-162); both land in
   `printSubcommandUsage()` (help.ts:164-173).
4. Multi-subcommand family: mirror `provider` — lazy `await import("./account")` in
   the switch (index.ts:626-629 pattern) + internal `ACCOUNT_USAGE` constant and
   per-subcommand usage-on-error (provider.ts:372-395, :127/:247).
5. Flags: `consumeFlag`/`consumeFlagValue` helpers (provider.ts:23-36); usage errors
   → `console.error` + `process.exit(1)`; or return-code pattern
   (`process.exitCode = await cmdX()`) for test/Windows-friendly flows (v2).
6. Docs parity: reference/cli.md in all three locales (en/ko/zh-cn).

Known inconsistencies NOT to copy: `ocx v2` documented in docs but missing from
`helpEntries`; `ocx claude` has a help entry but is absent from all three docs-site
CLI reference pages; help.ts `debug` entry omits the `injection` scope.

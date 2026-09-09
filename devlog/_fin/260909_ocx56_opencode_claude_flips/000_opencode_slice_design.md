# `ocx opencode` flip to Go-owned — slice design (issue #56)

Status: design confirmed by owner (grilling Q1–Q6, v2b shipped as `f339b24a3`).
Scope: flip the `opencode` WholeCommand to `GoOwned` with an env-capture shim
oracle. `update` and `claude` stay TS-owned for now (their deferral entries are
untouched by this slice).

## What the TS owner does (src/cli/opencode.ts `cmdOpencode`)

1. `loadConfig()`.
2. `ensureProxyForOpencode(config)`: `findLiveProxy()` first; when none, spawns a
   detached `ocx start --port <cfgPort|10100>` with `OCX_SERVICE=1` (+
   `OCX_API_TOKEN_FILE` hardening when no env token) and polls up to 8 s.
   Failure prints `❌ Proxy did not become healthy after starting.` (exit 1).
3. `opencodeApiKey(config)`: env `OPENCODEX_API_AUTH_TOKEN` → service token file
   → `config.apiKeys[0]?.key` → `"ocx"`. Never serialized into the inline config.
4. `fetchOpencodeProxyModels(live, apiKey)`: GET
   `http://<probeHostname(hostname)>:<port>/api/models` with `Accept: application/json`
   (+ `X-OpenCodex-API-Key` when the trimmed token is non-empty), 8 s deadline;
   error texts: timed-out / unreachable / non-2xx body `error` / unexpected payload.
5. `opencodeCatalogFromProxyRows`: drop disabled, drop native under Codex Direct,
   first namespaced wins, drop fallback displayName.
6. `buildOpencodeProviderBlocksFromCatalog(port, catalog, hostname, config)`:
   one V1 + one V2 block. **This is the same serializer `ocx export` uses**
   (`opencodeProviderBlocks` in config-export.ts) — except export runs
   `normalizeExportModels` (dedupe + sort) first and resolves baseURL as
   `root + "/v1"`, while the launcher does NOT sort and resolves baseURL through
   `opencodeProxyBaseUrl(port, hostname, config)` (probe-hostname form, plus the
   `unauthenticatedLoopbackListener` standalone-codex target). Only the baseURL
   resolution and the sort differ.
7. `opencodeProviderOverridePath(cwd)`: global
   `$XDG_CONFIG_HOME|~/.config/opencode/opencode.json` then upward project
   `opencode.json|.jsonc` search that stops at the git root; JSONC-parses each
   file to detect `provider.opencodex` / `providers.opencodex`.
8. `buildOpencodeEnv(blocks, apiKey, process.env)`:
   `OPENCODE_CONFIG_CONTENT` = JSON of `{...parsed, $schema: string?,
   provider: {...existing.provider, opencodex: v1},
   providers: {...existing.providers, opencodex: v2}}`; child env additionally
   gets `OPENCODE_API_KEY` (`OPENCODEX_OPENCODE_API_KEY`).
9. stderr wiring lines:
   `✅ opencode wired to <baseUrl> — <n> model(s) under provider \`opencodex\`.`
   `   Your existing opencode config files are left untouched; only the runtime provider blocks are injected.`
   `ℹ <path> also defines our provider key; the runtime layer from ocx opencode overrides it for this launch.` (when override found)
10. spawn `opencode <args...>` (win-exec commandInvocation), stdio inherit,
    exit-code passthrough, ENOENT hint `❌ \`opencode\` CLI not found. Install it first: npm install -g opencode-ai`,
    win32 9009 hint, other spawn errors`❌ Failed to launch opencode: <err>`.

## Reuse inventory on the Go side (go/internal/ocxcli)

- `liveProxyEndpoint` / `proxyServesOpencodex` / `baseURL(state)` — already
  byte-ported (usage/observe/export use them); oracle-green.
- `exportModelsFromProxyRowsRaw` + `opencodeCatalogFromProxyRows` +
  `normalizeExportModels` + `exportOpenCodeProviderBlocks` + labels / context /
  effort-variants (export_models.go, export_build.go) — byte-ported from the
  same TS `opencodeProviderBlocks` serializer family; export parity is green.
- Config view reading (`codexDirect`, `unauthLoopback`, `hostname`) —
  `readExportConfig` in export_command.go.
- Launcher spawn shell: `minimax_launcher.go` (spawnLauncherClient,
  launcherCommandInvocation win-exec port, hint conventions) as pattern.

New code needed (opencode_command.go + tests):

- baseURL via `opencodeProxyBaseUrl` port (probe-hostname + standalone target);
  the launcher's non-sorted, non-normalized catalog → blocks path reusing the
  export serializer's per-model mapping (verify byte-identity with a probe
  before trusting reuse — the model projection differs: catalog keeps provider
  `""` vs export's "routed"/"openai" fallback).
- `opencodeApiKey` precedence (env → service token file → config key → "ocx").
- fetchOpencodeProxyModels error texts (distinct from fetchManagementJSON).
- JSONC strip/parse + provider-override path search + git-root walk.
- merge/serialize of `OPENCODE_CONFIG_CONTENT`.
- spawn `opencode` + stdio inherit + exit/hint handling.

## Oracle (env-capture shim)

Describe-local Bun.serve fixture serving `/healthz` identity + `/api/models`
rows; runtime-port.json so both CLIs resolve the live proxy (no self-start).
PATH fake `opencode` shim (bash) that echoes `OPENCODEX_CONFIG_CONTENT`,
`OPENCODEX_OPENCODE_API_KEY`, and argv, then exits with a row-chosen code.
Rows compare TS vs Go bytes for stdout/stderr/exit:
normal catalog, empty/disabled/native-direct shapes, inherited valid
OPENCODE_CONFIG_CONTENT (foreign keys preserved), inherited invalid JSON /
non-object, project override detection, ENOENT (no shim), shim exit-code
passthrough, catalog fetch failure, and api-key precedence rows. win32 rows
skipped (no bash-shim oracle). Self-start path excluded from parity (spawns a
real proxy) — covered by Go unit tests with injected deps only.

## Verification gate

`go test ./...`, `go vet ./internal/ocxcli/`, `bun run typecheck`, focused
parity describe green; delete the opencode deferral entries (WholeCommand only —
opencode has no SubcommandSeam), flip cli.go table row + dispatch, update issue
# 56 Progress, one commit.

## Outcome (2026-09-09)

Landed as `flip the ocx opencode launcher to Go (issue #56)`:

- Engine (`opencode_engine.go`) + command (`opencode_command.go`) + four Go test
  files; goldens frozen from the real TS serializer at a fixed port; the fetch
  lane has an injected-client harness for the timeout/unreachable/status/body
  error texts. Full `go test ./...`, `go vet`, and `bun run typecheck` green.
- Parity describe "ocx opencode slice (issue #56)" adds 7 rows against a live
  fixture proxy + env-capture shim: wired lane (pinned stderr + content bytes),
  argv passthrough, exit-code passthrough, ENOENT hint, admission-key precedence
  (service file > config apiKeys > placeholder), inherited-content merge + its
  invalid-JSON error, and the provider-override ℹ line. All rows pass.
- cli.go row flips `opencode` → GoOwned with a dispatch case; the deferral.go
  WholeCommand entry is deleted (ledger bijection green). Self-start lane and
  win32 remain out of parity by design.

### Residuals recorded

- **apiKeys metadata repair notice**: the TS config loader emits
  `⚠️  config.json apiKeys: repaired metadata …` on stderr when an apiKeys
  entry lacks id/name/createdAt; the Go loader does not reproduce that
  warning lane. Parity fixtures use metadata-complete entries so the row
  compares launcher bytes only. Candidate for a config-family ticket in the
  post-#56 inventory, not an opencode-engine defect.
- Detached-self-start env divergence (TS sets `OCX_SERVICE=1` + hardened
  `OCX_API_TOKEN_FILE`; Go inherits the current env) — same service-token
  bootstrap for a normal shell; documented in opencode_command.go, unexercisable
  by parity (the oracle always has a live fixture proxy).

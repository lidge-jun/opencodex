# Issue #43 - Plan: Codex bundled-plugin marketplace diagnostics

Builds on `00_review.md` (scoping). This is the implementation plan for a
read-only diagnostic (Phase 1) and a scoped, opt-in repair (Phase 2). Phase 1
is the recommended first PR; Phase 2 is deferred behind explicit invocation.
No code is written in this phase. The codex-rs and opencodex facts below were
independently audited by two parallel subagents (one on gpt-5.5) and are cited
with file:line evidence.

## Decision

- In scope: a READ-ONLY diagnostic that reports whether the Codex
  `openai-bundled` marketplace path registered in Codex config is stale or
  missing, and whether the common bundled plugins are present.
- Out of scope by default: any automatic mutation of Codex plugin marketplaces.
  `ocx ensure` must never re-add or refresh marketplaces. Matches the reporter's
  explicit request and the `00_review.md` recommendation.
- Phase 2 (`ocx repair codex-plugins`) is allowed only as an opt-in command the
  user runs deliberately.

## Why this is a real failure (root cause)

Codex stores configured marketplaces as `[marketplaces.<name>]` tables in its
`config.toml`. A `local` marketplace records an absolute on-disk `source` path:

```toml
[marketplaces.openai-bundled]
source_type = "local"
source = "<...app-package path that embeds the Codex app version...>"
```

On Windows the app-package path embeds the app version, so after an app update
the recorded `source` points at the previous version's directory. The plugin
files still exist under the NEW package, but the registered path no longer
resolves to a marketplace manifest, so the bundled plugins drop out until the
marketplace is re-added/refreshed.

Crucially (codex-rs evidence below): codex-rs does NOT auto-resync or re-add a
local bundled marketplace at startup - only curated Git marketplaces are
auto-upgraded. So nothing self-heals this; a diagnostic is genuinely useful.

## Phase 1 - read-only diagnostic

### Surface

Add a `codexPlugins` diagnostic. Two homes, in order of preference:

1. Extend `ocx status --json` with an optional `codexPlugins` section on the
   existing `CliStatusJson` (`schemaVersion: 1`, sectioned object) in
   `src/cli-status.ts`. Low-friction, already JSON-shaped, already prints paths,
   and `codexShim.summary` is an existing precedent for a string-summary block.
2. A dedicated `ocx doctor` command only if status grows too heavy. There is no
   `ocx doctor` today; `doctor` exists only as a Codex subcommand the shim
   passes through. Prefer option 1 for the first PR.

### What it reports (path-focused, secret-safe)

- platform applicability: only meaningful on Windows (versioned app paths);
  on macOS/Linux report "not applicable" rather than guessing.
- whether a Codex app package is detected, and its path/version.
- the `source` registered for `[marketplaces.openai-bundled]` in Codex
  `config.toml`.
- whether that registered path still resolves to a marketplace manifest
  (exists / non-stale).
- the detected CURRENT bundled marketplace path under the installed app
  package, and whether it differs from the registered one (stale signal).
- presence/enabled state of the bundled plugins. NOTE: the issue names three
  (`computer-use`, `browser`, `chrome`), but the codex-rs Rust allowlist only
  defines `chrome@openai-bundled` and `computer-use@openai-bundled`; `browser`
  is not in that allowlist. Treat the bundled-plugin set as data, defaulting to
  what the issue lists, and do not hardcode an assumption that all three are in
  any single Codex allowlist.
- a suggested manual repair command - never executed automatically.

All emitted paths follow `src/redact.ts` conventions. Note `redact.ts` has no
path/username masker today (only `redactSecretString`, `redactSecrets`,
`redactHeaders`, `redactUrlForLog`), so a Windows `C:\Users\<name>\...` masker
is net-new if we want to hide usernames.

### How it reads the data

- Codex config path: `CODEX_CONFIG_PATH` from `src/codex-paths.ts`
  (`CODEX_HOME/config.toml`); `CODEX_HOME` resolves from `$CODEX_HOME` or
  `~/.codex`.
- Parse `[marketplaces.openai-bundled]` -> `source_type` / `source`. opencodex
  has only root-key TOML helpers (`readRootTomlString`/`parseTomlString`) that
  do NOT read nested tables, and there is no TOML library dependency. So this
  needs a minimal nested-table reader. Note `src/codex-inject.ts` does line-
  based string transforms only and never touches `[marketplaces.*]`, so there
  is nothing to reuse there beyond the read+atomicWrite pattern.
- "stale" = a `local` `source` that does not resolve to a marketplace manifest,
  OR differs from the current app package's bundled path. This mirrors codex-rs
  `configured_marketplace_snapshot_issues` ("marketplace root does not contain a
  supported manifest"), minus the implicit-system-root exemption codex-rs
  applies to its own managed relative paths (`.tmp/bundled-marketplaces/...`).

### Non-mutation guarantee

Reads files and, optionally, shells out to a READ-ONLY
`codex plugin marketplace list`. NOTE: that command has no `--json`; it prints a
`MARKETPLACE  ROOT` text table (or "No plugin marketplaces in scope."). Parsing
text is brittle, so prefer reading `config.toml` directly and treat the CLI
output as a secondary cross-check only. Never calls `marketplace add`, never
writes `config.toml`, never invoked from `ocx ensure`.

## Phase 2 - opt-in repair (deferred)

`ocx repair codex-plugins` (explicit only):

- detect the current bundled marketplace dir under the installed Codex app.
- `codex plugin marketplace add <current-openai-bundled-path>` (the `add`
  command accepts a local path and prints `Added marketplace ...` /
  `Installed marketplace root: ...`).
- install/refresh only the known bundled plugins, and only when present.
- never run from internal Codex plugin command paths unless explicitly invoked.
- secret-safe, path-focused output.

Separate PR after Phase 1. Medium risk: mutates Codex plugin config -> opt-in.

## codex-rs evidence (audited, gpt-5.5 subagent)

- Marketplace name constant `OPENAI_BUNDLED_MARKETPLACE_NAME = "openai-bundled"`
  at core-plugins/src/lib.rs:21. Bundled allowlist entries are only
  `chrome@openai-bundled` (lib.rs:38) and `computer-use@openai-bundled`
  (lib.rs:39); `browser@openai-bundled` is NOT in the Rust allowlist.
- Config shape: `[marketplaces.<name>]` with `source_type` (Git|Local) and
  `source`; written by `record_user_marketplace`
  (config/src/marketplace_edit.rs:103-108), typed at config/src/types.rs:856-872.
- Root resolution: `resolve_configured_marketplace_root` returns the `source`
  path directly for `local`, else `.tmp/marketplaces/<name>`
  (core-plugins/src/installed_marketplaces.rs:68-74). Read via
  `installed_marketplace_roots_from_layer_stack` (same file:21-24).
- Stale/missing detection lives in `configured_marketplace_snapshot_issues`
  (cli/src/plugin_cmd.rs:399-484). Messages: "configured marketplace entry must
  be a table" (422-427), invalid name `err.to_string()` (430-435), "configured
  local marketplace source is missing or empty" (438-448), and the key one
  "marketplace root does not contain a supported manifest" (458-468); manifest
  load errors forwarded (473-482).
- Exemptions (`is_implicit_system_marketplace_root`, plugin_cmd.rs:488-510):
  `openai-bundled`/`openai-bundled-alpha` when the path ends
  `.tmp/bundled-marketplaces/<name>` (493-497), and `openai-primary-runtime`
  under `codex-runtimes/codex-primary-runtime/plugins/<name>` (501-510).
- The Windows app-version path is the `source` of a configured LOCAL
  marketplace; codex-rs does not construct/rewrite that app-package path in
  production (installed_marketplaces.rs:68-73).
- `codex plugin marketplace list` has no `--json`; it prints a `MARKETPLACE
  ROOT` table (marketplace_cmd.rs:218-224) or "No plugin marketplaces in scope."
  (194-196). `marketplace add <SOURCE>` accepts a local path / repo / Git URL
  (51-54) and prints "Added marketplace ..." + "Installed marketplace root: ..."
  (131-145).
- No bundled re-add on startup: startup curated sync is `sync_openai_plugins_repo`
  (startup_sync.rs:66; manager.rs:1476-1478), and auto-upgrade only selects
  `source_type == Git` (manager.rs:1571-1587; marketplace_upgrade.rs:149-150).
  Local bundled marketplaces are NOT auto-resynced or re-added.

## opencodex evidence (audited subagent)

- `src/codex-paths.ts`: `CODEX_HOME` resolved once at module load (env or
  `~/.codex`, line 25) and `CODEX_CONFIG_PATH = CODEX_HOME/config.toml` (26). No
  TOML parser; only `tomlString` (31), `parseTomlString` (35),
  `readRootTomlString` (46, root lines only), `resolveCodexConfigPath` (57). No
  `toml`/`@iarna`/`smol-toml` dependency in package.json.
- No `ocx doctor`/`ocx plugin` command: `src/cli.ts` switch (363-489) has no
  such case; `src/codex-shim.ts` lists `doctor` (18) and `plugin` (25) only in
  `CODEX_INTERNAL_COMMANDS` (pass-through, used at 123/157/182).
- `ocx status`: `CliStatusJson` (`schemaVersion: 1`, src/cli-status.ts:13) and
  `collectStatus()` (107) assemble JSON at 128-162; `paths` block (30-34/145-149)
  and `codexShim.summary` (46/161) are precedents for adding a `codexPlugins`
  block.
- `src/codex-inject.ts` reads `config.toml` via `readFileSync` (253) and edits
  it with line-based string transforms + `atomicWriteFile` (276); it is plugin-
  table aware only as a documented hazard comment (25) and never touches
  `[marketplaces.*]` (no `marketplace` hits in `src`).
- `src/redact.ts`: `redactSecretString` (5-11/25), `redactSecrets` (33),
  `redactHeaders` (46), `redactUrlForLog` (60), `REDACTED_SECRET` (1). No path/
  username masker exists.
- Windows detection is inline `process.platform === "win32"` (service.ts:472+,
  codex-shim.ts:54/219/307, config.ts:432, etc.). No helper locates the Codex
  app package dir; closest is `findWindowsCodexTargets()` (codex-shim.ts:82),
  which PATH-scans for `codex.exe/.cmd/.ps1`. An app-package/plugins-cache
  locator is net-new.
- Tests: `bun test`; model after `tests/cli-status-json.test.ts` (spawns the CLI
  with `OPENCODEX_HOME` override:16, `mkdtempSync`:23, asserts read-only:45-47).
  Because `CODEX_HOME` is a load-time `const` in codex-paths.ts, stale-path tests
  must run in a freshly spawned process with `CODEX_HOME` set (not in-process
  env mutation). `tests/codex-inject.test.ts` is the reference for config.toml
  fixtures.

## Verification plan

- Unit/spawned tests for stale-detection with fixture path layouts: an old
  app-version `source` that no longer resolves vs a current one that does, plus a
  mocked `[marketplaces.openai-bundled]` table. Set `CODEX_HOME` to a fixture
  `.codex` dir in a spawned process; follow `tests/cli-status-json.test.ts`.
- Assert read-only: no write to `config.toml`, no `marketplace add`, not
  reachable from `ocx ensure`.
- Cross-platform: assert "not applicable" on macOS/Linux.
- Manual (Windows): bump the app-version path to simulate an update and confirm
  the diagnostic flags the stale `openai-bundled` source and suggests the repair.

## Effort & risk

- Phase 1: small-medium, low risk (read-only). Net-new pieces: a minimal nested-
  table TOML reader and a Windows app-package/plugins locator.
- Phase 2: medium; mutates Codex plugin config -> opt-in only, separate PR.

## Suggested issue reply

Yes to Phase 1 read-only diagnostics; happy to take a small reporter PR scoped
to diagnostics only. `ocx ensure` will not mutate plugin marketplaces. Phase 2
repair is acceptable later as an explicit opt-in command, decided separately.
One correction for scoping: the bundled-plugin set should be treated as data -
the upstream Rust allowlist currently defines only `chrome@openai-bundled` and
`computer-use@openai-bundled`.

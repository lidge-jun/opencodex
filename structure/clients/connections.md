# Client Connections

The read-only Connections view and the Claude Code first-party preview (proxy catch-up 010, gaps
G-001 and G-002; roadmap `devlog/_plan/261123_proxy_upstream_catchup/010_client_connection.md`).
Neither surface writes: they project the files the existing switches act on, and the switches keep
their own apply and rollback paths unchanged.

## `GET /api/connections`

`src/server/management/connection-status-routes.ts` serves it, lazily loaded by namespace from
`src/server/management-api.ts` so its imports stay off every other dashboard request and no
`src/lab/` edge appears. The response is `{ connections: ConnectionView[] }`, typed in
`src/integrations/connection-view.ts`: per row `client` (`codex`, `claude-code`,
`claude-desktop`), `desired`, `observed`, `owner`, an optional `ownerPath`, `driftReasons` and
an optional `restorePreview` of `{ outcome, changes: [{ file, key, change }] }`.

Drift reasons, each produced by a projection: `external_owner` (another program, OpenCodex home or
service owns the files; `ownerPath` names the file), `account_mode` (Claude Desktop's pinned
`desktopMode` contradicts the artifact it runs), `hub_gated` (a hub without the loopback listener
does not rewrite its own clients), `intercept_disabled` (CLI first-party wanted while the intercept
cannot run), `file_edited` (the file no longer matches the switch) and `pending_restart` (settings
point at a stopped or mismatched listener). The roadmap's `quota_block` has no read-only signal —
the desktop quota gate (#6196) is still a design proposal — and is not produced.

**Codex** (`src/codex/connection-projection.ts`): `desired` from `codexIntegrationEnabled`
(`remote-home` on a Link Child), `observed` from `classifyCodexRouting` over a bounded read of
config.toml. Ownership precedence: a Codex-home journal bound to another OpenCodex home (owner
file: the journal), a recorded service state naming other homes (`inspectRecordedServiceOwnership`
in `src/integrations/native/ownership-preflight.ts`, the state-file half of
`inspectNativeCodexOwnership`, file reads only — the service-manager probe spawns processes and
stays on write paths), an external model provider (owner file: config.toml), the sibling mark, the
hub gate, unknown evidence. `restorePreview` comes from `src/codex/restore-preview.ts`, which walks
`restoreNativeCodexAsync` in its own order with the read-only halves of the same decisions:
`previewJournalRestore` (`src/codex/journal.ts`), `previewRemovedCodexConfig` (sharing
`planCodexConfigRemoval` with `removeCodexConfig` in `src/codex/inject/remove.ts`), the provider
table retention, and `previewApprovedCodexProviderRestore` (sharing the URL transform with
`restoreApprovedCodexProviders`). Changes are root keys or `section.key` in config.toml plus a
whole-file entry for `opencodex.config.toml`; catalog rows and the history relabel are not keys and
are not listed. Keys are shown through an allowlist (`displayCodexConfigKey`): OpenCodex-managed root
keys, Codex's own table names, the table ids OpenCodex owns (`opencodex`, `openai`) and Codex's fixed
leaf vocabulary; any other segment — a provider, profile, project, hook or server name, which can be a
user name, an email or a secret of any length — is shown as `…`. A profile
that is a symbolic link is refused before config.toml is touched, as `removeCodexConfig` does. The
service manager is not probed: restore refuses only a `foreign` verdict, which only the recorded
service state yields (a manager definition naming other homes reads `unknown`), so the recorded state
alone decides the preview's refusal. `tests/server/connection-status-routes.test.ts` runs
`tests/fixtures/connection-restore-preview-runner.ts` in temporary homes and compares the preview
with the real restore for injected, edited, native, external-provider and foreign-owner homes.

**Claude** (`src/claude/connection-projection.ts`): one Claude Code row per registered home —
`registeredClaudeConfigDirs` (`src/claude/auth-detect.ts`) returns the default `claudeConfigDir`
and then `claudeCode.extraConfigDirs`; nothing is discovered on disk. Only the default home carries
intent, drift and the switch-off preview, because the switch writes only that home; an extra home
reports `desired: "unset"` and what its settings.json routes to. One Claude Desktop row maps the
config-library inspection the native status row uses.

Privacy: every returned path goes through `displayPath` (`src/lib/display-path.ts`): the user's home
prefix becomes `~`, a drive letter stays, and only the fixed directory and file names OpenCodex, Codex
and Claude use are shown; any other segment (a user name, account id or token used as a folder name)
becomes `…`, and an extra home is identified by `homeOrdinal` instead of its path. No setting value,
token or email is returned; an unexpected failure answers a fixed `connections_failed` body. Reads are
bounded: at most 16 extra homes (`MAX_EXTRA_CLAUDE_CONFIG_DIRS`), a `settings.json` that is not a
regular file of at most 1 MiB is never opened (`claudeSettingsFileState`; the row reads `unknown` and
the preview refuses `unreadable`), and the Codex profile goes through the same bounded reader as
config.toml. The Codex
toggle envelopes in `native-integration-routes.ts` carry `connections: "/api/connections"`.

CLI verb: owed. The route registry declares it `deferred-verb` with owner "proxy catch-up 020
(client connections CLI)"; this document is its owner doc.

## `GET /api/claude-code/first-party/preview`

`src/server/management/claude-first-party-preview-routes.ts`, delegated by one line from
`agent-settings-routes.ts`. `?enabled=true|false` names the switch value (absent: the flip of the
current value; anything else is `400 invalid_enabled`). The answer is
`{ enabled, path, changes: [{ file: "settings.json", key: "env.X", change }], applyChecks }`.
`src/claude/first-party-preview.ts` uses the switch's inputs: the persisted-config transition
`claudeFirstPartyTransition` (`src/claude/first-party-transition.ts`, which `PUT /api/claude-code`
calls inside its locked mutation), the live config the route reconciles with, the settings
inspection, and the NO_PROXY merge and receipt rules (a removal restores NO_PROXY only when the
current value is the one the receipt records). Enabling repeats the PUT's pre-checks and answers
their codes: `409 intercept_disabled`, `409 foreign_env`, `500 unreadable`. The token is read,
never minted, and the CA is never created; `applyChecks` names the runtime steps a read cannot
predict. `tests/claude-integration/claude-first-party-preview.test.ts` compares each preview with
the real transition and reconcile, including a persisted snapshot that differs from the live one.
The registry exempts the route as `interactive-preview`: `ocx claude config set --first-party`
has no confirmation step.

The dashboard switch (`gui/src/pages/ClaudeCode.tsx`) fetches the preview before the PUT and,
when keys would change, waits on `FirstPartyPreviewDialog`. A failed, refused or cancelled
preview releases the switch through the existing `finally` and sends no PUT
(`gui/tests/claude-toggle-race.test.tsx`). Turning first-party off sends the PUT directly. The page
lists registered homes (`ClaudeHomesStatus`) and the Integrations overview mounts
`ConnectionsPanel`, both reading `GET /api/connections`; copy lives in
`gui/src/i18n/connections-copy.ts` for every locale.

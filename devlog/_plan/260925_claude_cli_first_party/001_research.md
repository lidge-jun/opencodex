# 001 — Research: separating Claude Code CLI first-party from Claude Desktop (2026-09-25)

Evidence was read at `origin/dev` `9c28acf6a1` in this worktree, from the installed Claude Desktop
bundle, and from the installed Claude Code CLI 2.1.282. Items marked **measured** were run on the
maintainer machine; everything else is a source reading with the cited anchor.

## The coupling

- Desktop first-party writes two keys into the user `~/.claude/settings.json` env block:
  `HTTPS_PROXY=http://opencodex:<token>@127.0.0.1:<publicPort+100>` (the token is minted by
  `src/claude/intercept/proxy-auth.ts`; installs from before proxy auth carry a token-less URL that startup migrates) and
  `NODE_EXTRA_CA_CERTS=<configDir>/claude-intercept/ca.pem` (`src/claude/intercept/settings.ts:7-36`).
  Ownership is recognised by the CA path value, never by a marker key (`settings.ts:17-19`).
- Both Desktop's Code tab and the standalone `claude` CLI read that file
  (`settings.ts:7-12`), so Desktop first-party also routes every terminal `claude` session.
  The English guide says so (`docs-site/src/content/docs/guides/claude-code.md:171-186,261-265`),
  but `ocx claude desktop --help` says "route only the Code tab's Claude Code"
  (`src/cli/claude-desktop.ts:56-59`) and the status line says "Code tab routed".
- Every writer and remover of the pair is Desktop-owned:
  `applyDesktopFirstParty` / `removeDesktopFirstParty` (`src/claude/desktop-first-party.ts:221-241`),
  called from the CLI apply (`src/cli/claude-desktop.ts:391,428`), the Desktop apply API
  (`src/server/management/agent-settings-routes.ts:1115,1229`), the native Desktop toggle
  (`src/server/management/native-integration-routes.ts:714,743,819`) and `ocx ensure`
  (`src/cli/ensure-desired-integrations.ts:157-182`). Startup migration re-applies only a stale
  owned env (`src/claude/intercept/runtime.ts:133`).
- Desktop mode resolution uses an owned settings env as evidence of a first-party install
  (`src/claude/desktop-first-party.ts:58-72`). A CLI-owned env would break that inference.

## Existing knobs that are not a CLI first-party switch

- `clientIntegrations` knows `codex`, `grok` and `claude-desktop`; there is no `claude` key
  (`src/types/config.ts:348`, `src/config/schema/leaf-validators.ts:762`). Missing means ON
  (`src/codex/desired-state.ts:62,162`).
- `ocx integration native claude on|off` and `PUT /api/native-integrations/claude` set
  `claudeCode.enabled` (`native-integration-routes.ts:868-890`), which gates the Messages surface,
  the intercept listener, `ocx claude` routing and agent injection (`src/types/config.ts:48`,
  `src/claude/intercept/runtime.ts:31`, `src/cli/claude.ts:742`). It is the whole Claude surface,
  not first-party intent.
- `ocx claude config set --<flag>` PUTs `/api/claude-code` with an explicit field-by-field writer
  (`src/cli/integrations.ts:63-76`, `agent-settings-routes.ts:1450,1508,1586`). `claude config` is not
  in `CAPABILITIES`; `GET`/`PUT /api/claude-code` sit in the undeclared-route ratchet
  (`tests/cli/cli-capabilities.test.ts:217,311`).

## What the intercept does with a request

- CONNECT `api.anthropic.com:443` is spliced to the local TLS listener
  (`src/claude/intercept/connect-proxy.ts:17,189-191`); every other host is a blind tunnel.
- The listener sends `POST /v1/messages` and `/v1/messages/count_tokens` into the router with
  `claudeIntercept: true`; every other path goes through `relayToUpstream`, a verbatim relay minus
  hop-by-hop headers (`src/claude/intercept/listener.ts:17-33,63-92,108-116`).
- An unbound model is **not** byte passthrough: aliases, the global model map and classifier
  routing still apply, and a genuine Claude model is re-issued by the native passthrough branch
  with filtered headers, image/tool-id normalisation and usage recording
  (`src/server/claude-messages.ts:225,481-558,835,994`). So "routed but unbound" is not native.
- The listener copies every request header, so `User-Agent`, `x-app` and `anthropic-*` are
  visible there (`listener.ts:39-52`). No CLI-versus-Desktop classifier exists today; the only
  client split is the CONNECT User-Agent (`Mozilla/` = Desktop's browser) in
  `connect-proxy.ts:43-64`.
- The intercept pair starts whenever `claudeInterceptEnabled` holds (not a client role,
  `claudeCode.enabled !== false`, `intercept.enabled !== false`); Desktop integration and
  `desktopMode` do not gate it (`runtime.ts:29-33`, `src/server/index/optional-listeners.ts:87`).
  A CLI-only first-party therefore needs no new listener.
- Picker mode's egress proxy intercepts `api.anthropic.com` for a UA-less (Claude Code) CONNECT with
  the same intercept leaf, and tunnels everything else blind (`runtime.ts:145,191-200`).

## Bypass behaviour of Claude Code (measured)

- `claude -p 'reply with just OK' --model haiku --settings '{"env":{"HTTPS_PROXY":"http://127.0.0.1:1"}}'`
  hung until `timeout 25` killed it (exit 124).
- The same command with `NO_PROXY='*'` in the process environment answered `OK` (exit 0).
- So a process-env `NO_PROXY` defeats a settings-injected `HTTPS_PROXY`; the settings env only
  overrides keys it names. The intercept hosts list is exactly `api.anthropic.com`
  (`connect-proxy.ts:17`); a host-scoped `NO_PROXY` would bypass interception but leave other
  hosts on the blind relay, so `*` is the value that makes a launch fully native.

## `ocx claude` native fallback

- Native launch is chosen when `claudeCode.enabled === false` (saved or live)
  (`src/cli/claude.ts:527,742,767`). `buildNativeClaudeEnv` removes owned Anthropic slots and gateway
  levers only (`claude.ts:580,610-652`); it never touches `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` or
  `NO_PROXY`, so with Desktop first-party on, a "native" `ocx claude` still goes through the
  intercept. `launchNativeClaude` is private (`claude.ts:814`); tests cover its helpers
  (`tests/claude-integration/claude-cli.test.ts:76,221,823`).

## Surfaces a change must keep in sync

- GUI: overview cards (`gui/src/pages/integrations/overview-clients.ts:308-427`,
  `IntegrationsOverview.tsx:138-229`), Code settings card (`gui/src/pages/claude-code-sections.tsx:27-68`,
  `ClaudeCode.tsx:52-218`), Desktop mode card (`gui/src/pages/ClaudeDesktop.tsx:539-610`).
  New keys go into all ten locale catalogs; `Record<TKey,string>` makes a missing key a build error
  (`gui/src/i18n/shared.ts:6-17`, `gui/src/i18n/catalogs.ts:25-36`).
- Docs: `docs-site/src/content/docs/guides/claude-code.md` and its seven translations
  (first-party and bindings sections; only English has the CLI compatibility subsection at 261-277).
- Tests: `tests/claude-integration/claude-intercept-settings.test.ts`,
  `claude-desktop-first-party.test.ts`, `claude-desktop-first-party-guards.test.ts`,
  `claude-intercept-model-bindings.test.ts`, `tests/codex-integration/native-claude-*-toggle.test.ts`,
  `gui/tests/claude-desktop-mode-picker.test.tsx`, `integrations-overview-rows.test.ts`.
- File-size ratchet: none of the candidate files has a numeric cap; `en.ts`/`ko.ts` are exempt
  (`tests/fixtures/file-size-baseline.json:2-17`).
- structure/: `structure/clients/claude-desktop.md`, `config.md`, `runtime.md`,
  `gui-and-management-api.md` own these areas (`structure/INDEX.md:115-146`).

## Telling the two clients apart (Claude.app bundle and CLI 2.1.282, static reading)

- Desktop's Code tab spawns Claude Code with `CLAUDE_CODE_ENTRYPOINT` from a mapper
  `return e==="3p"?"claude-desktop-3p":"claude-desktop"` (app.asar ≈14,872,629; call site ≈6,201,102).
  Cowork/LAM sessions set `"local-agent"` (≈6,682,821); the bundled Agent SDK defaults to `sdk-ts`
  only when unset (≈6,056,853).
- Claude Code builds `User-Agent: claude-cli/<version> (external, <CLAUDE_CODE_ENTRYPOINT ?? "cli">…)`
  and sends `x-app: cli` on API requests (CLI 2.1.282 ≈176,279,221 and ≈206,126,034; the bundled
  2.1.281 has the same formatter). So the entrypoint in the request User-Agent separates a
  Desktop-spawned session (`claude-desktop`, `claude-desktop-3p`, `local-agent`) from a terminal
  or IDE one (`cli`, `sdk-cli`, `claude-vscode`, …). It is a routing hint any local process can
  forge, the same trust level as the existing CONNECT `Mozilla/` split.
- Claude Code applies settings env inside the running process
  (`Object.assign(process.env, …filterSettingsEnv(…))`, ≈177,794,001), reads `NODE_EXTRA_CA_CERTS`
  itself and appends that file to its CA set, and rebuilds its proxy agent when settings change
  (≈175,306,554, ≈177,794,624). This is why a settings-sourced CA works at all.
- With `egressProxyUrl` set, Desktop hands Code sessions `HTTPS_PROXY`, `HTTP_PROXY` and
  `NO_PROXY=localhost,127.0.0.1,::1,.local`, but only for keys not already present (≈12,333,569-897,
  ≈14,949,647). The Code-tab builder has no CA-bundle ternary; that ternary is on the LAM path only
  (≈6,636,291), so a Desktop-only egress route would still need the settings-sourced CA.

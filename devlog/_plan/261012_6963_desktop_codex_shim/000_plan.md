# 000 — #6963 Desktop app: Codex discovery and launcher shim install/repair

Issue: lidge-jun/opencodex#6963 (macOS 27, OpenCodex Desktop runs the proxy). Branch
`codex/6963-desktop-codex-shim-261012`, base origin/dev 7af092ca4f. Evidence came from three
read-only lanes (A discovery, B gating, C login verification); every item below was re-read
in source by main before planning.

## Reported state

Startup → Protection details: Desktop app "Installed but unhealthy" with
`startup.desktopSupervisedRecovery`; Background service and Codex launcher shim "Not
installed" with disabled Install buttons. The reporter tried CLI install/reinstall/uninstall and
Homebrew. No logs, Codex install method unknown.

## Root causes (verified in source)

1. **Shim actions share the service lock.** `gui/src/pages/startup-sections.tsx:91` disables
   every install/repair when `desktopManagesStartup(data)`; the recovery panel hides the shim
   command (`:273`). The documented reason (`261009_L1-desktop-cli/020`) covers service
   activation and update only. A shim runs `ocx ensure`, which returns without spawning when a
   live proxy answers (`src/cli/index.ts:804-843`), and plain `start` has no Desktop-ownership
   refusal. Nothing justifies blocking the shim.
2. **Dashboard installer child argv is wrong for the compiled Desktop `ocx`.**
   `src/server/startup-action-control.ts:163-166` always launches `[cli/index.ts, ...]`; the
   bundled `ocx` is a standalone Bun binary that treats that path as an unknown command. The
   probe beside it (`startup-health-cache.ts:128`) already uses `selfLaunchArgv`.
3. **Desktop sidecar has the GUI PATH.** `desktop/src-tauri/src/sidecar.rs:201-207` adds only
   two variables; a Finder/login launch gives `/usr/bin:/bin:/usr/sbin:/sbin`. Dashboard shim
   install (`findCodexOnPath`, `src/codex/shim.ts:143`) then reports "Native Codex launcher not
   found" for Homebrew, npm, bun, nvm/fnm/volta/mise installs, and an npm launcher's `node` is not
   on PATH for the install probe.
4. **Shim activation is judged against the sidecar PATH.** `overlayDiagnostic`
   (`src/codex/shim-overlay.ts:193`) asks whether the first `codex` on *this process's* PATH is
   the wrapper. Under Desktop that is never true, so a correctly installed and shell-activated
   shim reads "Stale" with a Repair button.
5. **Desktop row wording.** `startup-sections.tsx:103` labels any non-viable Desktop as "Installed
   but unhealthy", including a running, supervised proxy whose Start at Login is merely
   unverified. The tray checkbox reads only plist existence (tauri-plugin-autostart 2.5.0), while
   startup safety also requires launchd to have it enabled and loaded from the current app; the
   guidance "Turn on Start at Login" is useless when the checkbox is already on.
6. **Discovery refusals are reported as absence.** `installLocked` (`shim-overlay.ts:431`)
   discards `lastCodexDiscoveryError()` (fnm multishell refusal) and prints the generic message.

## Changes

### Server / CLI
- `src/server/startup-action-control.ts`: export `startupInstallChildArgv(action, options,
  launch?)` built on `selfLaunchArgv`; export `startupInstallChildEnv(action, deps?)`. For
  `install-shim` on darwin/linux while `isDesktopSupervised()`, PATH becomes the user's login
  shell PATH merged ahead of the current PATH. Service installs keep `process.env` unchanged
  (the launchd plist bakes PATH; #4236).
- NEW `src/lib/login-shell-path.ts`: `readLoginShellPath(deps)` runs `$SHELL -ilc` (absolute
  `SHELL`, else `/bin/zsh` on darwin, `/bin/sh` elsewhere) printing PATH between unique markers,
  stdin ignored, 3 s timeout, 64 KiB buffer; keeps only absolute entries without control
  characters. `mergeSearchPath(primary, fallback)` dedupes, primary first.
  `desktopCodexSearchPath(deps)` returns the merged PATH only when Desktop supervises this
  process on darwin/linux, cached for 60 s; any failure returns null (caller keeps PATH).
- `src/server/startup-health-cache.ts` `runProbe`: when `desktopCodexSearchPath()` is non-null,
  pass it to the probe child as `OCX_CODEX_SEARCH_PATH` (PATH itself untouched, so service
  diagnostics are unchanged).
- `src/codex/shim-overlay.ts`: activation lookup uses `OCX_CODEX_SEARCH_PATH` when set, else
  PATH. `installUnixOverlay(discover, describeMiss?)` reports the discovery refusal when present;
  the generic miss message names the searched scope ("on this process's PATH").
  `src/codex/shim.ts:1082` passes `lastCodexDiscoveryError` (no line growth; cap 1246).

### GUI
- `gui/src/startup-health-ui.ts`: `desktopBlocksServiceActions(health)` (alias of current
  predicate, named for what it blocks) and `desktopBadgeKey(desktop, failed)` →
  `startup.viable` | `startup.desktopLoginUnverified` (running, supervised/owned, login not
  verified) | `startup.unhealthy`.
- `gui/src/pages/startup-sections.tsx`: separate `serviceActionsDisabled` and
  `shimActionsDisabled`; shim install/repair and the shim recovery command stay available under
  Desktop management; service controls and command stay hidden/disabled.
- i18n (all 11 locales): add `startup.desktopLoginUnverified`; reword
  `startup.desktopSupervisedRecovery` and `startup.desktopRecovery` to say only service changes
  stay disabled, the launcher shim stays available, and to allow OpenCodex under System Settings
  → General → Login Items & Extensions (or toggle Start at Login off and on) when the menu
  already shows it on.

### Docs
- `structure/gui-and-management-api.md:502`, `docs-site/.../guides/desktop-app.md` (+ ko):
  shim stays available; installer child uses the login-shell PATH under Desktop.

## Tests (activation → observable)

| File | Case |
|---|---|
| tests/server/startup-action-control.test.ts | compiled launch → argv starts with `codex-shim`; source launch → entrypoint first |
| same | install-shim under Desktop supervision → PATH = login PATH merged first; service action and unsupervised → env PATH untouched |
| tests/lib/login-shell-path.test.ts (new) | marker parsing amid shell noise; relative/control entries dropped; exec failure/timeout → null; non-absolute SHELL → platform default; merge order/dedupe; not supervised → null without exec; cache reuse |
| tests/codex-integration/codex-shim-overlay-readiness.test.ts | installed overlay, PATH lacks wrapper, `OCX_CODEX_SEARCH_PATH` = wrapper dir first → healthy/active; unset → inactive |
| tests/codex-integration/codex-shim-fnm.test.ts | unresolved multishell through `installCodexShim` on Unix → message names fnm refusal |
| gui/tests/startup-minimal.test.tsx | Desktop-managed: service Install/Repair disabled, shim Install/Repair enabled, recovery shows `ocx shim install` and hides service command; supervised running + login off → "Start at Login not verified" badge |
| tests/gui/startup-health-ui.test.ts | `desktopBadgeKey` matrix |

## Verifier

`bun run typecheck`; focused `bun test` on every file above; `bun run test:changed`;
`bun run structure:check`; `bun run lint:gui`; `bun run privacy:scan`; `bun run build:gui`
for a screenshot (stubbed `/api/startup-health`, isolated port).

## Out of scope / follow-up

- Tauri tray "Start at Login" reads plist existence only and never reloads launchd; reporting the
  launchd-disabled state in the menu is Rust work → follow-up issue.
- Fallback discovery in well-known directories when the login shell fails; Codex.app's bundled CLI.
- Live service :10100, ~/.opencodex, Codex app, GOAT: untouched. Isolated homes/ports only.

## Risks

- Login-shell spawn runs user dotfiles (same as their terminal). Bounded by timeout, stdin
  closed, executed only for the shim installer child and health probe under Desktop supervision,
  cached 60 s.
- Policy change: shim no longer blocked while Desktop manages startup. Service guards unchanged.


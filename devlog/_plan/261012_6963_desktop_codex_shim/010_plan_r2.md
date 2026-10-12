# 010 — Plan r2 after A-round-1 (FAIL)

Supersedes the change list in 000. Root causes 1-6 in 000 stand as observations, with the
corrections from audit finding 7 (startup safety credits a verified enabled registration that is
*not loaded* in this session, desktop-startup.ts:113; toggling the tray setting rewrites the
plist and does not clear a launchd disabled override; causes 3-4 depend on Desktop being launched
with the GUI PATH).

## Response to round 1

| # | Finding | Decision |
|---|---|---|
| 1 BLOCKER | Unblocking the shim lacks a Desktop-safe `ensure` cold-start contract | Accepted. Shim/service gating under Desktop stays exactly as today. A Desktop-aware ensure (launch or wait for the app instead of spawning a CLI proxy) is a lifecycle design change → follow-up issue, not this PR. |
| 2 MAJOR | Dashboard install leaves activation/Repair loop | Moot for Desktop (gating unchanged). Recorded in the follow-up issue. |
| 3 MAJOR | Login-shell process contract under-specified | Accepted; login-shell PATH removed from this PR → follow-up issue. |
| 4 MAJOR | Merged PATH cannot attest activation | Accepted; no `OCX_CODEX_SEARCH_PATH`. Removed. |
| 5 MAJOR | Tests must hit the real seams | Accepted: installer test drives `runStartupInstallAction` through an exec seam; GUI fixtures add unowned supervision; fnm test goes through `installCodexShim`. |
| 6 MAJOR | Test-layout registration, structure docs, full suite | Accepted: no new test files (cases extend existing files); structure + docs-site updated; full suite run or exception recorded. |
| 7 MINOR | Login explanation wording | Accepted; wording below says "could not be verified" and points at Login Items allowance without promising toggling fixes a launchd override. |

## Changes (r2)

1. **Compiled installer argv** — `src/server/startup-action-control.ts` `runCliInstall` builds argv
   with `selfLaunchArgv(startupInstallArgv(...), { sourceEntrypoint: cli })`, the same builder the
   health probe uses (`startup-health-cache.ts:128`). Add a test-only seam
   `setStartupInstallLaunchForTests({ execFile?, isStandaloneExecutable? })` read by
   `runCliInstall`. Effect: dashboard Install/Repair works from the standalone `ocx` (Linux deb
   `/usr/bin/ocx start`, macOS bundled ocx run outside Desktop management, Desktop after supervision
   ends). Same defect class as #6276/#6222.
2. **Desktop row badge** — `gui/src/startup-health-ui.ts` new `desktopBadgeKey(desktop, failed)`:
   `startup.viable` when viable and not failed; `startup.desktopLoginUnverified` ("Running · Start at
   Login not verified") when not failed, `running`, owned-or-supervised and `!loginEnabled`;
   otherwise `startup.unhealthy`. `startup-sections.tsx:103` uses it.
3. **Supervised guidance** — reword `startup.desktopSupervisedRecovery` in all 11 locales: Start at
   Login could not be verified; turn it on in the OpenCodex menu; if it is already checked, make sure
   the system allows OpenCodex to open at login (macOS: System Settings → General → Login Items &
   Extensions); service and launcher shim stay disabled while the app runs the proxy — to use them
   instead, quit OpenCodex and run the command in a terminal. Add `startup.desktopLoginUnverified`
   in all 11 locales.
4. **Discovery refusal reason** — `installUnixOverlay(discover, describeMiss?)` in
   `src/codex/shim-overlay.ts`; on a null discovery it throws `describeMiss()` when non-empty, else
   the existing generic message. `src/codex/shim.ts:1082` passes `lastCodexDiscoveryError` (same
   line count).
5. **macOS app-bundled Codex runtime** — `src/codex/runtime.ts` `installedCodexCandidates`: on
   darwin append `/Applications/ChatGPT.app/Contents/Resources/codex` and
   `<home>/Applications/ChatGPT.app/Contents/Resources/codex` after the existing four entries
   (bundle shape measured in devlog/_fin/260913_cross_platform_desktop_app_restart/001; the Windows
   analogue is #4458). They are ordinary "installed" candidates, still `--version` probed, ranked
   after PATH and CLI installs, so a user CLI keeps precedence. Effect: Desktop's sidecar (GUI PATH)
   finds Codex when the only install is the Codex desktop app.

## Tests (all in existing files; red before, green after)

| File | Case |
|---|---|
| tests/server/startup-action-control.test.ts | `runStartupInstallAction("install-shim")` with seam standalone=true → exec argv `["codex-shim","install"]`; standalone=false → `[<cli/index.ts>, "codex-shim","install"]`; service repair argv likewise |
| tests/gui/startup-health-ui.test.ts | `desktopBadgeKey` matrix (viable, failed, running+login off owned/supervised, not running) |
| gui/tests/startup-minimal.test.tsx | unowned supervised fixture (owned:false + supervisor, running, login false): badge text "Start at Login not verified", guidance names Login Items, service+shim Install still disabled |
| tests/codex-integration/codex-shim-fnm.test.ts | Unix install with unresolved multishell first on PATH → refused message names fnm |
| tests/codex-integration/codex-runtime.test.ts (verify name) | darwin, empty PATH, only ChatGPT.app bundled codex exists → resolved, source installed; linux excludes it; PATH codex ranks first |

## Verifier

`bun run typecheck`; focused `bun test` on the files above; `bun run test:changed`;
`bun run structure:check`; `bun run lint:gui`; `bun run privacy:scan`; full `bun run test` (or
documented exception); GUI screenshot from `bun run build:gui` served on an isolated port with a
stubbed `/api/startup-health`.

## Docs

`structure/gui-and-management-api.md:502` (badge + compiled installer argv),
`structure/` owner of codex runtime candidates (locate), `docs-site/.../guides/desktop-app.md` +
`ko` (Login Items note).

## Follow-up issues (file after duplicate search)

- Launcher shim under OpenCodex Desktop: Desktop-aware `ensure` cold start, then unblock the shim;
  dashboard installer under GUI PATH (login-shell PATH with a bounded async contract); activation
  evidence scoped to the user's shell.
- Tray "Start at Login" reflects plist existence only (tauri-plugin-autostart 2.5.0), not launchd
  disabled/BTM state; startup safety can disagree with a checked menu item.


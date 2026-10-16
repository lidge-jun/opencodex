# 020 — Plan r3 after A-round-2 (FAIL)

Supersedes 010's change list. 000's statement "nothing justifies blocking the shim" is
**superseded** by A-round-1 finding 1: an ordinary Codex launch during a Desktop restart gap, or
after Desktop quits with its durable claim, would let `ensure` spawn a CLI proxy that displaces
Desktop supervision. The shim stays gated under Desktop management.

This PR **partially addresses** #6963: it fixes the dashboard installer for the standalone
`ocx`, the misleading Desktop badge and guidance, and the hidden fnm refusal reason. Disabled
Desktop shim installation, shell-PATH discovery/activation under Desktop, and app-bundled Codex
runtime discovery remain follow-ups (issues filed; reporter asked for their install method).

## Response to round 2

| # | Finding | Decision |
|---|---|---|
| 1 MAJOR | App candidate can take over a persisted CLI selection | Accepted. ChatGPT.app candidate **removed** from this PR. |
| 2 MAJOR | Catalog/prompt consumers unverified for the app binary | Accepted; removed with 1, recorded in the follow-up issue. |
| 3 MEDIUM | App identity/trust | Removed with 1. |
| 4 MEDIUM | Badge verification across production states | Accepted: rendered-page cases for owned and supervised, fresh running login-off, stale, failed read, stopped, verified; install/repair guards asserted. Owned recovery text unchanged (owned selects `desktopRecovery` first). |
| 5 MINOR | Scope/docs/verifier | Accepted: partial-fix wording above; `structure/gui-and-management-api.md:502` corrected (verified registration, not mandatory loading); `structure/runtime.md` untouched because runtime discovery is no longer changed; GUI test run separately (`cd gui && bun test ...`) plus i18n checks. |

## Changes (final)

1. `src/server/startup-action-control.ts` `runCliInstall`: argv =
   `selfLaunchArgv(startupInstallArgv(action, options), { sourceEntrypoint: cli, isStandaloneExecutable })`;
   test seam `setStartupInstallLaunchForTests({ execFile?, isStandaloneExecutable? } | null)`.
2. `gui/src/startup-health-ui.ts` `desktopBadgeKey(desktop, failed)`: `startup.viable` when
   `!failed && viable`; `startup.desktopLoginUnverified` when `!failed && running &&
   !loginEnabled && (owned || supervisor)`; else `startup.unhealthy`. Production `failed` already
   includes `diagnosticStale` (Startup.tsx:249-250), so stale readings never get the new badge.
   `startup-sections.tsx` Desktop row uses it. Install/repair gating unchanged.
3. i18n, 11 locales: new `startup.desktopLoginUnverified`; reworded
   `startup.desktopSupervisedRecovery` (Start at Login could not be verified; turn it on in the
   OpenCodex menu; if already checked, make sure the system allows OpenCodex to open at login —
   macOS: System Settings → General → Login Items & Extensions; service and launcher shim stay
   disabled while the app runs the proxy; to use them instead, quit OpenCodex and run the command
   in a terminal).
4. `src/codex/shim-overlay.ts` `installUnixOverlay(discover, describeMiss?)` throws the discovery
   reason when present; `src/codex/shim.ts:1082` passes `lastCodexDiscoveryError`.

## Tests (existing files)

| File | Case |
|---|---|
| tests/server/startup-action-control.test.ts | via `runStartupInstallAction`: standalone → `["codex-shim","install"]`, `["service","repair"]`; source → entrypoint first; failure path still rejects with detail |
| tests/gui/startup-health-ui.test.ts | `desktopBadgeKey` matrix: viable, failed+viable, running login-off owned / supervised, not running, neither owned nor supervised |
| gui/tests/startup-minimal.test.tsx | supervised (owned:false+supervisor) running login-off: badge "Start at Login not verified", guidance mentions Login Items, service+shim buttons disabled; owned running login-off: same badge, owned recovery text; stopped owned: "Installed but unhealthy"; stale reading (`diagnosticStale:true`) running login-off: not the new badge |
| tests/codex-integration/codex-shim-fnm.test.ts | Unix `installCodexShim` with an unresolved fnm multishell first on PATH → refused, message names fnm |

## Verifier

`bun run typecheck`; `bun test` on the three repo test files; `(cd gui && bun test tests/startup-minimal.test.tsx)`;
`bun run test:changed`; `bun run structure:check`; `bun run lint:gui`; `bun run privacy:scan`;
full `bun run test` or recorded exception; GUI screenshot (isolated port, stubbed health).

## Follow-up issues

1. Launcher shim under OpenCodex Desktop: Desktop-aware ensure cold start, then unblock; shell PATH
   discovery/activation contract for the GUI-launched sidecar.
2. Tray Start at Login reflects plist existence only; launchd/BTM disabled state invisible.
3. macOS app-bundled Codex CLI (ChatGPT.app, `com.openai.codex`) as a runtime candidate: handover
   policy vs persisted selections, catalog/prompt debug-command compatibility, identity checks.


## Round 3 (NEAR-PASS) folds

- Rendered-page matrix adds: failed refresh retaining prior Desktop data (no new badge), viable
  Desktop green "Ready" badge, and loading/busy install+repair guards with Desktop management
  absent (existing CLI-owned fixture).
- Verifier adds `(cd gui && bun run build && bun run lint:i18n)`.


Filed: #6971 (launcher shim under Desktop), #6972 (tray Start at Login vs launchd), #6973 (ChatGPT.app bundled Codex CLI).

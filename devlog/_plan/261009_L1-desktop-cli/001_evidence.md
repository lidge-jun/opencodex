# 001 — Reproduction evidence (2026-10-09, reporting Mac)

- Desktop 2.81.0 pid 36806 `/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop`; its child pid 36826
  `/Applications/OpenCodex.app/Contents/MacOS/ocx start --port 10100`, env `OCX_DESKTOP_SUPERVISED=1`,
  `OPENCODEX_GUI_DIST=…/Resources/gui/dist`. `~/.opencodex/ocx.pid` = 36826; `runtime-port.json` = {pid, port, attestationSecret}.
- `ocx resolve --json` (bundled 2.81.0): `ownership {kind:none, revision:14}`,
  `takeover {kind:blocked, reason:managing-cli-unknown, detail:"service-registration compatibility could not be determined"}`,
  liveness live, versionSkew match.
- `~/.opencodex/service-state.json`: version 2, backend scheduler, ownershipProtocolVersion 1, bunPath
  `<dev checkout>/node_modules/bun/bin/bun.exe` (missing), cliPath `<dev checkout>/src/cli/index.ts`. The launchd
  plists `OpenCodex.plist` (Desktop login item) and `com.opencodex.proxy.plist` (service) were moved to
  `~/Library/LaunchAgents-disabled-20261005/` during a user-requested login-item cleanup, so the record is stale and
  Start at Login is effectively off.
- `ocx status --json` (bundled): `startup.protection none`, `status at-risk`, `recommendedCommand "ocx service install"`,
  no `startup.desktop` key; human output "Runtime source: standalone" (that is the CLI's Bun source,
  `src/lib/bun-runtime.ts:170`), "Restart safety: AT RISK after restart (no viable background service; run 'ocx service install')".
- PATH: `~/.bun/bin/ocx` → dev checkout `bin/ocx.mjs` (no node_modules) fails at `bin/ocx.mjs:930` although
  `~/.bun/bin/bun` 1.4.0 exists; nvm global 2.7.43; `/opt/homebrew/bin/ocx` → npm dist launcher, same Bun failure.

Why the CLI misses it (code):
- `src/service/desktop-startup.ts:55,69,138` return `undefined` unless the durable claim owner is `desktop`,
  so no process evidence is gathered for an unowned Desktop child.
- `src/codex/autostart-health.ts:93-110` credits desktop protection only when `desktop.owned`.
- `src/cli/status.ts:262` rejects an attested live startup-health payload whose protection is `desktop`
  (latent bug for owned installs too).
- `src/cli/doctor.ts:1687` turns a null recommendedCommand into `ocx restore`.
- `src/update/runtime-ownership.mjs:40-76` permits stop/replace/refresh whenever no non-CLI claim exists.
- Inside the runtime, `src/lib/system-restart-contract.ts:80-114` knows it is Desktop-supervised, but the
  startup-health probe runs in a separate `__startup-health` child (`src/server/startup-health-cache.ts` runProbe),
  so that process-local fact never reaches the diagnostic.


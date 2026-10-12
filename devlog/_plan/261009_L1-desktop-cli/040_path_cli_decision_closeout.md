# 040 — wp4: Desktop PATH CLI decision and lane closeout

## Decision record (Pascal D6, accepted)

**Decision:** do not add a Desktop PATH installer in this lane. Record the gap, point users at the bundled CLI, and
leave a scoped follow-up design.

Evidence:
- macOS: the DMG flow is drag-to-Applications (`docs-site/src/content/docs/guides/desktop-app.md`); nothing writes a
  PATH entry. The bundled CLI is `/Applications/OpenCodex.app/Contents/MacOS/ocx` (or under `~/Applications`).
- Windows: `desktop/src-tauri/tauri.conf.json` WiX settings add no PATH entry; the sidecar `ocx.exe` sits beside
  the app in the install location (uninstall-registry `InstallLocation`).
- Linux: the deb ships `/usr/bin/ocx` (`desktop/scripts/linux-packaged-e2e.ts`), so PATH already works there; the
  AppImage's `usr/bin/ocx` lives in a transient mount and must never be linked.

Why not now: a PATH writer has to resolve collisions with npm/pnpm/Homebrew/bun-link launchers the user already has
(the reporting Mac has four), refuse to replace files it does not own, survive app moves and upgrades, and remove only
its own artifacts on uninstall. Doing that inside the Tauri shell needs a native command plus UI and an installer
change on Windows — a feature with its own review, not part of fixing the authority bug. wp2/wp5 make an updated CLI
on macOS or Linux defer to the Desktop runtime (older installs such as 2.7.43 cannot gain this), and wp3 makes the package launcher work with a valid Bun and names the Desktop
CLI when it cannot.

Follow-up design (for a separate unit): native `desktop/src-tauri/src/` command behind a local-origin UI action
"Install ocx command"; preview destination (`~/.local/bin` / user PATH on Windows) and what currently resolves for
`ocx`; write a symlink (macOS/Linux) or a user-PATH entry (Windows) marked as Desktop-owned; refuse foreign files;
remove on uninstall; never link into an AppImage mount.

## Docs for this decision (lands with PR C)

docs-site desktop guide (en + ko): a short "Using the ocx CLI with the desktop app" section — the bundled CLI path per
platform, that `ocx status` from an updated CLI on macOS or Linux reports the Desktop supervisor, and that Desktop updates come from the app's
updater.

## Closeout checklist (D of wp4)

1. PR A, PR B (stacked on A), PR C: exact-head CI green, independent sol review PASS recorded with run ids and SHAs.
2. Rebased on latest origin/dev before the last push; overlaps with lanes L2 (service/restart, #6649) noted in PR text.
3. Final report: PR links, head SHAs, CI runs, open decisions (Windows evidence, GUI wording for unowned supervision,
   PATH installer follow-up), user-environment suggestions (remove stale `~/.opencodex/service-state.json` via
   `ocx service uninstall` from a working CLI, re-enable Start at Login, repoint `~/.bun/bin/ocx`) — suggestions only.

## Outcome (wp4, 2026-10-09)

Decision unchanged: no Desktop PATH installer in this lane. What users get instead:

- #6802: `ocx status`/`doctor`/`resolve` from an updated CLI name OpenCodex Desktop as the live supervisor and stop
  recommending `ocx service install`; the docs-site desktop guide (en/ko) gained "Using the ocx CLI with the desktop
  app" with the bundled CLI path per platform.
- #6807: when the package launcher cannot run, its failure text names `/Applications/OpenCodex.app/Contents/MacOS/ocx`
  (or the `~/Applications` copy) when installed; a usable PATH Bun now runs the CLI instead of failing.
- PR B (wp5): command guards so an updated CLI refuses to compete with the Desktop runtime.

Follow-up (separate unit, not opened by this lane): the native "Install ocx command" design above. The coordinator
thread took it on as `codex/desktop-owned-path-cli`; this lane does not touch that scope.

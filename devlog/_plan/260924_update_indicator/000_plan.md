# 260924 update indicator

Service installs of opencodex never learn that a new version exists: the sidebar's blue update orb reads `~/.opencodex/version.json`, and that cache is refreshed only by an interactive `ocx start`. The desktop app has the opposite gap: its Tauri updater knows about updates, but the GUI inside the app asks the compiled sidecar, which classifies itself as a source build and never lights the orb. This unit makes the package cache refresh itself inside the running proxy without blocking requests, lets the desktop app publish its own updater state to the GUI it hosts, and puts a blue dot on the tray icon itself on the macOS menu bar, the Windows and Linux Tauri trays, and the npm Windows PowerShell tray. Users on any install see one consistent signal, and in the desktop app the update button installs the app update instead of the npm package.

Research input: [001_sol_plan_draft.md](001_sol_plan_draft.md) (first planning draft plus coordinator review). External survey of Codex, Claude Code, gemini-cli, Ollama, cloudflared, Tauri apps and UI badges was done with Aside and is summarised in the PR, not copied here.

## Loop spec

- **Loop archetype:** satisfy-spec, multi-cycle HOTL (one work-phase per PABCD cycle).
- **Trigger:** the owner asked for tray and menu-bar blue update indicators on top of the update-signalling fixes, planned by sol and shipped as one PR ("그 가정으로 cxc-loop 해서 pr 날려놔").
- **Goal:** the four behaviours in the work-phase map below, landed as ordered commits on `codex/update-indicator` with one PR to `dev`.
- **Non-goals:** automatic installation policy; npx, Volta, Yarn and Homebrew install detection; a light/dark redesign of the Windows Tauri base tray glyph; merging, releasing or deploying; unrelated refactors.
- **Verifier:** focused Bun tests named in each decade doc, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `cd gui && bun run lint && bun run build` for GUI commits, `cargo test --manifest-path desktop/src-tauri/Cargo.toml` for desktop commits, then exact-head hosted CI on the PR. Visual tray rendering is human review (see Stop condition).
- **Stop condition:** PR open against `dev` with every template section filled and exact-head CI inspected, branch-caused failures fixed. macOS menu-bar rendering is checked locally; Windows and Linux tray rendering cannot be observed on this Mac and is reported as NEEDS_HUMAN, not claimed.
- **Memory artifact:** this unit directory, the codexclaw goalplan `ship-end-to-end-update-available-signalling-for`, and the PR description.
- **Expected terminal outcomes:** DONE (PR open, gates green or branch-caused failures fixed); BLOCKED (push or PR creation rejected, CI unavailable after investigation); UNSAFE (a change would weaken management auth or updater signature verification); NEEDS_HUMAN (cross-platform visual QA).
- **Escalation condition:** any change to management authentication semantics, updater signature checks, or the Lab boundary files stops for the owner. A worker that fails the same packet twice is reclaimed by main after its work is stopped (DISPATCH-RETIRE-01); moving a slice to a worker mid-B needs a P amendment.
- **Resource bounds:** tools are the local shell, git, gh (push and PR creation authorised, merge not), Bun and Cargo; write scope is this worktree; gpt-6-sol subagents are authorised without a count limit; no token or wall-clock budget was set by the owner.

## Work-phase map

Dependency order follows the build order: the package cache is the foundation the badge and the npm tray read; the desktop snapshot and icons need the badge route shape from commit 1; the desktop update page consumes the desktop state from commit 2; the npm Windows tray only needs commit 1 and is last because it is independent.

| Work-phase | Commit | Decade doc |
| --- | --- | --- |
| wp0 | none (this roadmap) | 000_plan.md |
| wp1 | 1. package cache freshness and async checks | [010_phase1_package_cache.md](010_phase1_package_cache.md) |
| wp2 | 2. desktop update snapshot and tray blue dot | [020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md) |
| wp3 | 3. desktop GUI update page | [030_phase3_desktop_update_page.md](030_phase3_desktop_update_page.md) |
| wp4 | 4. npm Windows tray indicator | [040_phase4_windows_npm_tray.md](040_phase4_windows_npm_tray.md) |
| wp5 | none (verification, push, PR, CI) | recorded in 050_delivery.md at wp5 |

## Decisions

Architect proposal from McClintock (gpt-6-sol, read-only, agent 01a0d34a-4b14-7aa1-aca3-b42310f6b3d3), decisions D1-D7. Main dispositions:

| ID | Proposal | Disposition |
| --- | --- | --- |
| D1 macOS | Keep the template glyph; draw the dot in a transparent NSView on the NSStatusBarButton via the Swift bridge (app/Sources/NativeTray), positioned against the image, removed when cleared. tray-icon 0.24.2 `set_icon` does not remove subviews. | **Accepted.** Keeps system tinting and highlight correct without guessing the menu-bar appearance. |
| D2 Windows/Linux | Swap PNG variants with a haloed blue dot; also add light/dark Windows base glyphs. | **Amended.** Dotted variants accepted. The light/dark base glyph is out of scope (owner-fixed non-goal); recorded as a follow-up. |
| D3 snapshot | `POST /api/update/desktop-snapshot`, admin-token principal only, bounded scalar payload keyed by a random desktop session id, in-memory with bounded entries, 60 s heartbeat, ~3 min expiry; `GET /api/update/badge?surface=desktop&session=<id>` returns `installer: "desktop"` or `unknown: true`. Session id travels in the embedded dashboard URL. | **Accepted.** No installation authority, no persistence, no logging of the session id. |
| D4 page | Bundled `desktop/ui/update.html` on the app origin with narrow Tauri commands; tray and page share one install function with a compare-and-swap claim. | **Accepted.** No updater IPC for the loopback dashboard. |
| D5 refresh | Scheduler worker in `src/update/`, tiny start/stop hook in `src/server/index.ts`; async `child_process.spawn` through `registrySpawnTarget`, 12 s kill, bounded output; write-through; coalesce per channel; backoff; 40 h max cache age reports unknown; skipped for source and mise installs; `/api/update/run` awaits the async check and passes the result into `startUpdateJob`. | **Accepted.** Keeps the Lab boundary and the synchronous `startServer` window intact. |
| D6 npm tray | Hidden read-only CLI command printing `readUpdateBadge()` JSON, probed every 60 s, bounded and non-overlapping; six icons (online, warning, offline × normal, dotted); update menu item opens the dashboard. | **Accepted.** Probe cost on Windows is measured in CI only; cadence stays 60 s with a timeout. |
| D7 commits | Four ordered commits with the file scopes and docs owners listed. | **Accepted.** |

Reflection by the same architect: recorded below after the decade docs are written.

## Source-of-truth sync

- `structure/runtime.md` and `structure/ops/service-and-sidecars.md` own `src/update/` and `src/tray/` (commits 1 and 4).
- `structure/gui-and-management-api.md` owns the management routes (commits 1-3).
- `structure/desktop-shell.md` and `structure/companion.md` own `desktop/` (commits 2-3).
- docs-site: `reference/management-api.md`, `guides/desktop-app.md`, `guides/macos-menu-bar.md`, `guides/web-dashboard.md`, `reference/cli/lifecycle.md`, each with its existing locale siblings.

### Main decisions raised by decade writers

- 010: no update-check opt-out exists today. **Accepted** `OCX_DISABLE_UPDATE_CHECK=1` as a documented opt-out for automatic checks (the scheduler); explicit `/api/update/check` still runs. The Bun test preload must set it so test-started servers never spawn a registry lookup.
- 040: the PowerShell source assertion stays in `tests/windows/tray-proxy.test.ts` next to the existing probe assertions.
- 020: `structure/runtime.md` is at its 600-line budget. **Amendment for 010 and 040:** runtime.md edits must be net-zero (replace sentences, do not add); the new scheduler/probe prose goes to `structure/ops/service-and-sidecars.md`. Each B re-checks the structure line budgets with `bun run structure:check` before committing.
- 020: `cargo test` needs the sidecar placeholder `desktop/src-tauri/binaries/ocx-<target-triple>`. wp2 B reuses whatever CI uses to satisfy `externalBin` for Rust tests (checked at wp2 P), and never commits a built binary.
- 030 cites 020 line numbers that moved while 020 was written; symbol names are authoritative, line numbers are refreshed at each cycle's P.

## Architect reflection

McClintock (same agent) returned **MISALIGNED** with eight material and three minor gaps against revision 1 of the decade docs. Main accepted all eleven and assigned the fixes: 010 gets net-zero runtime.md edits, explicit-check write-through independent of a joined automatic flight (join-then-stop regression), a non-source injected route regression proving the event loop stays responsive, and an explicit one-server-per-process scheduler invariant; 020 separates heartbeat receipt age from `checkedAtMs`, adds a native check generation so only the latest completed check applies, and limits the post-title redraw to macOS; 030 refreshes phase-2 anchors by heading and consumes the phase-2 check generation; 040 makes the general-suite icon test renderer-independent (structural checks; byte-exact generator `--check` stays a local/desktop tool), caps probe output bytes, replaces the synchronous `WaitForExit` on the UI tick with a request-and-reap across ticks, and makes runtime.md edits net-zero. Revision 2 is sent back to the same architect before audit.

Re-reflection on revision 2: all eleven gaps CLOSED; two new material gaps in the desktop check/install flow (install claim outside the check-application critical section; a superseded page check reporting "up to date"). Main accepted both; one writer revises 020 and 030 together into revision 3.

Re-reflection on revision 3: both gaps CLOSED; one new material deadlock risk (tray setters that wait on the AppKit thread were called while the gate mutex was held, and a synchronous status command could wait on that mutex from the main thread). Main accepted it; revision 4 moves UI projection outside the gate with a generation re-check and makes gate-reading commands async.

Re-reflection on revision 4: deadlock gap and both rev-3 gaps CLOSED; one new material gap (a no-pending install click committed the install flag and epoch before discovering there was nothing to install, orphaning an in-flight check). Main fixed it directly in 030 (revision 5): `claim_install` returns `InstallClaim::{Claimed,Busy,NoPending}`, reads the pending version under the gate before committing anything, and a new regression `install_click_without_pending_leaves_in_flight_check_valid` covers it; the tray install arm uses the same call.

Re-reflection on revision 5: **ALIGNED** (McClintock). No material gap remains; all reported gaps are closed with regressions named in the decade docs. This completes architect consultation for wp0; the independent A audit follows.

## Audit

Independent reviewer Bohr (gpt-6-sol, agent 01a0d39a-32c8-7553-8d80-9b2fff2ef419). Round 1: FAIL with three High test-specification blockers (inherited commit-2 claim_install test breaks in commit 3; registry child failure paths untested; Windows stale-dot expiry untested) and two non-blocking notes; all accepted and folded (030 by main, 010 and 040 by fixers, 020 note by main). Round 2: FAIL with one High blocker (the new failure tests expected the retry timer after eight microtask turns; Bohr measured sixteen); main added a bounded `settle()` fixture wait in 010.
Round 3: **PASS** — the reviewer re-executed the planned scheduler and lookup in memory with the settle helper; all five failure scenarios reach the retry timer and recover. No High or Critical blocker remains.

## wp1 Check review

Implementation reviewer Noether (gpt-6-sol, agent 01a0d3be-6826-71c1-9ceb-331b2db6b176) on commit 1:
- **Medium, accepted and fixed:** an automatic tick after stop/start joined the stopped listener's pending flight, whose write the old generation suppressed, pushing the next check an hour out. Flights now carry their epoch and automatic ticks only join a same-generation flight; regression `restart does not join the stopped listener's pending lookup` fails on the pre-fix scheduler and passes after (red-green verified). Folded into commit 1.
- **High, rebutted for this unit:** on Windows, `POST /api/update/run` still reaches `spawnGuiUpdateWorker`'s 15-second-bounded `spawnSync` of PowerShell `Start-Process` (src/update/job.ts). It predates this unit, runs once per user-initiated install immediately before the proxy restarts, and 010 scoped the detached installer worker OUT. Making it asynchronous changes `startUpdateJob`'s lock-then-launch contract in a file with seven lines of headroom. Recorded as a follow-up in the PR; this unit's claim is limited to the registry check path.
- Round 2 (Noether): rebuttal accepted; GO-WITH-FIXES with 0 blockers. Medium (an older explicit flight could overwrite a newer generation's write after stop/start) fixed with per-channel flight sequencing and a red-green regression; Low (010's scheduler block no longer matched) fixed with an authoritative amendment note above that block.

## wp1 Done

Commit 1 (`feat(update): refresh the package update cache inside the running proxy`) shipped the scheduler, async registry lookup, write-through and 40 h unknown badge. Evidence: receipt 425 pass / 0 fail with typecheck, structure and privacy; reviewer PASS after two scheduler fixes (stop/start flight join, flight ordering) found in Check. What did not improve: Windows `/api/update/run` still launches the installer through a bounded synchronous PowerShell call (follow-up). What would show this direction wrong: a service install whose badge stays unknown for more than a day with network access. Next: wp2 per 020.

## wp2 Check review

Implementation reviewer Ohm (gpt-6-sol, agent 01a0d3d7-409a-7892-ad81-d0bdedc0fa41) round 1 on commit 2: FAIL. Accepted and being fixed in commit 2: (1) High, the snapshot POST accepted browser-origin requests — reject any `Origin`; (2) High, startup `wake()` could republish a stale snapshot — make notify atomic with publish; (4) Medium, the companion link lost `#/usage/companion` — preserve the validated fragment. (3) High, the tray install arm takes `PendingUpdate` outside `CheckGeneration::claim_install`: deferred to commit 3, whose plan (030) converts the tray arm to the gated three-way claim; wp3 Check must verify it is closed on the combined branch.

macOS visual QA (commit 2): the real `UpdateDotView`/`UpdateDot` code from `app/Sources/NativeTray/Popover.swift` was compiled into a local harness, attached to real `NSStatusItem`s using `desktop/src-tauri/icons/tray/icon.png` as a template image, and rendered with `cacheDisplay` under aqua and darkAqua, with and without a title. The template glyph keeps its system tint in both appearances, the 7 pt blue dot sits at the glyph's lower right with a background-coloured halo, and a title does not overlap it. Limits: cached rendering does not reproduce the live menu-bar selection tint, and the live menu bar on this machine hid the harness items (crowded bar), so on-bar placement across displays remains human QA.
Round 1 fixes folded into commit 2: the snapshot POST now refuses any `Origin` (403, fixed body, no store write; red-green verified); `wake()` notifies without replacing the current snapshot and the companion link keeps its validated fragment (both red-green verified; cargo 139 pass, clippy and fmt clean). A test demanding that the outer management CORS wrapper omit `Access-Control-Allow-Origin` on this 403 was dropped: the wrapper is shared by every management route, the refusal body is a fixed string, and the boundary (refusal plus no write) holds without changing that shared layer.

## wp2 Done

Commit 2 (`feat(desktop): publish updater state to the GUI and dot the tray icon`) shipped the desktop snapshot route, per-session desktop badge, native check generation and UI projection worker, the macOS NSView dot and the dotted Windows/Linux PNG. Evidence: receipt 478 Bun + 4 GUI + 139 cargo pass with clippy, icons, typecheck, structure and privacy; reviewer GO-WITH-FIXES with zero blockers. Carried into wp3: the tray install arm must move onto the gated `claim_install` (reviewer High, deferred by plan). What would show this direction wrong: a dotted tray icon that stays after the update installs, or a GUI orb that disagrees with the tray.

## wp3 Done

Commit 3 (`feat(desktop): route the desktop update button to a bundled update page`) shipped `desktop/ui/update.html` with four app-origin Tauri commands, the shared `InstallClaim` gate for tray and page (closing the wp2 High), the page checking state, and desktop-only GUI routing with ten catalogs. Evidence: receipt 485 Bun + 5 GUI + 147 cargo pass with lint, i18n lint, clippy, typecheck, structure and privacy; reviewer Mill PASS with no findings. A pending-state screenshot of the page (headless Chrome with a stubbed invoke) is kept outside the repository for the PR. Packaged cross-origin navigation on Windows and Linux remains human QA. Next: wp4 per 040.

## wp4 Check notes

Commit 4 builds the dotted Windows icons from the shipped base frames; a local contact sheet at 16 and 32 px on light and dark backgrounds shows the status colours unchanged (online cyan, warning yellow, offline grey) with a white-haloed blue dot at the lower right, and all nine frame sizes present. PowerShell child-process scenarios cannot run on this Mac (no pwsh) and are left to the Windows CI legs.
Implementation reviewer Kierkegaard (gpt-6-sol, agent 01a0d417-79b9-7980-b94c-4d256aa5b24c) round 1: FAIL, one High — an install made before the dotted icons existed had only the three base icons, the ownership check required all six, so the tray was classified stale and the updater stopped it without reinstalling. Fixed in commit 4: `windowsTrayRequiredFilesPresent` requires only the base icons (the dotted ones stay in install/rollback/uninstall lists and the script falls back to the base icon); regression `an install from before the dotted icons still owns its registration` fails when all six are required and passes after.

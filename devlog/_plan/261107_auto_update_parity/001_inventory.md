# Update parity inventory

Baseline: OpenCodex `803d6c0b4dbb4823a9379e485e417f3f9e3d976c`; GOAT
`64e7198988b69941cd2eec5160fd734df9074302` (`origin/dev`). GOAT paths below
refer to that read-only Git revision. The independent architecture inventory
informed this comparison. The audit recorded in `000` covers an earlier named
snapshot; the current revision and its independent review remain open.

| Surface | Existing evidence | Initial gap to investigate |
| --- | --- | --- |
| Desktop checks | OpenCodex checks after 30 seconds and every six hours (`desktop/src-tauri/src/updater.rs:448`). GOAT starts after 15 seconds and checks every four minutes (`apps/desktop/src/updates/DesktopUpdates.ts:69`, `:1036`, GOAT revision above). | Decide cadence and user controls; do not add a duplicate scheduler. |
| GOAT Electron integration | GOAT wraps the platform updater and installs a request deadline before first use (`apps/desktop/src/electron/ElectronUpdater.ts:90`, `:100`, `:120`, GOAT revision above); its test verifies lazy initialization and that deadline (`apps/desktop/src/electron/ElectronUpdater.test.ts:38`, `:46`). The Electron app wrapper exposes quit/relaunch and the before-quit-for-update event (`apps/desktop/src/electron/ElectronApp.ts:166`, `:174`, `:234`, GOAT revision above). Automatic-update tests cover pause, retry, reservation and busy-at-admission cases (`apps/desktop/src/updates/DesktopUpdates.automatic.test.ts:91`, `:116`, `:271`, `:652`, GOAT revision above). | Use bounded requests and verify equivalent behavior through Tauri's own owner; no Electron code is imported into OpenCodex. |
| Desktop download and install | OpenCodex downloads through the pinned updater, which verifies the signature, before its guarded restart and install; failed install can recover the runtime (`desktop/src-tauri/src/updater.rs:388`, `desktop/src-tauri/src/updater.rs:423`). | Expose progress and verified staged readiness while preserving signature verification and drain/recovery. |
| Desktop badge | The desktop snapshot includes a session, version, availability, timestamp and phase (`src/update/desktop-badge.ts:4`); the badge projection currently exposes availability and unknown but discards the phase (`src/update/desktop-badge.ts:74`). | Carry authoritative progress and failure states to the footer without treating missing or stale evidence as current. |
| Sidebar | `gui/src/components/sidebar-github-row.tsx:77` polls the badge and `:157` renders the existing download button; `gui/src/App.tsx:591` opens the native update page on desktop. The version is rendered at `gui/src/App.tsx:602` and deliberately ellipsized by `gui/src/design/bridge.css:429`. Native update commands require the trusted update page (`desktop/src-tauri/src/lib.rs:272` at the baseline above). | Make that button the requested stateful update-panel entry and resolve the reported truncated version; retain browser/package behavior and the existing native command origin boundary. |
| Package updates | The Node launcher imports the existing orchestrated plan/apply, installation ownership, transactional install and guarded runtime mechanisms (`bin/ocx.mjs:50`, `bin/ocx.mjs:69`). The CLI advertises latest/preview plans and token-bound apply (`bin/ocx.mjs:1322`). npm publication uses trusted publishing with generated provenance (`.github/workflows/release.yml:1152`). | Reuse ownership and guarded apply contracts, and require the requested publisher signature verification for update artifacts. Validate a concrete signed supply and its availability before treating provenance as a solution. Distinguish package and signed desktop-bundle supply. |
| Package notification | Version cache refresh interval is 20 hours, with a 40-hour maximum cache age (`src/update/notify.ts:19`); background refresh is detached when stale (`src/update/notify.ts:182`). The in-process scheduler honors `OCX_DISABLE_UPDATE_CHECK=1`, avoids unsupported installers and backs off after failed checks (`src/update/refresh-scheduler.ts:24`, `:52`, `:87`). | Preserve the existing opt-out and no-refresh semantics while adding explicit independent controls. |
| Browser dialog | The existing dashboard update dialog offers latest/preview, checks, errors, restart choice and an explicit update action (`gui/src/pages/dashboard-dialogs.tsx:29`). | Keep its installed-package semantics consistent with any shared state and copy. |
| Channels | OpenCodex's configured Tauri feed uses `latest.json` (`desktop/src-tauri/tauri.conf.json:68`); release verification generates that manifest only with the updater signing key and requires signatures in that case (`.github/workflows/release.yml:824`). npm uses `latest` and `preview` tags (`.github/workflows/release.yml:1051`). GOAT publishes stable and nightly feeds; its documented preview is a PR build, not a third published feed (`docs/internals/release-channels.md:19`, `docs/internals/release-channels.md:80`, GOAT revision above). | Establish actual artifact availability before presenting a channel as usable; never invent a nightly feed or treat a digest as a signature. |
| GOAT update states and policy | GOAT's state includes install policy, available and downloaded versions, release notes, download percent and retry information (`apps/desktop/src/updates/updateMachine.ts:18`, GOAT revision above). Its default downloads and restarts when local servers are idle **or on quit**; alternatives are install on quit and paused, with manual update still available (`docs/user/updating.md:120`, `:128`). WSL servers that cannot report idleness defer idle restart until quit or manual installation (`:136`). The coordinator disables electron-updater's implicit auto-download and install-on-quit and controls the sequence itself (`apps/desktop/src/updates/DesktopUpdates.ts:1398`); the paused policy blocks automatic downloads (`:620`). | Model the full state and user-controlled sequence without confusing library flags with the actual product policy. |
| Linked machines | Home fan-out sync selects and version-checks the Child executable before invoking sync (`structure/remote-link.md:9`, `src/link/ssh-argv.ts:281`); this is configuration sync, not evidence of binary update capability. OpenCodex already derives link compatibility from authenticated relay version and peer features (`src/link/compatibility.ts:71`, `src/remote/features.ts:44`). GOAT describes exact-build updates, idle gating and protocol-range compatibility (`docs/internals/remote-updates.md:19`, `:100`, GOAT revision above). GOAT's runtime supply documents HTTPS plus `SHA256SUMS`, without detached signatures (`docs/internals/remote-updates.md:163`, GOAT revision above). | Extend the existing compatibility and authorization owners for update capabilities rather than duplicating them; prove signed provenance and safe remote execution separately from sync. The user's signature requirement is stricter than the referenced runtime supply and remains mandatory. |
| Fan-out and orchestrator contracts | [PR #8100](https://github.com/lidge-jun/opencodex/pull/8100) merged to `dev` as `4948c04d9ced0cae90779ce03196088cc97aa906`. Current source advertises `sync.home-fanout/1` and `update.orchestrated/1` (`src/cli/capability-contracts.ts:1`). Fan-out waits for a current Home catalog, skips client-initiated/disconnected links, bounds concurrency to three and records per-Child results (`src/cli/sync-fanout.ts:99`). | Preserve both advertised contracts and avoid converting catalog sync into implicit binary installation; add a separately versioned update operation. |
| Server rollout and recovery | GOAT's server auto-update is on by default and separately disableable; stable/nightly remain on their channel and preview/dev/PR do not auto-update (`structure/decisions/ADR-0019-update-compatibility.md:50`, GOAT revision above). Stable waits 48 hours then rolls out over 72 hours, nightly rolls out over 12 hours without soak, and missing publication time is ineligible (`apps/server/src/cloud/autoUpdatePolicy.ts:79`). Busy activation retries every 10 minutes; a failed target is suppressed (`structure/decisions/ADR-0019-update-compatibility.md:57`, `:64`). A launcher trial needs exact-version and protocol health within 30 seconds, followed by 10 minutes' probation and owner-checked snapshot rollback (`:69`). | Assess each guarantee against OpenCodex's actual installation and service model; checksums alone must not be presented as publisher signature verification. |
| Isolated mock feed | GOAT's mock server serves files from a configured real root on localhost (`scripts/mock-update-server.ts:19`, `:111`, `:144`, GOAT revision above); its tests reject traversal and escaping symlinks (`scripts/mock-update-server.test.ts:23`, `:50`). Its release smoke uses a temporary root and validates merged manifests (`scripts/release-smoke.ts:216`, `:298`, GOAT revision above). | Build equivalent isolated fixtures for Tauri and package formats with test-only keys, bounded responses, failure injection and no access to real homes. GOAT's preview manifest smoke fixture is not evidence of a published preview feed. |
| Telemetry | GOAT updater code emits internal logs and spans (`apps/desktop/src/updates/DesktopUpdates.ts:485`, `:1232`, GOAT revision above). GOAT documents product usage and relay telemetry and an opt-out (`docs/user/telemetry.md:3`, `:23`, GOAT revision above); its desktop observability layer can export logs/traces to configured OTLP endpoints (`apps/desktop/src/app/DesktopObservability.ts:778`, `:803`, `:826`, GOAT revision above). This does not establish a dedicated updater analytics event. | Do not describe GOAT as categorically telemetry-free. The OpenCodex implementation must introduce no update telemetry; verify network destinations and privacy scan. |

The coordinator described the desktop sidebar's existing footer and requested
states: current, available, downloading percentage, ready to restart and failed;
the panel should provide channel selection, automatic download and install
controls, release notes, restart and deferral. No screenshot is present on this
host. Defaults, supported channels, exact source changes and verification
remain decisions for the audited roadmap, not claims of implemented behavior.

Baseline verifier discovery on 2026-11-07, before implementation: after
`bun install --frozen-lockfile` at the repository root and in `gui/`,
`bun test tests/update/update-desktop-badge.test.ts tests/update/update-badge.test.ts`
passed 17 tests. From `gui/`,
`bun test tests/sidebar-version-layout.test.ts tests/sidebar-rows.test.ts`
passed 12 tests. The first pair exercises badge source modules; the second pair
checks sidebar source and header styling, not rendered footer geometry. The
initial runs failed because the checkout had no installed dependencies; the
GUI test paths also need to be run from `gui/` or explicitly prefixed with `./`.
These baseline results do not prove any future change.

Further baseline verifier discovery on 2026-11-07:
`bun test tests/clients/desktop-update-surface.test.ts tests/ci-workflows/release-desktop-scripts.test.ts`
passed 48 tests, including the existing desktop-page harness and release
signature verifier. `bun test tests/cli/sync-fanout.test.ts
tests/clients/link-peer-compatibility.test.ts` passed 22 tests, exercising
the existing fan-out classifier and link compatibility implementation. These
tests directly read or import their existing owners; they do not prove any
future signed package or remote-update design.

`bun run structure:check` also passed at the baseline (exit 0). Its script
checks the `structure/` manifest, source ownership and invariant bindings
(`scripts/structure-ssot.ts:299`, `:518`, `:573`); it does not validate this
`devlog/` roadmap's correctness. Roadmap review is a separate human/independent
audit, and new structure files must be staged before rerunning that gate.
`bun run typecheck` passed at the baseline (exit 0; 2,326 files, no type
errors). This checks TypeScript, not Rust, rendered UI or this prose roadmap.
`bun run privacy:scan` passed after staging the draft unit, because that scanner
enumerates tracked/indexed files (`scripts/privacy-scan.ts:64`). Re-run it on
the final staged roadmap before publication.
`bun test tests/lab/core-lab-boundary.test.ts` passed 25 tests (exit 0); it
checks protected core import graphs and the synchronous Lab activation window.
`bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` passed
29 tests (exit 0), including the repository membership oracle and expected
fixture comparison. It checks test placement and map consistency, not whether
the planned regression tests are adequate.
`bun scripts/file-size-ratchet.ts` passed (exit 0) on the baseline; it reads
the repository baseline and current file sizes without updating the caps
(`scripts/file-size-ratchet.ts:212`, `:224`).
The ratchet's general threshold is 2,000 lines and Rust is not among its
scanned extensions (`scripts/file-size-ratchet.ts:4`). At this baseline
`src/update/job.ts` has 1,986 lines and no per-file baseline entry, leaving
only 13 additional lines before it reaches the rejected threshold. Prefer a
sibling module for substantive additions; recheck current counts after each
prerequisite lands. A missing baseline entry does not mean a tracked file is
untracked by Git.

The bundled desktop page is `desktop/ui/update.html`; its existing status,
check and install commands are guarded to that page in
`desktop/src-tauri/src/lib.rs:272` and `desktop/src-tauri/src/window.rs:115` at
the baseline above.
`tests/clients/desktop-update-surface.test.ts:38` exercises the page and its
command boundary. The dashboard receives desktop state via
`src/server/management/sidebar-routes.ts:137`, whose store strictly validates
the snapshot field set (`src/update/desktop-badge.ts:31`); any additional state
must be designed end to end, including older shells and stale sessions.

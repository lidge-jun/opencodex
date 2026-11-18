# R2 — Design inputs for Home-triggered Child updates

Base: codex/link-child-updates == origin/dev 00680193cb (2026-11-11). Read-only research; no tracked file changed.
Local machine (read-only): macOS Desktop install, served runtime /Applications/OpenCodex.app/Contents/MacOS/ocx v2.93.0 (first
serving-runtimes.json entry), client.transport = link, no client-link.json / child-initiated.json => a Home-initiated Child served by the
Desktop app. This is the hardest case below: nothing the Home can run over SSH updates it today.

## Headline findings

1. The building block exists: `ocx update --plan --json` / `ocx update --yes --json [--version V] [--expect-plan T] [--not-after MS]`
   (contract update.orchestrated/1, #8103 4d93716dd7, first release v2.97.0). Built for an external orchestrator (GOAT); it is what a Home should
   run through remoteOcxArgv. Children < 2.97.0 (this 2.93.0 machine included) lack it.
2. GOAT already does Home-first, idle-gated OpenCodex updates of Children: "Managed OpenCodex updates run on their own on a Hub, Home first and then
   each Child, while their machines are idle, and sync each machine's models into Codex right after it moves" and "Adopted installs are updated when
   their OpenCodex supports orchestrated updates and otherwise receive advice" (GOAT docs pages updating + hub, build 0.1.5-nightly.20261107.342).
3. Desktop- and standalone-owned Children cannot be updated by any CLI path (plan reason desktop-app-owned / installer-unknown; legacy ocx update exits 1
   with STANDALONE_UPDATE_HINT, src/update/index.ts:77,:505). The Tauri updater installs only from the tray or bundled update.html; "The loopback
   dashboard has no updater IPC permission" (structure/desktop-shell.md ~L198-203). Windows Children select only .exe candidates
   (src/link/remote-windows.ts:147-151), so they are usually Desktop/MSI/GOAT-managed => same refusal.
4. ocx-child cannot be updated in place, and its version is a protocol constant: ocx-child --version prints "opencodex 2.98.0"
   (native/ocx-child/src/cli.rs:76-78, OCX_PROTOCOL_COMPAT_VERSION native/ocx-child/src/lib.rs:21) and sends the same value as peer version
   (native/ocx-child/src/relay.rs:251). Version-based Home decisions must branch on childKind first.
5. No technical barrier makes the simple shape unsafe: Home->Child SSH already runs arbitrary ocx subcommands with the user's own key (no forced command,
   no Child-side allowlist; rg authorized_keys/forced finds nothing in src/link, src/client). 060/080's objections are policy/consent and supply-chain
   requirements, plus real mechanical hazards (Windows kill-on-close, Codex routing left native after an unsupervised Child stop, Child-initiated
   links have no exec route). See section 3.

## 1. Inventory

### Install kinds (src/update/install-detection.mjs, src/update/index.ts:79-90)
detectInstallOwnership() returns npm | pnpm | bun | source | mise, or standalone (compiled Bun binary; isStandaloneModuleUrl src/lib/standalone.ts:9-17).
The orchestrated plan maps standalone to desktop-app when the path matches .opencodex-desktop or *.app/Contents/ or runtimeOwner is desktop, else
unknown (src/update/orchestrated-entry.ts:56-57,128).

### Legacy ocx update [--tag latest|preview] (all versions)
- Non-interactive, text output (runUpdate src/update/index.ts:459-560).
- mise => exit 1 + "mise upgrade <tool>"; standalone => exit 1 + Desktop hint; source => prints "git pull && bun install" and exits 0 without updating;
  already latest => exit 0. npm/pnpm are updated in the Node launcher bin/ocx.mjs before Bun starts (index.ts:455-458, bin/ocx.mjs:1464).
- Preflights before stopping anything: config preflight (Bun), npm cache ownership, registry integrity metadata (checkUpdatePackageIntegrity, explicitly
  "NOT independent tamper-proofing", index.ts:384-392).
- Then a full ocx stop (index.ts:842-905), package replacement, recovery via service manager restart (restartThroughServiceManager :713), service
  reinstall, or detached "ocx start --port <captured>" (startProxyDirectly :669-707, 30 s health deadline). Desktop supervision vetoes stop/replace.
- Teardown handover (#7423, keeps Codex routing across the stop) is set only by the dashboard job (src/update/job.ts:1913), not by CLI ocx update.

### Orchestrated update.orchestrated/1 (>= v2.97.0; discover with ocx capabilities --contracts --json, src/cli/capability-contracts.ts:2)
- Plan ocx.update.plan/1 {currentVersion, targetVersion, installer, runtimeOwner, servingPath, cliPath, canApply, reason?, restartRequired, planToken,
  updateInFlight, mutationBoundMs=900000} (src/update/orchestrated-plan.ts:22-48). Read-only; registry probe uses a throwaway cache
  (orchestrated-entry.ts:75-87). Reasons: desktop-app-owned, source-checkout, mise-managed, installer-unknown, plan-unavailable, serving-install-unknown,
  cli-not-serving-install, runtime-ownership-refused, target-unresolved, downgrade-refused, up-to-date.
- Apply ocx.update.result/1 {applied, fromVersion, toVersion, installer, restarted, healthy, rolledBack, error?}. Admission refuses plan-changed /
  deadline-passed / update-in-flight before mutation (src/update/orchestrated-admission.mjs:2-12).
- Exit codes: 0 verified or up-to-date; 10 refusal; 11 failed but previous version verified active; 12 unverified/still running (incl. overrun); 64 usage
  (src/update/orchestrated-outcome.mjs; docs reference/cli/lifecycle.md:1258-1263).
- Drivers: Bun in TS (applyOrchestratedBun orchestrated-entry.ts:150-206); npm/pnpm in the Node launcher (src/update/orchestrated-node-driver.mjs,
  bin/ocx.mjs:1362). Parent keeps stdout; the worker ignores SIGINT/SIGTERM/SIGHUP (src/update/orchestrated-child.mjs:1); parent re-verifies tree,
  version and runtime health independently.
- Duration: bounded by mutationBoundMs = 15 min (overrun => exit 12, transaction not killed). Plan = one registry lookup.
- Restart: restartRequired = a live runtime existed; result reports restarted and healthy (runtime answers with the target version).

### Mutex / in-flight guard
- src/update/sync-update-mutex.mjs: non-blocking lease <home>/sync-update.mutation.lock with holder kind sync|update; isUpdateInFlight is true when held
  by update/unknown, ownership lease busy, or update marker present; any error => true (:158-164).
- Child ocx sync refuses with update-in-flight exit 7, or sync-in-progress exit 1 (src/cli/sync-update-guard.ts:10-12). Home fan-out maps exit 7 to
  skipped child-updating, hint "Wait for the Child update to finish, then retry sync." (src/cli/sync-fanout.ts:68,90).

### Dashboard job path is unavailable on a Child
ocx system update check|run|status call /api/update/* on the local runtime (src/cli/system-command.ts:221-243; config-routes.ts:954-1013). On a Link
Child runtimeRequest falls back to the Home read allowlist and refuses other requests (src/cli/runtime-api.ts:194-204); /api/update/* is not in
LINK_MANAGEMENT_READ_PATHS. Only ocx update is a remote entry point today.

### Desktop app
tauri-plugin-updater =2.14.1 (desktop/src-tauri/Cargo.toml:32); check 30 s after start then every 6 h (desktop/src-tauri/src/updater.rs:448-456),
published as pending + badge snapshot; install only from tray or bundled update page with drain/ownership checks (structure/desktop-shell.md ~L181-203,
ADR-6033). A CLI on a Desktop install must defer to the app.

### ocx-child
Version: constant 2.98.0. No update subcommand. Planting only in POST /api/link/apply when runtimeKind === "missing" and plant: true
(src/server/management/link-enrollment.ts:222-276); no re-plant route. Artifact resolver (src/link/child-binary-source.ts) needs OPENCODEX_CHILD_BIN_DIR,
native-bin/ sidecars, a host-matching local Cargo build, or a SHA256SUMS-verified cache; packaged npm/Desktop Homes answer plantable:false,
artifact_not_found (structure/remote-link.md:195). The POSIX plant script is atomic (mv -f) after size + SHA-256 checks (src/link/remote-plant.ts:130-171),
so replacing a binary under a running serve then ocx-child restart is feasible, but it is a new flow and needs artifact supply.

## 2. What the Home already knows

| Fact | Source | Persistence |
| --- | --- | --- |
| direction, remotePlatform, childKind (full/ephemeral) | LinkRecord strict RECORD_KEYS src/link/store.ts:57-82 | links.json; a new key breaks Home downgrade |
| Child version + peer features | relay-auth challenge headers x-opencodex-link-peer-version/-features (src/link/peer-report.ts:14-55), recorded after proof; Child >= 2.91.0 | memory only, 256 links, empty after Home restart (:80-99) |
| Compatibility verdict | linkPeerStatus (src/link/compatibility.ts:24,71); GET /api/link/status?compatibility=1 via attachLinkPeers (src/link/status-projection.ts:77-79) | derived |
| Apply parity | Child POST /v1/link-management/child-parity {lastApplyAt, runtimeStartedAt, appliedCodexSettingsDigest, sequence} (structure/remote-link.md:189) | memory |
| Version + kind at enrollment | POSIX_INSPECT_SCRIPT (census via REMOTE_SERVED_RUNTIME first, then Desktop, /usr/bin, PATH, ocx-child) => runtimeKind, ocxVersion, targetTriple (src/link/remote-plant.ts:40-112); ocx link probe includeVersion | pendingHosts only, not persisted |

Missing: installer kind / runtime owner is never reported. Cheapest source: the Child's own ocx update --plan --json over SSH (>= 2.97.0). Peer reports
carry no install kind and are display-only by design.

Windows: remoteOcxArgv builds one encoded PowerShell command; candidates are only ocx.exe (Desktop, GOAT junction .local\share\goat\opencodex\current,
.local\bin, per-user / Program Files, PATH); no ocx.cmd; census not read on Windows (structure/remote-link.md:15). The selected ocx.exe runs in a
kill-on-close Job with silent breakaway: a dropped channel kills that ocx.exe, its spawned children survive. Constrained Language Mode => exit 126.

## 3. Plan docs 060 / 080 vs the simple shape

Merged: #8275 56d9ab4dbc (roadmap docs), #8294 10972dd966 (offline signed-update verification primitives: minisign.mjs, signed-supply.mjs, checkpoint
codec, update-contracts.mjs, trust-root JSON), #8445 2f40e96aae (update lint review). Nothing outside tests and desktop/scripts/verify-release-assets.ts
consumes signed-supply/update-contracts yet, so no install path is signature-gated today. codex/auto-update-signed-supply is another thread's branch.

060 (Home-initiated): new ocx link-update prepare|status|commit|cancel over pinned SSH; signed envelopes (ocx.link-update.envelope/1, request/1, result/1;
64 KiB / 32 KiB / 5 s / 5 min bounds); a separate Home update signing key and a destination-local grant (<configDir>/link/update-grants.json,
ocx.link-update.grant/1 binding Home key, Child/installation/link epoch, scopes, expiry, Child response key) approved only by the Child owner
(ocx link-update grant approve|revoke); key store src/link/update-key-store.ts; binding epochs invalidated by every connection writer; lock order
U->O->A->N->L->C->J; Home journal link/fleet-updates.sqlite and Child journal update/link-operations.sqlite; signed compatibility descriptors
(ocx.link-capabilities/1 with epoch + vector) for every Home/Child/recovery pair; Home-first fleet ordering; dashboard DTOs
/api/link/updates/v1/{status,action,action-result} with request-id readback; Desktop IPC bridge link_update_bridge.rs.
080 (Child-initiated): Child polls /v1/link-update/poll and posts /v1/link-update/result on the Home link listener, signed both ways, 30 s poll with backoff,
same grants/journals.

| 060/080 assumption | Simple shape replacement |
| --- | --- |
| SSH auth is not consent; need Home key + Child grant | Home already holds full shell via the user's SSH key and already runs connect, restart, sync, disconnect --purge, plants binaries. Replace grants with a Child-local opt-in (or Home-side per-link policy if same-owner is accepted). |
| Signed artifact before any automatic install | Supply authority stays with the Child's own installer exactly as a manual ocx update. Signed supply can replace installer internals later without changing the remote contract. |
| New CLI, envelopes, journals | update.orchestrated/1: planToken = consistency binding, --not-after = expiry, updateInFlight + mutex = concurrency/replay guard, exits 11/12 = recovery evidence. Home keeps a small per-link result record. |
| Signed compatibility descriptors | Pin target to the Home's own version (--version <homeVersion>; downgrade refused). Children never run ahead of the Home. |
| Desktop IPC bridge | Out of scope: report owner-action. |
| Child-pull exchange | Child-local "follow my Home" policy; the Child already knows the Home version from the Home Codex settings document (home.version; native/ocx-child/src/codex_settings.rs:94-98, src/link/codex-settings.ts). |

Hazards (none make it unsafe; all need design):
1. Consent policy: 000_plan AU-002 keeps manual activation as the proposed default; 060 says SSH auth alone is not consent. Policy decision, not a mechanism gap.
2. Routing after stop: CLI/orchestrated ocx update runs ocx stop without the teardown handover; an unsupervised Link Child restores native Codex on stop and
   "start alone does not reapply routing" (structure/remote-link.md:7; lifecycle docs L85). The Home must run pinned sync --expect-link afterwards (and
   --restart-codex when opted in). Inference from docs: verify with a test. Service/Desktop-supervised Children preserve integrations.
3. Active work: the stop drains then aborts turns. Auto mode needs idle admission. The Home relays every Child request, but link-relay-sessions.ts keeps only a
   global active counter (:34-47); a per-link last-activity timestamp is a small addition.
4. Windows: dropped channel kills the Job-contained ocx.exe parent (the worker breaks away). The Home loses the verdict, not the install's own guards; always re-observe.
5. Child-initiated links: no Home SSH route (null hostKeyFingerprint; fan-out skips client-initiated-link, sync-fanout.ts:112).
6. GOAT overlap: GOAT may update the same Child; the update/sync mutex serializes (update-in-flight refusal).
7. ocx-child reports 2.98.0, so a ">= 2.97 => orchestrated" test misfires; ocx-child update is a usage error.

## 4. GOAT reference

- ~/.goat/userdata/ssh-runtime-auto-update.json: { targetVersion: string, at: epoch-ms } (GOAT runtime 0.1.2-nightly.20261103.324 at 2026-11-04T09:24Z).
- ~/.goat/userdata/opencodex-update.json: { runtimeUpdateChecked: string } (same GOAT version). No secrets.
- GOAT docs: background services auto-update within channel when idle, ON by default ("Automatic server updates"); preview/dev never auto-update; desktop
  default "Restart when idle"; updates never interrupt running threads ("waits for idle"); remote machines first, local app last; SSH runtimes are matched to
  the owning machine's version, never newer; a failed/rolled-back target is not retried automatically. Managed OpenCodex: Home first then each Child while
  idle, model sync after each move; adopted installs via orchestrated update or advice; "a stuck update window clears once the member is back on its
  previous version".

## 5. Proposal

Detection (one SSH call per Child, <= 60 s like remote-probe.ts): childKind ephemeral => ocx-child branch. Else
remoteOcxArgv(["update","--plan","--json","--version",homeVersion], platform), strict parse (<= 64 KiB, schema ocx.update.plan/1). Usage exit or non-JSON
=> pre-2.97 => legacy branch (confirm via --version). Cache installer/runtimeOwner per link in a new file, not links.json.

| Child | Remote command (via remoteOcxArgv) | Outcome |
| --- | --- | --- |
| npm / pnpm / bun, >= 2.97, canApply | update --yes --json --version <homeVersion> --expect-plan <planToken> --not-after <now+120000> | ocx.update.result/1, exits 0/10/11/12 |
| reason up-to-date | none | up-to-date |
| Desktop / compiled standalone | none | owner-action:desktop ("Check for Updates in OpenCodex Desktop on <alias>") |
| GOAT-managed compiled (installer-unknown, .local/share/goat/opencodex) | none | owner-action:goat |
| mise / source | none | owner-action with mise upgrade <tool> / git pull && bun install |
| runtime-ownership-refused, serving-install-unknown, cli-not-serving-install | none | refused + reason |
| full ocx 2.66-2.96 | none by default; optional explicit legacy update, verified by re-probing --version | advice (GOAT parity) |
| ocx-child | none until re-plant flow + artifact supply exist | unsupported:ephemeral |
| Child-initiated link | none | unsupported:child-initiated (future Child-local follow-Home) |
| Windows | same rows; mostly owner-action | re-observe after any drop |

Timeouts: plan 60 s; apply mutationBoundMs (900 s) + 120 s, keeping ServerAliveInterval=15 x3 from commonOptions (src/link/ssh-argv.ts:69-80). Do not reuse
the 180 s fan-out budget. One Child at a time.

Result record (e.g. ocx.link.child-update/1: linkId, alias, state, reason, fromVersion, toVersion, installer, runtimeOwner, restarted, healthy,
sync{state,reason}, at):
- exit 0 + applied/healthy => updated; then pinned sync --expect-link (exit 7 => wait, retry once), optional --restart-codex when opted in; confirm via next
  peer report or --version probe.
- 10 => refused + error (update-in-flight, sync-in-progress, plan-changed, deadline-passed ...); busy => later, never loop.
- 11 => failed, previous verified; suppress that target for the link until explicit retry or a newer target.
- 12, ssh 255, timeout, Windows 126 mid-run => uncertain; re-observe with update --plan --json (updateInFlight, currentVersion) on backoff; never start a
  second apply while updateInFlight.
- 125/127 => unsupported / child-ocx-not-found. Tunnel down does not block: SSH is independent and the update judges health by /healthz.

Automatic mode: off | notify (default) | auto-when-idle, per Home with per-link override. auto-when-idle: Home healthy at target first, then Children one at
a time, target = Home version, only when the link had no relayed request for N minutes (suggest 10) and plan.canApply; preview/dev Homes never auto-push.
Default notify because AU-002 keeps manual activation as default, the stop interrupts turns and (unsupervised) unroutes Codex until sync, signed supply is
not wired, and the most common Child shapes (Desktop, Windows MSI) cannot be updated remotely, so auto would mostly yield owner-action rows. GOAT's
on-by-default policy argues for flipping later, once idle gating and post-update sync are proven and a Child-local opt-out exists.

Version skew (1M shows ~250k on an outdated Child): not root-caused here (see sibling r1-context-window-root-cause.md). The Child writes models_cache.json
with its own code from the Home catalog, so updating the Child and re-running the pinned sync is the remedy this design delivers.


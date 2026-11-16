# A1 — Architect proposal: Home orchestration of linked Children

> **Revision 4 (CodeRabbit on #8500).** This is the architect's record; where a later plan doc changed a decision, the
> change is noted in place. Folds 4529521934 (escaped pipe in the module map), 4529521944 (D12 step 7: routing is also
> restored after a failed or rolled-back apply, and after an uncertain one once no update is in flight; 030, 070) and
> 4529521950 (D14: the CLI's mutating verbs are explicitly unsupported on a non-loopback Home and say so; 030, 050).

Base: origin/dev 00680193cb (package and Desktop 2.100.0, latest tag v2.100.1). Read-only design; no tracked file changed.
Inputs verified rather than trusted: r1 (context root cause), R2 (Child updates), r3 (surface map). Where this
proposal disagrees with them it says so (D3 overturns R2's detection probe).

## 0. Findings that shape the design (new evidence beyond r1/R2/r3)

F1. **Probing an old Child with update --plan performs a real update.** At v2.93.0 `ocx update` ignores
   its arguments and calls `runUpdate()` (git show v2.93.0:src/cli/dispatch.ts:775-784); the npm launcher
   self-updates before Bun starts (v2.93.0 bin/ocx.mjs:1142). Orchestrated parsing first ships in v2.97.0
   (v2.97.0 dispatch.ts:612-620; 4d93716dd7 is first contained in v2.97.0; v2.96.0 dispatch.ts:777-783 is
   still the old path). R2 §5 "usage exit or non-JSON => pre-2.97" would stop and replace an old Child's
   runtime. Every remote update verb must be version-gated *inside the remote script*, the way the pinned
   sync gates >= 2.93.0 (src/link/ssh-argv.ts:330-358, src/link/remote-windows.ts:219-222).
F2. **A Child sync with a restart flag is a valid "restart Codex" on every fan-out-eligible Child.**
   `catalogWritten` is `downloaded !== undefined` (src/client/connect.ts:1004), so any non-stale sync
   reaches `handleRestartScopeAfterWrite` (src/cli/sync-command.ts:237-243). v2.93.0 reads
   `parseSyncExpectation` and `readRestartScope` from the same argv (v2.93.0 dispatch.ts:405-431), and
   `--restart-app-server-only` exists since v2.54.0 (d7c7b493bf). `ocx system codex-restart` is **not**
   usable on a Child: `runtimeRequest` refuses non-allowlisted requests on a Link Child
   (src/cli/runtime-api.ts:194-204). Under --json current Children print restart text to stderr
   (sync-command.ts:21); a 2.93 Child's text output still matches the Home's `includes()` fallback
   (src/cli/sync-fanout.ts:80-81). ocx-child accepts and ignores the restart flags (native/ocx-child/src/cli.rs:1211-1215, r3).
F3. **The Home can already see Child catalog freshness without Child changes.** /v1/catalog serves the same
   bytes to every key (src/server/index/serve-options.ts:768-783, src/server/catalog-download.ts:55-62), and
   every authenticated hub-link catalog GET already fires `onAuthenticatedCatalog(keyId)`
   (serve-options.ts:391-393; listener set src/server/index/link-listener.ts:220-226). Only sync/connect paths
   fetch /v1/catalog (src/client/hub-client.ts:445; native/ocx-child/src/cli.rs:794,1394), so "last pull" is
   a faithful proxy for "last catalog write" (exception: the effort-gate refusal, connect.ts:932).
F4. **serve-options.ts has 3 lines of headroom** (1997 of 2000; scripts/file-size-ratchet.ts THRESHOLD) and
   src/cli/index.ts has 1 (1999). src/server/index.ts is capped at 893 (865 today). The design adds nothing to
   these three files.
F5. **A Desktop Child's served ocx version is its app version** (package.json and desktop/src-tauri/tauri.conf.json
   both 2.100.0), so peer-version visibility already covers "even the app version". Installing is separate (D9).
F6. **On a Child the Desktop shell's update snapshot never reaches the runtime**: the client listener rejects
   POST /api/* (src/client/machine-listener.ts:119); /api/update/desktop-snapshot exists only on the server
   management plane (src/server/management/sidebar-routes.ts:102-143).
F7. **Relay activity is countable per link at no protocol cost.** Each relay session carries `linkId`
   (src/server/index/link-relay-sessions.ts:9-17,99) and dispatch sees the path; the counter `active` is
   global (:34,41-49) and a new book is created per bind (link-listener.ts:117).


## 1. Decisions

### D1 — Module map (one owner per responsibility)

| Path (new unless noted) | Responsibility | Imports allowed |
|---|---|---|
| src/link/child-gated-ocx.ts | POSIX/Windows builders for "select ocx, require >= min, then exec args" (D2) | ssh-argv.ts, remote-windows.ts only |
| src/link/child-update-contract.ts | Strict Home-side parsers for `ocx.update.plan/1` / `ocx.update.result/1`, exit mapping, install-kind classification (D3, D12) | none (pure) |
| src/link/child-observations.ts | Persisted per-link observation cache (D4) | config/atomic-write, link/paths |
| src/link/child-activity.ts | Per-link in-flight count and last data-plane end (D5) | none (pure) |
| src/link/child-catalog-freshness.ts | Pull times per link, Home catalog revision monitor (D6) | server/catalog-download (lazy) |
| src/link/child-ops-engine.ts | Job registry, per-link lock, bulk queue, runners for observe/sync/restart/update (D11-D13) | the four above, ssh-runner, store |
| src/link/child-ops-scheduler.ts | Automatic modes (D17); started only when links exist | engine, policy |
| src/server/management/link-child-ops-routes.ts | /api/link/children/* routes (D14); link-routes.ts gains one delegating branch | link-route-state.ts helpers |
| src/cli/link-child-ops.ts | `ocx link update\|sync\|restart-codex\|policy` (D15); link.ts gains switch arms only | cli/link.ts linkRequest |
| src/cli/capabilities-access-remote.ts (edit) | One Capability per verb; contract `link.child-ops/1` in src/cli/capability-contracts.ts:2 | — |
| gui/src/remote-link-child-ops-api.ts, gui/src/pages/RemoteLinkChildActions.tsx | Parsing, row actions, Update all, policy panel; RemoteLink.tsx only renders it | — |

Evidence: r3 §7 placement; link-routes.ts is 363 lines and the template for a per-link remote op is
src/server/management/link-routes.ts:231-243. Alternative rejected: putting the engine under src/cli
(sync fan-out lives there, src/cli/sync-fanout.ts:99-151) — the GUI and automatic mode need a long-lived
owner in the Home process, and the server importing src/cli is rare (only 3 imports, e.g.
src/server/stop-teardown.ts:7). The engine reuses `classifySyncResult` by moving the pure classifier to
src/link/sync-fanout-classify.ts, re-exported from src/cli/sync-fanout.ts so its tests keep passing.
Core-path rule (AGENTS.md "Optional subsystems"): none of these is imported by src/router.ts,
src/server/lifecycle.ts or src/server/responses/core.ts; the engine and scheduler load lazily from the link
listener/route path, which exists only when links.json has links (link-listener.ts:111-114).

### D2 — Gated remote ocx: one builder, minimum version as a parameter (fixes F1)

```ts
export interface GatedOcxCommand {
  minVersion: "2.93.0" | "2.97.0";          // closed set; literals feed the awk/PowerShell comparator
  args: readonly string[];                  // e.g. ["update","--plan","--json","--version",home]
  lacksMarker: "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update";
}
export function remoteGatedOcxArgv(cmd: GatedOcxCommand, platform: "posix" | "windows"): string[];
export function remotePinnedSyncArgv(linkId: string, platform?: "posix" | "windows",
  opts?: { restart?: "app-server" | "codex" }): string[];   // existing builder gains opts
```

The POSIX script is `REMOTE_PINNED_SYNC_SCRIPT` (ssh-argv.ts:319-369) with the hard-coded
`cmp(a[1],"2")…"93"…"0"` replaced by three validated digit strings and the final `exec` line taking
"$@" instead of a fixed `sync --expect-link "$1" --json`. Markers stay `ocx-fanout:selected:<v>` (stderr) and
`ocx-fanout:stdout-begin` (stdout), exit 121 for a refusal, so `classifySyncResult` (sync-fanout.ts:42-82) and
a new `classifyGatedResult` share framing. Windows is the same edit to `windowsPinnedSyncArgv`
(remote-windows.ts:213-225) with the minimum in `$b` and args in `dataLine`, still under
`POWERSHELL_ENCODED_MAX` 8000 (verified by the existing size tests in tests/clients/link-pinned-sync-argv.test.ts).
Restart opts append `--restart-app-server-only` or `--restart-codex` after `--json`; the Home never sends
both. Alternative rejected: `remoteOcxArgv(["update","--plan",…])` as R2/r3 propose — unsafe on < 2.97
(F1). Alternative rejected: a separate `--version` round trip, then the command — a TOCTOU between two SSH
sessions in which the served install can move (structure/remote-link.md, served-runtime census #8359).

### D3 — Observation ("observe" op): one SSH call, read-only on every Child version

Order inside one job item:
1. `record.direction === "client-initiated"` → item `unsupported` / `child-initiated` (no SSH route,
   src/link/store.ts:24-25; sync-fanout.ts:112).
2. `record.childKind === "ephemeral"` → no update probe. Version = peer report or gated `--version`; route `replant` (D10).
3. Otherwise run `remoteGatedOcxArgv({minVersion:"2.97.0", args:["update","--plan","--json","--version",HOME_VERSION]})`,
   timeout 60 s (remote-probe precedent, R2 §5). Exit 121 + lacks marker ⇒ the Child is < 2.97 and nothing
   ran. The gate prints no `selected` marker on refusal, so the installed version comes from
   `inspectRemoteChildRuntime` (src/link/remote-plant.ts:88-115, reads the served-runtime census) on POSIX and
   from the peer report on Windows; route `owner-action`, reason `legacy-ocx`.
4. Exit 0 ⇒ strict-parse the plan (≤ 64 KiB, exact key set of src/update/orchestrated-plan.ts:22-48, schema
   string `ocx.update.plan/1`). Map to `installKind` / `updateRoute`:

| plan | installKind | updateRoute |
|---|---|---|
| canApply, installer npm/pnpm/bun | npm/pnpm/bun | `orchestrated` |
| reason up-to-date | as reported | `none` (up-to-date) |
| reason desktop-app-owned | desktop-app | `desktop-request` if peer features carry `desktop-update-request/1` (D9), else `owner-action` |
| installer-unknown with servingPath under .local/share/goat/opencodex | goat | `owner-action` (GOAT updates it; R2 hazard 6) |
| mise-managed / source-checkout | mise / source | `owner-action` |
| runtime-ownership-refused, serving-install-unknown, cli-not-serving-install, target-unresolved, downgrade-refused, plan-unavailable | as reported | `none` + `refused:<reason>` |

Identity: the plan is not link-bound. Binding comes from the post-update pinned sync (`--expect-link`, exit 5
⇒ `child-link-mismatch`), which every update item runs (D12). A pre-apply `connect status --json` read was
considered and rejected: one more SSH session and still a TOCTOU; the expect-link sync is the guard the owner
asked to keep.

### D4 — Persistence of Child observations (Q3)

File `<configDir>/link/child-observations.json` (0600, dir 0700 via the existing hardening in
src/link/store.ts:1-8), written with `atomicWriteFile` (src/config/atomic-write.ts:458) under
`withConfigMutationLockSync` like links.json. It is a **cache, not a trust boundary**: unknown fields are
dropped, a damaged file reads as empty and is rewritten, entries for link ids absent from links.json are
pruned on every write. That is the opposite of links.json's strict `RECORD_KEYS` (store.ts:57,63-68) on
purpose: a downgraded Home ignores the file, an upgraded one tolerates older shapes, and no link record
changes. Schema:

```ts
interface ChildObservationsFile { schema: "ocx.link.child-observations/1"; children: Record<LinkId, ChildObservation> }
interface ChildObservation {
  observedAt: string;                      // ISO, Home clock
  source: "plan" | "inspect" | "peer";
  installedVersion: string | null;         // from plan.currentVersion, selected marker or inspect
  installKind: "npm"|"pnpm"|"bun"|"source"|"mise"|"desktop-app"|"goat"|"standalone"|"ocx-child"|"unknown";
  runtimeOwner: string | null;             // plan.runtimeOwner, verbatim enum
  updateRoute: "orchestrated"|"desktop-request"|"owner-action"|"replant"|"none";
  updateReason: string | null;             // plan.reason or legacy-ocx / child-initiated / ...
  targetVersion: string | null;            // Home version the plan was computed for
  catalogPulledAt: number | null;          // D6, epoch ms
  lastOperation: ChildJobItemSummary | null; // D11, survives Home restart
  suppressedTarget: string | null;         // set after exit 11 (D12)
}
```
Alternatives: extend links.json (rejected: strict keys break Home downgrade, store.ts:57 and
structure/remote-link.md on childKind); memory only like peer reports (peer-report.ts:80-99) (rejected:
"behind" and the last update result must survive a Home restart, and an observe costs an SSH session).


### D5 — Per-link idle signal (Q2)

`createLinkActivity()` in src/link/child-activity.ts, owned by the link listener lifecycle (so it survives
rebinds; the relay book is recreated per bind, link-listener.ts:117) and passed into
`createLinkRelaySessions({ activity })`. In `dispatch` (link-relay-sessions.ts:102-155) the existing
`acquire()` lease is paired with `activity.begin(linkId, path)` and its release with `activity.end`:
```ts
interface LinkActivity {
  begin(linkId: string | null, pathname: string): () => void;  // null = legacy key admission (:116-118)
  snapshot(linkId: string, now: number): { inFlight: number; lastDataEndAt: number | null; observedSince: number };
}
```
Only data-plane model routes count (the POST set in src/link/routes.ts:22-28). /v1/catalog, /readyz,
/v1/usage, the management reads and the once-a-minute parity POST (structure/remote-link.md, OCX-6 reporter)
do not, otherwise every link is busy forever. A legacy admission (no session nonce) counts against every
link, which is conservative and affects only pre-relay-auth Children that cannot be updated anyway. Idle =
`inFlight === 0 && now - (lastDataEndAt ?? observedSince) >= idleAfterMs` (default 600 000 ms, R2 §5).
`observedSince` is the listener start, so a Home restart makes every link "not yet idle" for 10 minutes
instead of falsely idle. Exposed beside `peerObservation` on `LinkRouteListener`
(src/server/management/link-route-state.ts:31-38; optional, like `peerObservation`).
Limits: it sees only traffic relayed through this Home. A Child user composing in an open Codex window sends
nothing, so "idle" means "no running turn", the same meaning GOAT's "waits for idle" uses (R2 §4). The
Child-side guards remain the final word (update `updateInFlight`, sync/update mutex, src/update/sync-update-mutex.mjs:158-164).
Alternatives: Child-reported activity (needs a new Child, and no route for Child-initiated links' updates
anyway); Codex app-server process listing over SSH (costly, says nothing about running turns).

### D6 — Catalog freshness and the automatic fan-out trigger (r1 layer a, Q4)

Two Home-only signals:
- **Pull time per link.** Subscribe once to `onAuthenticatedCatalog` (link-listener.ts:220-226; the
  supervisor already uses it); map keyId → linkId with the store (`apiKeyId`, store.ts:29); record
  `catalogPulledAt` in the observation cache (debounced write, at most one per link per 30 s). No edit to
  serve-options.ts (F4).
- **Home catalog revision.** `createCatalogRevisionMonitor()` keeps `{etag, changedAt}` where etag is
  `catalogEtag(body)` (src/server/catalog-download.ts:40-42). It recomputes (a) when the catalog auto-refresh
  reports `outcome.changed` — add a second hook beside `setCatalogAutoRefreshClientFanout`
  (src/codex/catalog-auto-refresh.ts:53-58,270-279), registered from the link-owned scheduler and not from
  background-lifecycle.ts:131, so a Home without links registers nothing — and (b) on a 5-minute stat-then-hash
  poll of `readCodexCatalogPath()` while links exist, which catches GUI/management edits the tick never sees.
  `changedAt` is persisted in the observation file header so a restart does not reset it to "now".

Verdict per link: `catalog.state = pulledAt === null ? "unknown" : pulledAt >= changedAt ? "current" : "behind"`.
(Superseded by 020 Revision 4, CodeRabbit 4529521959 and 4529521968: the verdict compares etags, and fan-out eligibility
uses the etag a Home-run sync confirmed.)
Automatic fan-out (D17, default on): after a revision change, wait for a 60 s quiet period (coalesces a
burst of GUI edits), then run the per-Child "sync" op (D13, no restart) for every link that is hub-initiated,
connected in the status projection, not busy in the engine, and either idle (D5) or known to share the Home's
Codex settings digest (parity `appliedCodexSettingsDigest` equals `homeCodexSettingsDigest`,
src/link/child-parity.ts:43-49). The digest rule matters because a changed settings apply restarts the
Child's own client runtime (src/cli/link-apply-restart.ts; sync-command.ts:84-104), which cuts relayed
streams; a catalog-only sync does not. Version eligibility is enforced by the gate itself (exit 121 ⇒ skip,
no retry until the peer version changes). Per-link failure backoff: 5 min doubling to 6 h. Children below
2.93 stay "behind" with the existing hint (sync-fanout.ts:90).
Alternative rejected: hooking `refreshConnectedClientsAfterCatalogChange` (background-lifecycle.ts:91-107):
it fires only for auto-refresh ticks and is gated by `localClientSyncAllowed`, a local-integration policy.

### D7 — Codex app-server staleness on the Child (r1 layer b)

The Home cannot see it today: parity reports carry no catalog field (child-parity.ts:28-41) and their parser
rejects unknown keys (:66-77). Decision: a **separate** display-only report, never a v2 of the parity body.
- Path `/v1/link-management/child-codex-state` (POST, exact path, no query), admitted on the Home link
  listener next to the parity route (src/server/index/optional-listeners.ts linkRouteAllowed chain), 1 KiB / 5 s
  caps and the same key-owns-link check as src/server/index/link-management.ts:68.
- Body (exact keys): `{ linkId, runtimeStartedAt, sequence, catalogFingerprint: string|null,
  catalogSyncedAt: number|null, appServers: "fresh"|"stale"|"not_running"|"unknown", staleCount: number }`.
  `appServers` is `collectCodexAppServerCatalogStateWithin` (src/codex/app-server-processes.ts:913-959,1285);
  the Child sends after each sync and every 5 minutes (process listing is too costly every minute).
- Old Homes answer 404, and the reporter stops, which is exactly the parity reporter's rule (structure/remote-link.md,
  "a 404 stops it"). Old Children never send it; the row shows `codex: null` ("unknown").
- Advertised as peer feature `link-child-codex-state/1` through src/remote/features.ts:44-51 so GOAT can tell.
This is the only new write on the link listener. It changes in-memory display state only, like OCX-6, and it
works for Child-initiated links, which have no SSH route. It ships in a Child release (P8), so it is not on
the critical path of the root-cause fix (D6 plus a manual or opt-in restart already cures the symptom).

### D8 — Status projection: `?children=1`, skew surfaced

Opt-in query like `?compatibility=1` / `?diagnostics=1` (src/server/management/link-routes.ts:307-314), because
old CLIs validate rows key by key (src/cli/link.ts:87-93,159; r3 §0.2). New attacher
`attachLinkChildOps` in src/link/status-projection.ts beside `attachLinkPeers` (:77-83):
```ts
child: {
  homeVersion: string;                         // this Home's VERSION
  runningVersion: string | null;               // peer report (memory; Child >= 2.91)
  installedVersion: string | null;             // D4 cache
  installKind: ChildObservation["installKind"] | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown"; // strict semver of installed ?? running vs home
  update: { route: ChildObservation["updateRoute"] | null; reason: string | null; observedAt: string | null };
  catalog: { state: "current" | "behind" | "unknown"; pulledAt: number | null; homeChangedAt: number | null };
  codex: { appServers: "fresh" | "stale" | "not_running" | "unknown"; reportedAt: number } | null; // D7
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: ChildJobItemSummary | null;
}
```
ocx-child rows report `installKind: "ocx-child"` and `versionSkew: "unknown"` because its version is a protocol
constant (D10); version decisions branch on `childKind` first (R2 finding 4). The CLI sends
`compatibility=1&diagnostics=1&children=1` and accepts the field's absence (older Home). The GUI starts sending
`?children=1` (gui/src/pages/RemoteLink.tsx:206) and parses it with an absent-field fallback
(gui/src/remote-link-api.ts:141-160). The sync fan-out status read (src/cli/sync-link-status.ts:29) adds
`children=1` so the CLI fan-out skips a link with an `activeJob` (reason `child-busy`, no hint, no exit 6).

### D9 — Desktop-app Children (Q1)

Evidence that **no path exists today**:
- The Tauri updater installs only from the tray or the bundled update.html; the four update commands are
  registered for that page only (desktop/src-tauri/src/lib.rs:341-356; structure/desktop-shell.md:198-203,
  "The loopback dashboard has no updater IPC permission").
- The single-instance hook discards argv (lib.rs:310-313), so a second launch cannot carry a request.
- No deep-link plugin, no file watcher (rg over desktop/src-tauri/src finds none).
- The snapshot channel is shell → proxy only (desktop/src-tauri/src/updater.rs:229-251), and on a Child the
  proxy side is absent (F6).
- The background check runs 30 s after start and every 6 h (updater.rs:448-456); it only publishes "pending".

Minimal safe addition (proposed, Desktop + ocx in the same release, since they ship together, F5):
1. Child CLI `ocx desktop update-request --version <V> --not-after <ms> --json` (new file src/cli/desktop-update-request.ts,
   outside src/update) writes `<configDir>/desktop/update-request.json` =
   `{schema:"ocx.desktop.update-request/1", requestId, targetVersion, requestedAt, notAfter}` (0600, atomic) and
   prints the current `update-result.json` if one matches. It refuses unless the served runtime is Desktop-owned.
2. The app's existing 6-hour loop gains a 30 s poll of that file (desktop/src-tauri/src/updater.rs:448-456).
   On a fresh, unexpired request it runs `check_and_show`, and installs only when the signed pending update's
   version **equals** `targetVersion`, through the unchanged `install_pending` path (updater.rs:291-326, drain,
   ownership and ADR-6033 intent rules). It writes `update-result.json` `{schema:"ocx.desktop.update-result/1",
   requestId, state:"installed"|"not-available"|"version-mismatch"|"busy"|"failed"|"expired", at}` before restart.
3. The Desktop ocx advertises peer feature `desktop-update-request/1` so the Home picks route `desktop-request` (D3).
Why it is safe: the app still installs only a Tauri-signature-verified artifact from its configured endpoint;
the request can pick no artifact, cannot downgrade, and cannot move past the Home (version equality). Any
process running as the user could already click the tray. A file works on Windows, where an OpenSSH session
cannot reach the interactive desktop (r3 §3), and needs no GUI session on macOS.
First supporting version: the first release that contains both halves (>= 2.101.0 at this base). Desktop
Children below it stay `owner-action` ("Check for Updates in OpenCodex Desktop on <alias>"), once.
Unresolved: the app must resolve the same config directory as its served ocx. The shell knows
`$HOME/.opencodex-desktop` (desktop/src-tauri/src/cli_command.rs:60) but I found no OPENCODEX_HOME handling in
the shell; the request path has to come from the sidecar's resolved config dir, verified in the Desktop phase.
Alternatives: proxy-mediated request on the snapshot heartbeat (needs the client listener to admit a new
POST, a Child-authority widening, F6); single-instance argv (Windows SSH sessions cannot reach the session's
window station; Linux needs the session bus); deep link (needs a GUI launch from SSH). All rejected.

### D10 — ocx-child version and update (Q5)

`ocx-child --version` must keep printing `opencodex 2.98.0`: it is a wire contract parsed by the gate
(native/ocx-child/src/lib.rs:18-21; sync-fanout.ts:20-24; ssh-argv.ts:340-358), and the crate's own version is
0.1.0 (native/ocx-child/Cargo.toml:3), which would fail every >= 2.93 gate. Add instead
`ocx-child build-info --json` → `{schema:"ocx-child.build/1", crateVersion, protocolVersion, targetTriple}` and
send `crateVersion` as a peer feature `ocx-child/<crateVersion>` (FEATURE_ID allows it, peer-report.ts:19).
Update: **unsupported** in this feature (`unsupported` / `ephemeral`). Re-planting is mechanically possible
(atomic `mv -f` after size and SHA-256, src/link/remote-plant.ts:130-171, then `ocx-child restart`), but no
release ships the artifact (no ocx-child step in scripts/release.ts or .github/workflows; packaged Homes
answer `plantable:false`, structure/remote-link.md:195). Revisit when artifacts publish; the route name
`replant` is reserved.


### D11 — Job model for long Child operations

```ts
type ChildOp = "observe" | "sync" | "restart-codex" | "update";
interface ChildJob {
  schema: "ocx.link.child-job/1"; jobId: string;           // "ljob_" + 16 hex
  op: ChildOp; trigger: "manual" | "auto"; restart: "none" | "app-server" | "codex";
  state: "queued" | "running" | "done"; createdAt: string; finishedAt: string | null;
  items: ChildJobItem[];
}
interface ChildJobItem {
  linkId: string; alias: string;
  state: "queued"|"running"|"succeeded"|"up-to-date"|"busy"|"offline"|"refused"|"owner-action"|"unsupported"|"failed"|"uncertain";
  reason: string | null; hint?: string;                   // closed reason vocabulary, never raw remote output
  fromVersion?: string; toVersion?: string;
  sync?: { state: "synced"|"skipped"|"failed"|"timed-out"; reason: string | null };
  restart?: { requested: "app-server"|"codex"; outcome: "requested"|"unsupported" };
  startedAt: string | null; finishedAt: string | null;
}
type ChildJobItemSummary = Pick<ChildJobItem, "state"|"reason"|"fromVersion"|"toVersion"|"finishedAt"> & { op: ChildOp; jobId: string };
```
- **Per-link serialization:** one engine-wide `Map<linkId, jobId>`; an item whose link is held becomes
  `busy`/`link-operation-in-progress` without SSH. DELETE /api/link/{id} answers 409 `link_operation_in_progress`
  while a job holds the link (new `LinkErrorCode` + ERROR_TKEY in all 11 locales, gui/src/remote-link-api.ts:1-46);
  reconnect stays allowed (tunnel only). Items re-read the record before each SSH step and end `refused`/`link-removed` if it vanished.
- **Bulk:** `update` runs items one at a time (GOAT "one at a time", R2 §4); `observe`/`sync`/`restart-codex` use
  concurrency 3 (fan-out precedent, sync-fanout.ts:99-151). Only hub-initiated links are expanded for "all".
- **Timeouts (SSH runner deadline, then item `offline` or `uncertain`):** observe 60 s; sync and restart 180 s
  (fan-out budget); update apply = plan `mutationBoundMs` (900 000, orchestrated-plan.ts) + 120 s, keeping
  `ServerAliveInterval=15` x3 (ssh-argv.ts:69-80); post-update sync 180 s. No job exceeds 30 min per link.
- **Retention:** 32 finished jobs or 1 h in memory; each item's summary lands in `lastOperation` (D4).
  A Home restart mid-job loses the job; the Child's own update keeps running and the next observe reports it
  (`updateInFlight`), which matches "always re-observe" (R2 hazard 4).
- **Privacy:** stdout/stderr are parsed under 64 KiB caps and reduced to reason codes; nothing remote is logged
  or stored verbatim (AGENTS.md privacy rule; privacy:scan).

### D12 — Update item flow and result mapping

1. Branch (D3 step 1-2): client-initiated ⇒ `unsupported`; ephemeral ⇒ `unsupported:ephemeral`; Windows +
   route orchestrated ⇒ `unsupported:windows-apply` (D20).
2. Fresh observe (D3). `up-to-date` ⇒ item `up-to-date`. Route `owner-action`/`none` ⇒ that state + hint.
   Route `desktop-request` ⇒ step 6. `plan.updateInFlight` ⇒ `busy`. `suppressedTarget === HOME_VERSION` and
   trigger auto ⇒ `refused:target-failed-before` (manual clears it).
3. Auto only: require D5 idle at this moment; otherwise `busy:link-active`.
4. Apply: `remoteGatedOcxArgv({minVersion:"2.97.0", args:["update","--yes","--json","--version",HOME_VERSION,
   "--expect-plan",plan.planToken,"--not-after",String(now+120_000)]})`. Target is always this Home's
   `VERSION`; there is no operator-chosen version (Children never run ahead, R2 §3; downgrade refused by the Child).
5. Exit mapping (contract exits from src/update/orchestrated-outcome.mjs via r3/R2): 0 + `applied && healthy` ⇒
   `succeeded`; 0 + not applied ⇒ `up-to-date`; 10 ⇒ `busy` for update-in-flight/sync-in-progress, else `refused:<error>`;
   11 ⇒ `failed:rolled-back` and set `suppressedTarget`; 12, 255 mid-apply, deadline ⇒ `uncertain` and schedule
   observes at 2/5/15 min; 121 ⇒ `owner-action:legacy-ocx`; 125/126/127 ⇒ `failed:<marker>` (sync-fanout.ts:43-47 names).
6. `desktop-request`: gated `ocx desktop update-request` (D9) then poll `--status` every 60 s for 20 min; map
   `installed` ⇒ wait for peer version == target ⇒ `succeeded`, otherwise the matching state.
7. After `succeeded`: pinned sync with `--expect-link` (always; it restores routing that an unsupervised stop
   removed, structure/remote-link.md "start alone does not reapply routing"), plus the restart scope from the
   job/policy. Exit 7 ⇒ wait 30 s, retry once. Result goes to `item.sync`; a sync failure leaves the item
   `succeeded` with `sync.state:"failed"` and a hint, because the version did move.
   Revision 4: the same restore-routing sync (never with a restart) also runs after `failed`/`rolled-back` (the
   updater may have stopped the proxy before failing), and for `uncertain` it runs once a re-observe shows no update
   in flight; an uncertain update is still never re-applied (030 `runUpdateItem`, 070 recovery). A
   `post-update-sync-failed` item makes the CLI exit 6.

### D13 — Per-Child sync and restart-codex ops

- `sync` = pinned sync, no restart unless `restart` is set. Same classifier as fan-out.
- `restart-codex` = pinned sync with `restart: "app-server"` (default) or `"codex"` (explicit). It works on full
  Children >= 2.93 (F2). `codex` scope relaunches the Codex desktop app, which over SSH needs a logged-in GUI
  session and has no SSH awareness (src/codex/desktop-app-restart.ts, r3 §3), so it is explicit only and its
  outcome is `requested` (the Child does not report it until P8 adds a stderr marker
  `ocx-fanout:codex-restart:<done|refused|failed>`). `app-server` scope does not refresh the Codex desktop app's own
  app-server (restart-scope excludes desktop-tree app-servers, r3 §3); the GUI says so next to the button.
- ocx-child ⇒ `restart.outcome: "unsupported"` (it ignores the flags, F2) while the sync itself still runs.

### D14 — Management API

| Route | Auth | Body / query | Answer |
|---|---|---|---|
| GET /api/link/status?children=1 | either | — | rows gain `child` (D8) |
| POST /api/link/children/operations | either | exactly `{op, linkIds: string[] \| "all", restart?: "app-server"\|"codex"}` | 202 `{job}`; 400 invalid_body; 404 link_not_found; 409 link_operation_in_progress (single link) / link_not_home_initiated (single link) |
| GET /api/link/children/jobs/{jobId} | either | — | 200 `{job}`; 404 job_not_found |
| GET /api/link/children/policy | either | — | `{policy}` (D17) |
| PUT /api/link/children/policy | either | exactly the policy keys | `{policy}` |

"either" = dashboard session or admin token on loopback; Tailscale identity sessions are refused
(link-route-state.ts:68-101). Long work follows the `POST /api/update/run` + status precedent
(src/server/management/config-routes.ts:964-1013). Every route is declared in
src/server/management/route-registry.ts:431-439 (regex mechanism for the jobId path). The local-control socket
allowlist stays GET /api/link/status only (src/server/index/local-control-listener.ts:41,347), so on a
non-loopback Home the CLI's POSTs hit the same 403 as revoke today; widening it is out of scope.
Revision 4: that limit is made explicit instead of surfacing as a bare 403. On a 403 from a Home that is not bound to
loopback, `ocx link update|sync|restart-codex|check|policy` (the policy write; reads still work through the socket only
where allowlisted) exit 1 with "Child operations from the CLI need a Home bound to loopback; use the Remote Link page
in the dashboard." The docs-site CLI reference states the same limit. The socket allowlist does not change.

### D15 — CLI

```
ocx link update        (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync          (--link-id <id> | --all) [--restart-app-server-only | --restart-codex] [--no-wait] [--json]
ocx link restart-codex  --link-id <id> [--scope app-server|codex] --yes [--json]
ocx link check         (--link-id <id> | --all) [--json]          # the observe op
ocx link policy        [--updates off|notify|auto-when-idle] [--catalog-fanout auto|manual]
                       [--child-codex-restart never|app-server-when-idle] [--json]
```
The CLI posts, then polls the job every 2 s (unless `--no-wait`). Exits: 0 every item succeeded/up-to-date;
6 partial (any busy/offline/refused/owner-action/unsupported), matching fan-out (sync-fanout.ts:153-156);
1 any failed/uncertain or API error (existing `linkRequest` path, src/cli/link.ts:239-266); 2 usage.
`--json` prints the final `ocx.link.child-job/1` document. `restart-codex` needs `--yes` like
`ocx system codex-restart` (capabilities-base.ts:648-655). Code lives in src/cli/link-child-ops.ts; link.ts
gains switch arms and LINK_USAGE lines (446 lines, room), src/cli/index.ts is untouched (F4). One
Capability per verb in src/cli/capabilities-access-remote.ts, contract `link.child-ops/1` in
src/cli/capability-contracts.ts:2, then `bun run skill:surface` and the hand pages in skills/ocx (r3 §2).

### D16 — Loosened `ocx sync` on the Home

- `--child <linkId>` (repeatable): fan out only to these links; the others are reported `skipped` with reason
  `not-selected` and no hint, so exit 6 is not triggered (sync-fanout.ts:155). An unknown id is usage exit 2 before the Home sync.
- `--restart-children[=app-server|codex]` (bare = app-server): append the restart flag to the pinned sync (D2).
  A distinct name is required because the Home's own `--restart-codex` is read with `args.includes`
  (src/cli/restart-scope.ts:35-37); `--restart-children=codex` contains neither exact token.
- Flags land in src/cli/sync-flags.ts (10 lines) and the `runChild` closure (sync-command.ts:210-225).
  Child guards are unchanged: the gate, `--expect-link` (exit 5) and the sync/update mutex (exit 7).
- Docs that state "Fan-out never requests a Codex app or app-server restart" change to "unless
  --restart-children is given": capabilities-base.ts:786, registry.ts:190, lifecycle.md:609-612,
  structure/remote-link.md:9.


### D17 — Automatic mode: three knobs, three defaults

| Knob | Values | Default | Why |
|---|---|---|---|
| `catalogFanout` | auto, manual | **auto** | It is the root-cause fix (r1 layer a). It interrupts nothing: a catalog-only pinned sync restarts neither Codex nor the client runtime (D6 digest rule), and every guard stays on the Child. |
| `childCodexRestart` | never, app-server-when-idle | **never** | It ends running turns and composer state (registry.ts:193; capabilities-base.ts:652). The idle signal sees only relayed traffic (D5). The GUI shows "Codex restart needed" (D7/D8) with a one-click restart instead. |
| `updates` | off, notify, auto-when-idle | **notify** | See below. |

`notify` runs the observe op on each Child every 6 h and on Home start (jittered, one SSH session per Child,
hub-initiated only) and badges "Update available" (`versionSkew: behind` with route `orchestrated` or `desktop-request`).
`auto-when-idle`: only when this Home is a stable release (no prerelease tag, GOAT "preview/dev never
auto-update", R2 §4), only to the Home's own version, one Child at a time, only when D5 says idle and the plan
says `canApply`, never retrying a target that rolled back (`suppressedTarget`), and it starts after the Home has
served 10 min at its version (Home first, as GOAT does).
Why not GOAT's on-when-idle default: GOAT turns that on for installs GOAT itself manages and supervises (R2 §2
finding 2). Here the Home reaches into a machine through an SSH key, and the plan's owner-facing default is
"manual activation" (devlog/_plan/261107_auto_update_parity/000_plan.md:157, AU-002; :73 requires justifying
a default against GOAT). On top of that, the idle signal is Home-side only, signed supply is not wired into any
install path (R2 §3), and the commonest Child shapes (Desktop, Windows ocx.exe) would mostly yield owner-action
rows. Flip criterion, recorded for a later audit: P9's soak plus one release with no `uncertain` items in
real fleets. GOAT-managed Children are never driven by the Home (route `owner-action`, reason `goat`), so the two
orchestrators do not race.

### D18 — Policy storage

`<configDir>/link/child-policy.json` = `{schema:"ocx.link.child-policy/1", catalogFanout, childCodexRestart,
updates, idleAfterMs}`, strict (unknown key ⇒ defaults plus a warning in status), 0600, written under the config
mutation lock. It does not go in config.json: `OcxConfig` lives in src/types/config.ts at 1999 lines (no
headroom), and a link-owned file keeps the policy out of every non-link install (AGENTS.md "Optional
subsystems"). `idleAfterMs` is bounded to 60 000–3 600 000.

### D19 — Keeping out of src/update/* (Q6)

The Home side never imports src/update. It talks to the Child through the published CLI contract
`update.orchestrated/1` (src/cli/capability-contracts.ts:2) and parses its JSON with its own strict copy of the
schema in src/link/child-update-contract.ts, so internal refactors on codex/auto-update-signed-supply cannot
break it, only a contract version bump can (the parser rejects unknown schema strings and reports `refused:contract-unknown`).
The Child-side additions (D9 request command, D7 reporter, D13 marker) live in src/cli, src/client and desktop/.
The one shared fact is the exit-code table, pinned by a contract test that runs the real `ocx update --plan --json`
of this tree against the parser. Zero files under src/update/* change in any phase.

### D20 — Security and Windows

Authority: every operation runs over the same pinned channel that sync fan-out, DELETE and planting already use:
BatchMode, link-only known_hosts keyed by alias, `StrictHostKeyChecking=yes` (ssh-argv.ts:126; structure/remote-link.md),
the user's own SSH key. That channel can already run arbitrary commands as the Child user (R2 finding 5;
no forced command in src/link or src/client). Running the Child's **own** updater adds no credential, no new
artifact source and no new trust root: supply verification stays the Child installer's (registry integrity,
or Tauri signatures for Desktop). The binding comes from `--expect-plan` (plan token), `--not-after` (120 s
expiry), the Child mutex and `updateInFlight` (replay and concurrency), version equality with the Home (no
version chosen by the caller), and the post-update `--expect-link` sync (identity).
What this narrows from 060/080: no Home update signing key, no signed envelopes, no Child-local grant store
(060_linked_updates.md:70-101), no Child-polled exchange (080:10-74). The cost is accepting "the Home operator
who holds an SSH key to the Child" as the consenting principal. That is acceptable for one owner's fleet and
wrong for a shared machine; docs must say "do not link a machine you do not own". Child-initiated links stay
unsupported for every mutating op; 080's poll design remains the path if that is ever wanted.
Review triggers: new mutating /api/link routes, a new link-listener write (D7), and a Desktop updater entry
point (D9) all need explicit security review (src/AGENTS.md:20; MAINTAINERS.md).

| Op | POSIX | Windows (OpenSSH, Job-contained ocx.exe, structure/remote-link.md:15) |
|---|---|---|
| observe | yes | yes (read-only; a dropped channel only loses the answer) |
| sync | yes | yes (existing pinned script) |
| restart-codex app-server | yes | **refused** (`unsupported:windows-restart`) until the native OpenSSH fixture (`OCX_WINDOWS_OPENSSH_FIXTURE`) proves the SSH logon session can signal the user's app-servers |
| restart-codex codex | explicit only | **refused** (no interactive desktop from an SSH session) |
| update orchestrated | yes | **refused** (`unsupported:windows-apply`): kill-on-close kills the orchestrating parent on a drop, and Windows candidates are ocx.exe only (remote-windows.ts:147-151), so plans are almost always desktop/unknown anyway |
| update desktop-request | yes | yes (file request, D9) |

### D21 — Compatibility

| Pair | Behaviour |
|---|---|
| New Home, Child < 2.91 | No peer version; observe by inspect; owner-action; sync gated out below 2.93 (unchanged). |
| New Home, Child 2.93–2.96 | sync / restart-codex / auto catalog fan-out work (F2); update ⇒ owner-action:legacy-ocx, and nothing runs (D2). |
| New Home, Child >= 2.97 full | Everything except desktop-request (needs the D9 release) and D7 (needs P8). |
| New Home, ocx-child | sync works; restart and update unsupported; skew "unknown". |
| Old Home, new Child | Child's D7 reporter gets 404 and stops; nothing else is Child-initiated. |
| Old CLI, new Home | No `children=1` ⇒ identical rows; new routes unused. |
| New CLI, old Home | `child` absent ⇒ accepted; `ocx link update` gets 404 ⇒ "Home does not support Child operations (needs >= <release>)", exit 1. |
| Home downgrade | links.json untouched; child-observations.json and child-policy.json ignored. |

## 2. Work phases (dependency order; each one PR, independently verifiable)

| Phase | Content | Verification |
|---|---|---|
| P1 Foundations | D2 builder (POSIX+Windows, sync builder opts), D3/D12 contract parser and exit mapping, D4 store, classifier moved to src/link | argv golden + size tests (link-pinned-sync-argv, link-ssh-argv*), a gate test proving a fake 2.96 ocx never receives `update`, parser tests against this tree's real `ocx update --plan --json` |
| P2 Signals + visibility | D5 activity book, D6 pull recorder + revision monitor, observe-only engine, D8 `?children=1`, `ocx link status` / `ocx link check`, docs for status | route matrix tests (new sibling file, not the 1137-line one), projection tests, CLI old/new compat tests, `bun run structure:check` |
| P3 Operations core | D11 engine (sync, restart-codex, update), D13, D14 routes + registry, D15 CLI verbs + capabilities + skill surface, DELETE 409 | fake-runner engine tests for every exit row of D12, serialization and bulk tests, cli-capabilities parity, skill-ocx test |
| P4 ocx sync loosening | D16 flags, fan-out skip of busy links | sync-fanout / sync-command-fanout / cli-sync-expect-link tests, docs lifecycle.md + 7 locales |
| P5 Auto catalog fan-out | D17 knob 1 + D18 policy file + scheduler (catalog only), policy routes and `ocx link policy` | scheduler tests with fake clock (quiet period, digest rule, backoff, no timer without links), tests/lab/core-lab-boundary + startup import tests |
| P6 GUI | Version/skew badges, Check, Sync now, Restart Codex (with scope text), Update, Update all, policy panel, 11 locales | gui/tests/remote-link*.test.tsx in a sibling file, lint:i18n, screenshot in the PR description |
| P7 Auto updates | D17 knobs 2-3 (notify sweep, auto-when-idle), suppression, uncertain re-observe | scheduler tests with fake activity and plans; docs on defaults |
| P8 Child-side release | D7 reporter + Home route + peer feature, restart outcome marker, D10 `build-info`, D9 Desktop request (Rust poll + `ocx desktop update-request`) | tests/server/link-child-codex-state, reporter tests, ocx-child conformance, desktop cargo tests; security review |
| P9 Hardening | Windows native fixture for restart, end-to-end oracle (Child row context_window equals Home after sync, r1 idea 3), soak and default-flip audit | opt-in Windows OpenSSH fixture, e2e-style test |

P2 depends on P1; P3 on P1+P2; P4 on P1 only (it can land in parallel with P2/P3); P5 on P3+P4; P6 on P3 (and
shows P5's policy once it lands); P7 on P5; P8 on P3 (Home half) and stands alone on the Child; P9 last.
The user-visible symptom is fixed by P5 (catalog) plus a manual Restart Codex (P3); P8 makes the remaining
staleness visible instead of inferred.

## 3. Unresolved assumptions

1. The exact `ocx.update.plan/1` and `result/1` key sets are taken from r3/R2 citations
   (src/update/orchestrated-plan.ts:22-48); P1's contract test must read them from this tree, not from this note.
2. Whether a macOS SSH session can relaunch the Codex desktop app (`codex` scope) is untested; the outcome is
   reported as `requested` only.
3. The Desktop shell's config-dir resolution for the request file (D9) is unverified.
4. The 600 s idle threshold is a starting value from R2; a fleet with long gaps between turns may want longer.
5. Effort-gate refusals (connect.ts:932) make a Child look "current" by pull time; D7's fingerprint closes it after P8.
6. Children enrolled before `remotePlatform` need platform discovery on the first op (existing `requireRemotePlatform`, link-routes.ts:231-233), costing one extra SSH call.
7. The orchestrated driver's behaviour when the Child's own Codex app-server is the update's parent was not examined; Home-initiated runs come from sshd, not from Codex.

NOT RUN: tests, typecheck, builds (read-only design brief). No claim here is about passing tests.


# R3: Surface map for Home-to-Child version visibility, updates and operations

Checkout: <checkout>, branch codex/link-child-updates == origin/dev 00680193cb.
Read-only research; nothing tracked was edited. Line numbers are at 00680193cb.

## 0. Headline constraints (read first)

1. File-size ratchet. No link, sync, GUI Remote Link or link-test file has a per-file cap in
   tests/fixtures/file-size-baseline.json (the only matching cap is src/codex/catalog/sync.ts 52).
   Uncapped files fail only at >= 2000 lines (scripts/file-size-ratchet.ts:4 THRESHOLD, :123-124
   NEW_OVERSIZED). src/cli/index.ts is 1999 lines: ZERO HEADROOM, do not add a line. gui/src/i18n/*.ts
   are exempt (scripts/file-size-ratchet.ts:53-65). Everything else listed below has ample headroom.
2. Status row compatibility. ocx link status validates rows with assertKeys(required, optional)
   (src/cli/link.ts:87-93, :159). An older CLI rejects any row key it does not know. New row fields
   must be opt-in by query, like ?compatibility=1 (peer, local) and ?diagnostics=1 (tunnel)
   (src/server/management/link-routes.ts:307-314). GUI-session and admin-token callers get different
   bodies (link-routes.ts:315-319). Counter-precedent: OCX-6 parity keys (7c08a29483, #7484) and
   childKind were added unconditionally to every row, so a pre-2.91 CLI against a newer runtime already
   fails; do not repeat that.
3. Home -> Child operations travel over SSH only, and only for Home-initiated links. Client-initiated
   links have hostKeyFingerprint null and the Home never opens SSH to them (structure/remote-link.md:29;
   reconnect refuses them with 409 link_not_home_initiated, link-routes.ts:186-188). Updating or
   restarting a client-initiated Child needs a new Child-polled channel (security-sensitive) or stays
   out of scope.
4. The version the Home already knows is the Child's RUNNING version from relay-auth challenge headers
   (src/link/peer-report.ts:15-16, :47-55): in memory only, lost on Home restart, absent until the Child
   relays a request, absent for Children < 2.91.0 (structure/remote-link.md:88-90). It is exposed only by
   GET /api/link/status?compatibility=1 as links[].peer.version (src/link/status-projection.ts:76-83;
   src/link/compatibility.ts:38-48). The dashboard does NOT send that query
   (gui/src/pages/RemoteLink.tsx:206) and neither does the sync fan-out status read
   (src/cli/sync-link-status.ts:29). The INSTALLED version (what an update changes before a restart) is
   only reachable over SSH: remoteInspectRuntimeArgv / inspectRemoteChildRuntime in
   src/link/remote-plant.ts:88-115 (used by ocx link probe; reads the served-runtime census).
5. ocx-child is not updatable with ocx update. It reports a fixed protocol version 2.98.0
   (native/ocx-child/src/lib.rs:18-21) and silently accepts and ignores --restart-codex and
   --restart-app-server-only in sync (native/ocx-child/src/cli.rs:1211-1215). Updating it means
   re-planting (src/link/remote-plant.ts:173 remotePlantChildArgv). Branch on record.childKind.
6. Management API and link route changes are security-boundary changes (src/AGENTS.md:20; AGENTS.md
   review guidelines; MAINTAINERS.md). A PR adding mutating /api/link routes needs explicit security review.

## 1. Management API

Registration: src/server/management-api.ts:235-239 lazily imports handleLinkRoutes for /api/link; it is
dispatched at :368 after claude-intercept and session routes. Handler:
src/server/management/link-routes.ts:269-363 (363 lines). Helpers: link-route-state.ts (193).
Enrollment probe/confirm/apply: link-enrollment.ts (364). Declared inventory:
src/server/management/route-registry.ts:431-439 (484 lines); every new route must be declared there
(tests/server/management-route-registry.test.ts reconciles source and declaration), with
mechanism "regex" for /api/link/{id}/... paths. Sibling guard: sibling-guard.ts:40 (join only).

Auth model (link-route-state.ts:68-101):
- dashboardSession: paired GUI session, or on standalone only the current loopback-issued session on
  trusted loopback ingress (casual-path protection, not a secret boundary).
- pairedSession: operator-paired GUI session only (used by join).
- adminLoopback: admin token on trusted loopback ingress.
- "either" = dashboard || admin. Tailscale identity sessions always 403 (link-routes.ts:273, route-state.ts:95).
- GUI POSTs get session and CSRF headers from the global fetch wrapper gui/src/api.ts:729-731.
- Non-loopback Home: the private Unix socket admits ONLY GET /api/link/status
  (src/server/index/local-control-listener.ts:41, :347); the CLI uses it via src/cli/link-local-control.ts
  and only runStatus does (src/cli/link.ts:310). New POST verbs from the CLI on a 0.0.0.0 Home will get
  403 over TCP like revoke/reconnect today; widening the socket allowlist is a security change.

Existing routes (link-routes.ts):
| Route | Auth | Body | Success |
|---|---|---|---|
| GET /api/link/status | either | - | K16 LinkStatusDto; +local/peer with ?compatibility=1; +tunnel with ?diagnostics=1; +joinAvailable/joinDenied/homeCodexSettingsDigest for gui-session (:287-321) |
| GET /api/link/candidates | dashboard | - | {candidates:[{alias,source}]} (:72-75) |
| POST /api/link/probe, confirm-host, apply | either | see link-enrollment.ts | (:327-341) |
| POST /api/link/issue | admin | exactly {alias,tunnelPort} | {linkId,apiKeyId,key,listenerPort} (:77-121) |
| POST /api/link/join | paired | exactly {alias} | 202 {linkId,alias,restarting:true} (:153-175) |
| POST /api/link/{id}/reconnect | either | none | {linkId}; 409 link_not_home_initiated; 503 listener_unavailable/link_unavailable (:182-199, :347-354) |
| DELETE /api/link/{id} | either | optional {force?,purge?} | {linkId}; runs SSH ocx disconnect via buildExecArgv(remoteOcxArgv(["disconnect"], platform)), 30 s (:201-267) |
Error envelope: fail(code,message,status,hint?) -> {error:{code,message,hint?}}, no-store (route-state.ts:49-51).
LINK_ID = /^lnk_[0-9a-f]{16}$/ (link-routes.ts:27). Per-alias overlap set: LinkRouteState.operations (route-state.ts:42).
Template for a new remote op: link-routes.ts:231-243 (platform = record.remotePlatform ?? requireRemotePlatform).
Test seams: ctx.deps.sshRunner, readLinkStore, writeLinkStore, linkKnownHostsPath (route-state.ts:103-117).

Long-running precedent: POST /api/update/run returns {ok,job}; GET /api/update/status?jobId polls
(src/server/management/config-routes.ts:964-1013). A Child update over SSH takes minutes, so follow that
202 + job pattern rather than holding the request open.

Status projection (src/link/status-projection.ts, 177): LinkStatusDto :12-37; projectLinkStatus :126-177
(rows: id, alias, direction, state, since, reason, tunnelPort, childKind?, parity fields); opt-in
attachers attachLinkPeers :77-83 and attachLinkTunnelDiagnostics :56-74. Add a new attacher behind a
new query, mirroring these.
CLI validators that must learn any new field: validateStatus src/cli/link.ts:140-205 (optional list at
:159, shape checks like validatePeer :120-138 / validateTunnel :408-427); the CLI sends the query at :311.
GUI parser gui/src/remote-link-api.ts:141-160 is lenient but maps only known fields, so new fields need
explicit parsing plus an absent-field fallback for older Homes.

Tests: tests/server/link-management-routes.test.ts (1137; principal matrix :360-453, compatibility
query :487-505, reconnect :843-898), tests/clients/link-status-projection.test.ts (154),
tests/clients/link-peer-compatibility.test.ts (196), tests/clients/link-tunnel-history.test.ts,
tests/server/local-control-socket.test.ts, tests/server/management-route-registry.test.ts.

## 2. CLI

Dispatch: src/cli/dispatch.ts:416-417 (link -> runLinkCommand), :407 (sync inside withSyncUpdateGuard).
src/cli/link.ts (446): LINK_USAGE :36-47; switch :385-398; linkRequest :239-255 (admin token through
runtimeRequest; errors reduced to {error:{code,hint?},residual?} by errorCodeBody :257-266);
runReconnect :373-383 is the template for a per-link POST verb.
Others: link-enrollment.ts (224), link-cleanup.ts (80; read-only per-link SSH platform probe, the
template for a per-link SSH read), link-child.ts (108, Child-side refusals), link-local-control.ts (49).

Capability registry: src/cli/capabilities.ts (54) concatenates capabilities-base.ts (882) and domain
files; link entries are capabilities-base.ts:38-99. Shape: src/cli/capability-types.ts:22-41.
Contracts: src/cli/capability-contracts.ts:2 ["sync.home-fanout/1","update.orchestrated/1"]
(tests/cli/cli-capabilities-arguments.test.ts:36-75). Command registry and help: src/cli/registry.ts:154-163
(link), :186-197 (sync), :296-301 (update; orchestrated exits 0/10/11/12/64); src/cli/help.ts:52.

Adding ocx link update / sync / restart-codex requires:
1. route-registry.ts entries for the new routes;
2. one Capability per verb (routes, flags, mutates:true, json, usage, details); put them in
   capabilities-access-remote.ts (168) to keep capabilities-base.ts from growing; the generator groups
   by root "link" anyway (scripts/generate-ocx-skill-surface.ts:25);
3. tests/cli/cli-capabilities.test.ts parity: each capability route must exist in the registry
   (:191-197) and each registry route must be capability-covered, exempt, or in the shrink-only ratchet (:200-262);
4. registry.ts link usage/details and LINK_USAGE;
5. bun run skill:surface regenerates skills/ocx/references/01_surface_access-remote.md and
   01_management_surface.md (CI runs skill:surface:check and tests/ci-workflows/skill-ocx.test.ts); hand-edit
   05_remote_hub.md, 04_failure_semantics.md, 02_json_shapes.md, 03_recipes.md (that test also fails when a
   hand page names a command the registry lacks);
6. optionally a contract string (for example "link.child-ops/1") so GOAT can detect support.
No MCP surface exists for link; agent exposure is ocx capabilities plus skills/ocx.
CLI tests: tests/cli/cli-link.test.ts (296), cli-link-enrollment, cli-link-cleanup, cli-link-force,
cli-link-child, cli-capabilities*.test.ts.

## 3. Sync fan-out

Home path: src/cli/sync-command.ts:17-235. Flags: src/cli/sync-flags.ts:3-10 (only --local-only, --json).
Engine: src/cli/sync-fanout.ts:99-151 runHomeFanout (concurrency 3, 180 s per Child, +3 s grace). runChild
closure sync-command.ts:210-225 runs buildExecArgv({alias, knownHostsFile, argv: remotePinnedSyncArgv(link.id, platform)}).
Document schema "ocx.sync.fanout/1" (sync-fanout.ts:86, :105); the advertised contract is
"sync.home-fanout/1". Exit: a Home nonzero passes through; otherwise 6 for failed, timed-out or hinted
skip (:153-156). Children are skipped unless their status row is "connected" (:132-134).

Where the restart is withheld (no branch; the pinned argv has no restart flag):
- POSIX exec line src/link/ssh-argv.ts:365  exec "$c" ... sync --expect-link "$1" --json ; builder :372-374.
- Windows src/link/remote-windows.ts:213-214  dataLine({args:["sync","--expect-link",linkId,"--json"]}).
- Text: capabilities-base.ts:786 "A current Home catalog fans out to linked Children. Fan-out never
  requests a Codex app or app-server restart on a Child; use GOAT or ocx sync --restart-codex there.
  Applying changed Home settings may restart the Child's own OpenCodex client runtime."
  registry.ts:190 "Fan-out never requests a Codex app or app-server restart on a Child; use GOAT or ocx
  sync --restart-codex on the Child. The Child's pinned sync may restart its OpenCodex client runtime
  after applying changed Home settings."
  docs-site/src/content/docs/reference/cli/lifecycle.md:609-612 "Fan-out never requests a Codex app or
  app-server restart on a Child. Use GOAT, run ocx sync --restart-codex on a full ocx Child, ..."
  structure/remote-link.md:9 "... before executing sync --expect-link without a restart flag."
- The Home's own --restart-codex is read from the same argv (sync-command.ts:36; restart-scope.ts:31-58,
  exact-token args.includes), so a Child-directed opt-in needs a distinct flag name.

Child side of the pinned sync:
- Gate >= 2.93.0 inside the script (ssh-argv.ts:330-358 awk; Windows remote-windows.ts:219-222). Markers
  ocx-fanout:selected:<v> (stderr) and ocx-fanout:stdout-begin (stdout). Exit 121 + marker for
  lacks-expect-link or version-unknown, 125 platform unsupported, 126 not contained (Windows Job),
  127 not found.
- classifySyncResult sync-fanout.ts:42-82: exit 5 child-link-mismatch:<reason>, 7 child-updating; a JSON
  document must have exactly {schema,home,fanout,children}, fanout not-applicable and children [] (:28-40).
  CONSEQUENCE: a Child cannot add fields to its own sync JSON without older Homes classifying it
  child-output-invalid. Report new Child outcomes (restart result) as an extra stderr marker, or add a
  schema the new Home accepts alongside /1.
- Update mutex: dispatch.ts:407 -> src/cli/sync-update-guard.ts:5-18 -> src/update/sync-update-mutex.mjs:84-99.
  refuseSync: "sync-in-progress" exit 1, "update-in-flight" exit 7; with --json it prints a fanout/1
  document with home skipped.
- Expectation: src/cli/sync-expectation.ts:21-60 (exit 5; usage exit 2; last stderr line JSON
  {phase,reason}); enforced under lock in src/client/connect.ts:870-886 (syncConnectedClient, withLinkApply;
  busy lock -> pending_operation). Reasons the Home accepts: sync-fanout.ts:26.
- How a Child applies --restart-codex: readRestartScope (sync-command.ts:36-41); connected path calls
  handleConnectedSyncCatalogWrite (:78, :237-243), which restarts ONLY when catalogWritten || cacheSynced
  (the local path also honours a committed config change, :154-157). handleRestartScopeAfterWrite
  (src/cli/restart-scope.ts:75+) SIGTERMs matching app-server/code-mode-host processes and fully quits and
  relaunches the Codex desktop app, excluding desktop-tree app-servers; self-ancestry handoff/refusal
  :150-165. ConnectedSyncOptions.restartCodex (connect.ts:860) is unused (sync-command.ts:37-41).
  Separately, OCX-6 restarts the Child's OpenCodex client runtime (not Codex) when an apply was recorded
  (sync-command.ts:84-104; src/cli/link-apply-restart.ts).
- Remote restart risks: the desktop restart has no SSH/headless awareness (no SSH_CONNECTION or session
  checks in src/codex/desktop-app-restart.ts or restart-scope.ts). A Windows OpenSSH session cannot show a
  GUI in the user's desktop session; a macOS relaunch from SSH needs a logged-in GUI session. Default a
  remote opt-in to app-server-only, or require a separate desktop opt-in. "Restart now" without a catalog
  write already exists locally as ocx system codex-restart --yes (capabilities-base.ts:648-655,
  POST /api/system/codex-restart), a better remote target for an explicit "Restart Codex" operation than
  sync --restart-codex.
- Targeting one Child: add a Home flag (for example --child <linkId>; do not reuse --expect-link, the
  Child identity flag parsed on every sync, sync-command.ts:27-33) in sync-flags.ts, and a filter in
  runHomeFanout (:125-148) that leaves unselected rows skipped with a reason and no hint (so exit 6 is
  not triggered, :155). An unknown link id should fail before the Home sync (usage exit 2).
- Pinned builders need an options parameter: remotePinnedSyncArgv(linkId, platform, opts) forwarding
  extra args after "$1" (argv quoted once by quoteRemote, ssh-argv.ts:303-317), and windowsPinnedSyncArgv
  adding them to dataLine args (encoded command must stay under POWERSHELL_ENCODED_MAX 8000). Tests:
  tests/clients/link-pinned-sync-argv.test.ts (216), link-ssh-argv.test.ts (413), link-ssh-argv-discovery.test.ts.
- Fan-out status read src/cli/sync-link-status.ts:29 GETs plain /api/link/status over TCP with
  runningProxyUpdateHeaders and no local-control socket; on a non-loopback Home it yields
  home-link-status-unauthorized (existing gap). Adding ?compatibility=1 there lets fan-out skip
  outdated Children before SSH.
Sync tests: tests/cli/sync-fanout.test.ts (140), sync-command-fanout.test.ts (295),
sync-fanout-process.test.ts (90), sync-link-status.test.ts, cli-sync-expect-link.test.ts (504),
tests/update/update-sync-mutex.test.ts (345), tests/cli/cli-json-contract.test.ts.

Update over SSH (Home-initiated full ocx Child): ocx update --plan --json, then
ocx update --yes --json --expect-plan <token> --not-after <unix-ms> (registry.ts:296-301), through
buildExecArgv + remoteOcxArgv(["update", ...], platform). On Windows the command runs inside the
kill-on-close Job with silent breakaway (structure/remote-link.md:15): a runtime the update starts
survives a dropped channel, but the update process itself dies with it. Use long timeouts and treat
exit 12 or a drop as "unknown, re-inspect". Do not touch src/update/* (codex/auto-update-signed-supply owns it).

## 4. GUI

gui/src/pages/RemoteLink.tsx (606): ERROR_TKEY Record<LinkErrorCode,TKey> exhaustive (:45+), REASON_TKEY
(:95-102), JOIN_DENIED_TKEY; status fetch :206 (no query); poll every 5 s plus a visibility refresh
(:232-240); row list :522-546 (alias, childKind badge, parity badge via paritySynced :133-135, state,
direction, reason, Disconnect); Retry posts reconnect for failed/reconnecting hub rows (:380-395); busy
union :153. Siblings: RemoteLinkSheet.tsx (200), RemoteLinkDialogs.tsx (66),
components/v2-startup/remote-link-parts.tsx (161), styles-remote-link.css (14). Put new row actions and a
version badge in a new component file rather than growing RemoteLink.tsx.
gui/src/remote-link-api.ts (281): LINK_ERROR_CODES :1-46 (closed; a new code forces an ERROR_TKEY entry),
LinkRowWire :69-79, parseRemoteLinkStatus :141-160, requestLinkJson :203-206. Mounted at gui/src/App.tsx:717.
i18n: 11 catalogs typed Record<TKey,string>, compile-checked; every key goes in all of them:
gui/src/i18n/en.ts (TKey source :4384), de, fr, ko, zh, zh-TW, ru, ja, tr, vi, pt (registry
gui/src/i18n/catalogs.ts:26-38). Existing keys: remoteLink.* (90 in en). Run bun run lint:i18n
(gui/AGENTS.md:13-30); tests gui/tests/locale-parity.test.ts, i18n-locales.test.ts.
GUI tests: gui/tests/remote-link.test.tsx (1283; fetch helper response() :38, status stub :535),
gui/tests/remote-link-route.test.tsx (453), dashboard-sync-feedback.test.tsx. They run through
gui/package.json (bun ../scripts/test-with-pinned-bun.ts --isolate tests) and are not in the root test
layout. A gui/ PR needs a screenshot uploaded in the description, never committed.

## 5. Docs

Guide: docs-site/src/content/docs/guides/remote-link.md (225; Link status :66, CLI reference :137-148,
Home and Child versions :162-180) plus fr, ja, ko, ru, tr, zh-cn, zh-tw copies.
CLI reference: docs-site/src/content/docs/reference/cli/lifecycle.md (1451; ocx sync :592-614, the
fan-out restart paragraph :609-612; link status/parity :1336-1404) plus the same 7 locales.
Possibly guides/remote-hub.md (+locales; checked by tests/ci-workflows/docs-remote-hub-claims.test.ts)
and guides/codex-integration.md. English is canonical (docs-site/AGENTS.md:9).
structure/remote-link.md (209 lines; doc budget 600 in manifest sizeBudgetLines): update :9 (pinned sync
"without a restart flag"), Tunnels, management and CLI :67-71, Home and Child version report :116-127,
Dashboard presentation :47-51, Dashboard admission :53-63 (route list). Its manifest "documents" list
covers src/link/, link-routes.ts, link-enrollment.ts, src/cli/link-apply-restart.ts, status-link.ts,
link-local-control.ts and more; add any new src/server/management/link-*.ts and src/cli/link-*.ts there,
then bun run structure:index and bun run structure:check (stage new files first; structure/AGENTS.md).
structure/cli-management.md owns src/cli/ and skills/ocx/ (the fan-out PR touched it).

## 6. Line counts (no per-file caps apply; the limit is < 2000)

src/cli/index.ts 1999 (AT THRESHOLD) | src/codex/app-server-processes.ts 1537 | src/client/connect.ts 1251 |
src/cli/dispatch.ts 1114 | src/cli/capabilities-base.ts 882 | src/cli/registry.ts 861 |
gui/src/pages/RemoteLink.tsx 606 | src/server/management-api.ts 588 | src/link/supervisor.ts 541 |
src/server/management/route-registry.ts 484 | src/cli/link.ts 446 | src/link/ssh-argv.ts 374 |
src/server/management/link-enrollment.ts 364 | link-routes.ts 363 | src/link/remote-plant.ts 306 |
gui/src/remote-link-api.ts 281 | src/link/remote-windows.ts 246 | src/cli/sync-command.ts 243 |
src/cli/link-enrollment.ts 224 | link-route-state.ts 193 | status-projection.ts 177 |
capabilities-access-remote.ts 168 | sync-fanout.ts 161 | sync-flags.ts 10 |
gui/tests/remote-link.test.tsx 1283 | tests/server/link-management-routes.test.ts 1137 |
tests/cli/cli-sync-expect-link.test.ts 504 | reference/cli/lifecycle.md 1451 | guides/remote-hub.md 838.
gui/src/i18n/*.ts exempt. Put new cases for the two large test files in sibling files.

Test-layout registration for a new root test file (gui/tests excluded):
- add "<name>.test.ts": "<domain>" to scripts/test-layout/layout.json "explicit" or to its domain shard
  (scripts/test-layout/layout-clients.json for clients);
- add the same pair to tests/fixtures/test-layout-expected.json (the only expected shard in this tree);
- scripts/test-layout/seeds.json regexes place conventionally named files until then.
Examples: a4f335c075 (#7494) added tests/clients/link-peer-compatibility.test.ts via layout-clients.json:43
and test-layout-expected.json:291; 4948c04d9c (#8100) added sync-fanout*.test.ts and sync-link-status.test.ts
(cli) and link-pinned-sync-argv.test.ts (clients) via layout.json explicit + test-layout-expected.json + seeds.json.

Focused tests per surface: routes -> tests/server/link-management-routes.test.ts, link-child-parity.test.ts,
management-route-registry.test.ts; projection -> tests/clients/link-status-projection.test.ts,
link-peer-compatibility.test.ts; CLI -> tests/cli/cli-link*.test.ts, cli-capabilities*.test.ts,
tests/ci-workflows/skill-ocx.test.ts; sync -> tests/cli/sync-*.test.ts, cli-sync-expect-link.test.ts,
tests/update/update-sync-mutex.test.ts, tests/clients/link-pinned-sync-argv.test.ts, link-ssh-argv*.test.ts;
ocx-child -> tests/clients/link-ocx-child-conformance.test.ts and native/ocx-child tests; GUI ->
gui/tests/remote-link*.test.tsx, locale-parity.test.ts; docs -> tests/ci-workflows/docs-*.test.ts;
boundary -> tests/lab/core-link-boundary.test.ts.

## 7. Proposed module placement

- src/link/child-ops.ts (pure): argv builders for remote update plan/apply (via remoteOcxArgv), remote
  Codex restart (ocx system codex-restart --yes --json, or sync with restart options), parsers for the
  orchestrated update JSON and exit codes, childKind branching (ocx-child -> replant).
- src/link/child-version.ts (pure): compare peer.version or the SSH-inspected installed version with the
  Home's own version or the npm latest the Home already checks (GET /api/update/check,
  config-routes.ts:954-962); verdict up-to-date | behind | unknown | ephemeral.
- src/link/ssh-argv.ts and remote-windows.ts: an options object on the pinned sync builders (restart scope),
  keeping the >= 2.93.0 gate, plus a stderr marker for the restart outcome.
- src/server/management/link-child-ops.ts: POST /api/link/{id}/sync, /restart-codex, /update (202 + job)
  and GET /api/link/{id}/update/status (or one /operations resource), reusing link-route-state.ts helpers and
  LinkRouteState.operations for per-link exclusion; link-routes.ts gets only a delegating branch.
  Declare the routes in route-registry.ts.
- src/link/status-projection.ts: a new opt-in attacher (for example ?children=1) for installed version,
  update verdict and last operation; CLI validation in src/cli/link.ts or a new link-status-validate.ts.
- src/cli/link-child-ops.ts: runLinkUpdate, runLinkSync, runLinkRestartCodex; link.ts only gains switch arms
  and LINK_USAGE lines. Capabilities in src/cli/capabilities-access-remote.ts.
- src/cli/sync-flags.ts, sync-fanout.ts (filter and options), sync-command.ts (runChild plumbing): the Home
  --child <linkId> flag and an explicit Children restart opt-in. Never touch src/cli/index.ts.
- gui/src/remote-link-child-ops-api.ts (requests, parsing) and gui/src/pages/RemoteLinkChildActions.tsx
  (row menu: Sync now, Restart Codex, Update, version badge); RemoteLink.tsx renders it and requests status
  with the new query.

## 8. Side note on "1M context shows ~250k" (unverified hypothesis)

The Child writes the Home catalog verbatim after an effort-compatibility check
(src/client/catalog-compatibility.ts:1-17; src/client/connect.ts:77). 272_000 * 0.95 = 258_400 matches
"~250k" and NATIVE_GPT6_CONTEXT.contextWindow 272_000 (src/codex/catalog/native-models.ts:77-78; Codex
spends context_window * effective_context_window_percent, metadata.ts:157). A likely cause is the
outdated Child's models_cache or native metadata path, or its Codex runtime, using the native context
instead of the Home's value. Needs its own lane; not reproduced here.

NOT RUN: tests, typecheck, builds (read-only lane on a shared host).


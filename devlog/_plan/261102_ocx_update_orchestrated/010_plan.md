# 010 — Orchestrated ocx update (contract C1) — diff-level plan

Lane L1, branch feat/ocx-update-orchestrated, base origin/dev affd8403a. Class C4 (public CLI
output contract + update/install mutation path). Consumer: GOAT L3 (adopted-member update).

## Contract (agreed with L3, cc L2, 2026-11-02)

- `ocx update --plan --json [--tag latest|preview | --version X.Y.Z]` read-only. stdout is one JSON
  object, exit 0 even when the plan refuses (usage errors exit 64; --tag with --version is 64).
  {schema:"ocx.update.plan/1", currentVersion, targetVersion|null, installer:
  "npm"|"pnpm"|"bun"|"mise"|"desktop-app"|"source"|"unknown", runtimeOwner:
  "service"|"desktop-app"|"unmanaged"|"none"|"unknown", servingPath|null, cliPath, canApply,
  reason?, restartRequired}.
- reason codes (first match wins, in this order): desktop-app-owned, source-checkout, mise-managed,
  installer-unknown, serving-install-unknown, cli-not-serving-install, runtime-ownership-refused,
  target-unresolved, downgrade-refused, up-to-date. canApply=true only with no reason.
- `ocx update --yes --json [...]` recomputes the plan, then applies. stdout is one JSON object
  {schema:"ocx.update.result/1", applied, fromVersion, toVersion|null, installer, restarted, healthy,
  rolledBack, error?}; progress goes to stderr. exit 0 = applied or up-to-date (applied=false),
  10 = refused (plan reason, nothing touched), 11 = failed with the previous version verified in
  place (rollback or refusal before mutation), 12 = failed with state not verified, 64 = usage.
- `ocx capabilities --json` gains top-level `contracts: string[]` on every output shape (full,
  --route, --mutating-only, unmatched route). `ocx capabilities --contracts --json` prints only
  {"schemaVersion":1,"contracts":[...]} (output is small enough for GOAT's 256 KiB / SSH budget);
  --contracts with --route/--mutating-only exits 64. List lives in
  src/cli/capability-contracts.ts CAPABILITY_CONTRACTS (L2 appends "sync.home-fanout/1").
- desktop-app: the Tauri updater's check/install commands require the update page window
  (desktop/src-tauri/src/lib.rs update_check/update_install → window::require_update_page) and the
  tray menu; there is no external trigger, so desktop-app installs plan canApply=false
  reason "desktop-app-owned" and the CLI never edits app-owned files.

## Serving-install identity (core rule)

Decide against the install that serves the live runtime of the current home:
1. Live runtime = runtime-port.json {pid,port} whose /healthz answers service "opencodex" with the
   same pid (bounded timeout). No record / dead → runtimeOwner "none", subject is the CLI install.
2. Serving command = argv of that pid (POSIX: ps -ww -o command= / Linux /proc/<pid>/cmdline;
   Windows: Win32_Process CommandLine through the existing bounded reader, or null). Resolve its
   install root: compiled exe → exe path; bun + <root>/src/cli/index.ts → <root>; node <root>/bin/ocx.mjs
   → <root>. Cross-check with serving-runtimes.json (src/config/serving-runtimes.ts) record whose
   command key matches and whose version equals healthz version. Unresolvable → servingPath null
   → reason serving-install-unknown (fail closed).
3. cliPath = realpath of this CLI's package root (or standalone exe). servingPath ≠ cliPath →
   cli-not-serving-install (lidge: PATH npm 2.50.0 vs serving 2.83.0). Nothing is touched.
4. runtimeOwner: desktop supervision (inspectDesktopSupervision) or recorded desktop owner →
   desktop-app; service installed and recorded owner is this CLI → service; else unmanaged;
   read failures → unknown. planUpdateRuntimeHandling(...).mayReplacePackage=false or ownership
   unknown → runtime-ownership-refused.
5. installer: detectInstallOwnership(); standalone → desktop-app when the exe lives in the desktop
   bundle/home or desktop owns the runtime, else unknown.
6. target: --version validated as strict semver and confirmed published (registry view of that exact
   version through the installer's trusted invocation) else latestVersion(tag). Unresolved →
   target-unresolved. target < current → downgrade-refused; equal → up-to-date.
7. restartRequired = a live runtime served by this install exists (the update stops/restarts it).

## Apply lanes (reuse, no new mutation code)

- npm/pnpm (node_modules, non-bun-global): bin/ocx.mjs must keep the package's bundled Bun idle
  during replacement (Windows file locks), so the Node launcher drives apply: spawn Bun child
  `update --plan --json <args>` (capture), refuse/up-to-date → result; else spawn Node child of the
  existing lane `node bin/ocx.mjs update --tag T | --version X` with stdout→stderr, then readback.
  `--plan` (and apply for other installers) skips the launcher's mise/npm/pnpm intercepts and falls
  through to the Bun CLI.
- bun global: Bun handler spawns the existing runUpdate lane as a child (selfLaunchArgv) with
  stdout→stderr, then readback.
- Version pin: runUpdate and runPackageManagerSelfUpdate accept `--version X` (install
  PKG@X instead of PKG@tag, integrity pre-flight for X, already-current check against X).
- Readback (shared .mjs, usable from Node and Bun): installed package.json version at the install
  root; runtime probe (runtime-port + /healthz pid/version) with bounded probation when
  restartRequired. applied = installed == target; restarted = new live pid ≠ prior pid;
  healthy = restartRequired ? live && version == target : installed == target. Child failure with
  installed == from (and prior runtime live again when it was live) → exit 11 rolledBack=true; anything
  else → 12.

## Files

- new src/update/orchestrated-contract.mjs/.d.mts: schemas, exit codes, argv parser, result builder,
  readback helpers (Node+Bun safe, no TS imports).
- new src/update/orchestrated.ts: planOrchestratedUpdate(request, deps) with injectable deps;
  runOrchestratedUpdate(argv) for plan + bun-lane apply.
- src/update/serving-identity (inside orchestrated.ts or own file): process argv reader + root resolver.
- src/update/index.ts (runUpdate pin), bin/ocx.mjs (intercept order, pin, npm/pnpm apply driver, help).
- src/cli/dispatch.ts update branch; src/cli/registry.ts usage; src/cli/capability-contracts.ts;
  src/cli/capabilities-command.ts (+ capability entry for update flags if the registry requires it).
- skills/ocx surface regenerated (bun run skill:surface); structure doc owning src/update + manifest;
  docs-site reference/cli/lifecycle.md section (English).
- tests: tests/update/update-orchestrated-plan.test.ts (decision matrix incl. lidge mismatch,
  desktop-app, source, mise, unknown, serving unknown, ownership refused, up-to-date, downgrade, pin),
  tests/update/update-orchestrated-apply.test.ts (exit 0/10/11/12 classification, stdout = 1 JSON,
  fake child runner + temp home), launcher routing test (plan never runs npm self-update; fake npm
  on PATH in temp home), tests/cli capabilities contracts/--contracts; real subprocess
  `bun src/cli/index.ts update --plan --json` in a temp OPENCODEX_HOME. Layout registrations in
  scripts/test-layout + tests/fixtures/test-layout-expected*.json.

## Out of scope
desktop/ Rust, sync fanout (L2), GOAT (L3), releases. No real home, service, desktop app restart.

## Verification
bun run typecheck; focused new/changed tests; bun run test:changed; bun run structure:check;
bun run skill:surface:check; bun run privacy:scan; bun run lint:gui not needed (no gui/).
PR to dev, exact-head CI per job, fresh terra xhigh review PASS, squash merge --match-head-commit.


## Audit r1 folds (terra xhigh FAIL → revised)

A1 Passive entry. bin/ocx.mjs recognizes orchestrated argv (`update` with --plan/--yes+--json, any
   malformed variant of them, and `capabilities`) BEFORE the boot-restore probe (bin/ocx.mjs:1299) and
   resolves Bun with allowInstall:false; src/cli/root.ts skips the Codex shim auto-repair (root.ts:156)
   for the same argv. Missing Bun → plan JSON reason "plan-unavailable" (exit 0) / apply exit 10.
   Tests: recoverable backup untouched, placeholder Bun not installed, eligible shim repair not run.
A2 Identity bound to mutation. The apply child gets internal flags
   --orchestrated-expect <base64url JSON {home, cliRoot, servingRoot|null, runtimePid|null, runtimeStart?}>
   and --orchestrated-result <file>. Both legacy lanes re-run the serving-identity check inside their
   existing mutation lease immediately before stop and again before replacement (Bun lane:
   withUpdateOwnershipLease in runUpdate; Node lane: acquireOwnershipMutationLease in
   runPackageManagerSelfUpdate). Change before stop → write {phase:"refused-before-mutation"} and exit
   → parent exit 10. Change after stop → existing recoverStoppedRuntime, outcome "failed" → 12.
   Deterministic tests: takeover between plan and stop, PID reuse (same pid, different process start /
   command), different serving root.
A3 Runtime presence is tri-state via existing liveness evidence (proxy-liveness / probeProxyLiveness):
   absent = no valid record AND configured endpoint proven dead; live = record pid == /healthz pid on the
   record's hostname:port; anything else (unreadable record, timeout, pid mismatch, pidless/legacy health,
   live configured endpoint without matching record) = unknown → reason serving-install-unknown.
A4 Exact pin. The apply child always receives --version <plan.targetVersion> (never --tag) in npm, pnpm
   and Bun lanes; each lane keeps its integrity pre-flight for that exact version. Tests: tag moves
   between plan and apply → installs planned version; pin reaches npm/pnpm/bun argv.
A5 Outcome evidence comes from the installers, not readback alone. Lanes write the --orchestrated-result
   file at existing decision points: npm transactionalNpmUpdate(tx.phase/rolledBack), pnpm
   runPnpmGlobalUpdate({ok,path,activePath,rolledBack}), Bun lane install status. Absent/garbled file →
   12. rolledBack=true only from installer-verified rollback (+ runtime restored when it was live) → 11.
   Pre-mutation refusal → 10 with rolledBack=false. Post-success runtime readback is bound to the same home
   and the installer-reported active root (pnpm may switch activePath): healthz pid == record pid,
   serving identity root == active root, version == target. exit 0 requires applied && healthy;
   applied && !healthy → 12 error "runtime-unhealthy".
A6 Identity matching without guessing. Live process evidence: Linux /proc/<pid>/cmdline split on NUL
   (preserve boundaries); macOS executable via existing processIdentity (comm=) plus `ps -ww -o command=`
   string; Windows Win32_Process ExecutablePath + CommandLine via the existing bounded reader. A census
   record (serving-runtimes.json, relaunch prefix = record.command, live command = prefix + "start …")
   matches only if realpath(executable) == realpath(command[0]) and the live args begin with the record's
   remaining prefix (Linux: element-wise; macOS/Windows: the prefix rendered unquoted and quoted must be a
   whole-token prefix of the string). Exactly one matching record with version == healthz version is
   required; zero or several → serving-install-unknown. servingRoot derives from the matched record
   (exe for standalone; <root> of <root>/src/cli/index.ts). Tests: spaces, symlinks, Windows quoting,
   standalone, ambiguous duplicates.
A7 One stdout owner. Node launcher driver (npm/pnpm apply) and the Bun handler (plan, other apply) own
   stdout from entry to exit: progress → stderr, every failure path (Bun missing, plan-child non-zero /
   malformed / >64 KiB, spawn failure, signal, uncaught error) prints exactly one JSON document. Before
   mutation → plan "plan-unavailable" (exit 0) or result exit 10; after the update child started → 12.
   Tests run the real launcher subprocess against a temp npm-shaped package and fake npm/pnpm on PATH,
   plus desktop standalone (installer desktop-app). version-skew notice already skips --json.
Also: update all structure owners touched (launcher: codex-cli-update.md, ops/desktop-supervision.md;
CLI and update owners per structure/INDEX.md); PR gets ci:full (subprocess/read-as-data coverage);
core–Lab boundary unaffected (lazy imports only). New additive reason code "plan-unavailable" sent to L3.


## Audit r2 folds (supersede the matching A-items above where they conflict)

B1 (A1) Capability discovery reflects the CLI that handles update. `update` is already excluded from
   Desktop handoff (src/lib/desktop-cli-handoff.mjs:9); add `capabilities` invoked with --contracts to the
   same exclusion so a package launcher answers for itself and never hands off to an older bundled CLI.
   The desktop terminal shim (~/.opencodex-desktop/bin/ocx) runs the bundled CLI directly, which then
   answers for itself (and plans desktop-app). root.ts skips shim auto-repair for `capabilities`.
   Tests: handoff record present + `capabilities --contracts --json` stays local; update stays local.
B2 (A2) Pre-mutation check sits at the first mutation choke point, BEFORE tray handoff
   (src/update/index.ts:524 region, bin/ocx.mjs:759 region): re-verify home, cliRoot, servingRoot and
   live runtime pid against --orchestrated-expect; on mismatch write outcome phase "refused" and exit
   without touching tray/runtime/package. The second check is post-stop, before replacement: home and
   cliRoot unchanged and runtime liveness proven dead (the existing replacementLiveness === "dead"
   gate); the original pid is expected to be gone.
B3 (A3) A valid record whose pid is dead counts as unknown (serving-install-unknown) even if the endpoint
   is dead. Conservative by design; documented with remedy "run ocx start or ocx stop to settle state".
B4 (A5/A7) Outcome by phase, with independent verification. The child writes --orchestrated-result
   atomically: {phase:"preflight"} at entry (write failure → exit before mutation); {phase:"mutating"}
   immediately before the first tray/runtime/package mutation (write failure → abort before it);
   final {phase:"installed", activeRoot} or {phase:"failed", installerRolledBack:boolean}.
   Parent precedence (also on catchable signals SIGINT/SIGTERM/SIGHUP; SIGKILL has no guarantee):
   - plan refused → 10.
   - outcome missing/unreadable → 12 (cannot prove no mutation).
   - last phase preflight or refused, child non-zero → 10 (no mutation), error carries the cause.
   - phase mutating/failed → independent verification of the install root the plan named (pnpm: the
     owner-resolved active path): package.json version == fromVersion AND bounded `<root>/bin/ocx.mjs
     --version` (standalone: exe --version) == fromVersion AND, when a runtime was live before, a live
     runtime bound to the same home/root (B5) → 11; rolledBack = installerRolledBack && verified;
     otherwise 12.
   - phase installed, child exit 0 → verify activeRoot version + launcher probe == target; runtime readback
     (B5) when restartRequired → 0 applied=true healthy=true; any verification miss → 12 (applied reflects
     the install verification, error "runtime-unhealthy" or "install-unverified").
B5 (A6) Serving identity is self-reported, argument-preserving. The runtime writes
   command: currentServingCommand() (absolute relaunch prefix, src/config/serving-runtimes.ts:50) into
   runtime-port.json next to pid/port (validators ignore unknown fields, so old readers are unaffected).
   Live runtime = record.pid == /healthz pid on the record endpoint; servingRoot derives from
   record.command (standalone exe → exe; [bun, <root>/src/cli/index.ts] → <root>). No ps/CommandLine
   parsing is used to PROVE identity. Without record.command (older runtime): if the live process's
   executable (processIdentity comm= on macOS, /proc exe on Linux, Win32 ExecutablePath) realpath differs
   from this CLI's own runtime executable → cli-not-serving-install (refusal is the safe direction; a pid
   race can only cause a false refusal); otherwise serving-install-unknown. Census matching is dropped.
   lidge (2.83.0 runtime, no record.command, different bun) → cli-not-serving-install or
   serving-install-unknown; both refuse without touching the npm install.
B6 (A7) Single stdout owner: orchestrated update/capabilities never take Desktop handoff (B1), so the
   package launcher (npm/pnpm apply driver) or the Bun handler owns stdout from entry to exit.


## Audit r3 folds (supersede B4/B5 where they conflict)

C1 Attested serving identity. Live runtime = the record listener proves possession of the record's
   attestationSecret via the existing proveLiveProxyOwnedByHome / attestFencedIdentity path
   (src/server/proxy-liveness.ts:204) — only "proven" counts; "refuted"/"indeterminate" → unknown.
   The record is read before and after the proof and must be byte-identical (pid, port, hostname, secret,
   command); servingRoot derives from that record's command. The same attested check is re-run under
   the mutation lease before tray handoff. The Node lane cannot run the TS proof in-process, so it calls a
   passive Bun probe subprocess (hidden `__update-orchestrated-identity`, same pattern as
   `__update-home-probe`/service-home-probe-entry.ts, bin/ocx.mjs:150) that exits before any mutation.
   Tests: stale record + reused pid (proof refuted), record replaced during the probe, no secret.
C2 No launcher execution for verification. Version/tree verification is passive file reads in-process
   (readPackageManifestVersionAt / packageManifestPathIn, src/lib/package-tree-integrity.ts:87/129); no
   `--version` subprocess, no Desktop handoff, no backup restore, no Bun install.
C3 Active-tree verification uses installer-specific evidence before exit 11 or 0: npm — required package
   files present (package.json, bin/ocx.mjs, src/cli/index.ts, bundled bun dir) + no leftover transactional
   backup sibling for that root (read-only check of the transactional-install naming); pnpm — read-only
   owner re-resolution (resolvePnpmGlobalOwner / readPnpmGlobalPackage) confirms the active group path,
   its manifest version and the launcher shim target; bun global — required files + manifest. Any miss →
   12. Test: damaged tree that keeps package.json version → 12.
C4 Signals: on SIGINT/SIGTERM/SIGHUP the parent forwards the signal to the child, waits for confirmed child
   exit (bounded 60 s), then reads the final atomic outcome; child still running or outcome uncertain → 12.
   Deterministic test: signal delivered at the preflight→mutating transition.
C5 Exit classification (final):
   0  — applied and verified (installed + tree + runtime when restartRequired), or plan reason "up-to-date".
   10 — a plan refusal: the parent's plan reason (any reason except up-to-date), or the child's
        lease-time identity re-check refusing (phase "refused") — the plan recomputed at the boundary.
   11 — the update failed and the previous version is verified active (C3) with the runtime restored when it
        was live; covers preflight failures (child exited before "mutating") and installer rollbacks.
        rolledBack=true only when the installer reported a rollback AND C3 verification passed.
   12 — everything else: outcome missing/garbled, verification miss, unconfirmed child termination,
        installed-but-runtime-unhealthy.
   64 — usage.


## Audit r4 residuals (NEAR-PASS) — folded as implementation requirements
D1 npm success retains a backup sibling by design (transactional-install.mjs:535): a retained backup is
   not failure; verify the active tree itself.
D2 Tree verification reuses/matches the installer verifier (transactional-install.mjs:107: Bun executable
   present and complete, dependencies, launcher, source) — tests: truncated/missing Bun, missing dependency,
   missing source file → 12.
D3 pnpm rolledBack flag can mean "previous package simply remained active" (pnpm-global-install.mjs:544):
   result.rolledBack=true only for an actual rollback action; unchanged-active is rolledBack=false (exit 11
   when verified).


## L3 additive requests (accepted 2026-11-02)
E1 plan JSON adds "planToken": base64url sha256 (43 chars, matches ^[A-Za-z0-9_-]{16,128}$) over a canonical
   JSON of {currentVersion, targetVersion, installer, cliRoot, servingRoot, runtimeOwner, runtime:{pid, port,
   hostname, command} | null} — never the attestation secret. Apply accepts --expect-plan <token>; it
   recomputes its plan and, if the token differs, exits 10 before any mutation (error "plan-changed").
   The child's lease-time identity re-check compares against the same bound fields.
E2 plan JSON adds "updateInFlight": boolean. true when the update ownership/mutation lease is held by a live
   process, or the home-scoped orchestrated marker (<home>/update-orchestrated.json {pid, phase, startedAt},
   written by the apply child at preflight/mutating and cleared/finalized at the end) shows phase
   preflight|mutating with a live pid; true when this cannot be determined (fail closed); false only on
   positive evidence. Read-only probe (no lease acquisition that could block a real update).


## L3 additive request E3 (accepted 2026-11-02): deadline fencing
E3 apply accepts --not-after <unix-ms> (positive safe integer; invalid → 64). At the B2 choke point (before the first
   tray/runtime/package mutation) and immediately before writing the "mutating" marker, now > notAfter → exit 10
   error "deadline-passed", nothing touched. Contract constant ORCHESTRATED_MUTATION_BOUND_MS = 900000 (15 min);
   plan JSON adds "mutationBoundMs": 900000. A child that started mutating arms a watchdog at notAfter + bound
   (or start + bound without --not-after): on expiry it records outcome/marker phase "overrun" (→ parent 12) but
   does NOT kill an in-progress package transaction (a mid-swap abort is the unsafe direction); while that child
   lives, updateInFlight stays true, so updateInFlight=false remains the authoritative "no further mutation" fence.


## L3 requests E4/E5 (accepted 2026-11-02)
E4 Deadline↔visibility ordering (contract wording): the apply child (1) acquires the update ownership lease,
   (2) publishes marker phase "mutating" with its pid, THEN (3) performs the final --not-after, --expect-plan and
   attested identity checks; on failure it rewrites the marker to "refused", releases the lease and exits 10.
   Thus at the last deadline check updateInFlight is already observably true, and lease + marker stay held
   until no further mutation can occur (final outcome written before the lease is released).
E5 sync↔update exclusion (L1 implements; L2 rebases onto it): `ocx sync` (all variants incl. --local-only and the
   Child-side --expect-link run) first runs the read-only update-in-flight probe (same as plan.updateInFlight);
   in flight or undeterminable → no changes, stderr code "update-in-flight", exit 7. Placed at the sync command
   entry before any local sync, expectation check or fan-out.


## L3 request E6 (accepted 2026-11-02): atomic sync↔update exclusion (supersedes E5's probe-only guard)
E6 One dedicated cross-process mutex shared by `ocx sync` and orchestrated apply: same primitive as the ownership
   mutation lease (src/service/ownership-mutation-lease.mjs, dead-owner recovery, non-blocking try-acquire) but a
   separate lease file in the home, recording holder kind (sync|update) and pid — kept separate from the ownership
   lease so sync's own start/stop/restart paths cannot deadlock against it.
   - `ocx sync` (every variant) try-acquires it before its first mutation and holds it to the end; held by an update
     or undeterminable → no changes, stderr "update-in-flight", exit 7.
   - Apply child step ① try-acquires it (then the ownership lease, then marker "mutating", then E4 checks); held by
     sync → exit 10 error "sync-in-progress", nothing touched; held by another update → exit 10 "update-in-flight".
     Held until the final outcome is written.
   - updateInFlight = true iff an update holds the mutex or the update ownership lease, or the marker shows
     preflight|mutating with a live pid, or undeterminable. Sync holding alone → false.
   - Each machine has its own mutex; a Home fan-out's Child-side `ocx sync` takes the Child's mutex.
   Tests: sync holds (paused) → apply 10 sync-in-progress untouched; apply holds → sync 7; dead holder recovered.


## Implementation resolutions (2026-11-02, after slice 3)
F1 The existing lanes release the ownership lease around service-manager restarts (#5760; src/update/index.ts:626,
   bin/ocx.mjs:1043) — keep that. E4's "held until no further mutation" is carried by the dedicated sync/update mutex
   (E6) and the marker, which the apply child holds from step ① until its final outcome is written, across the whole
   lane including service restart/recovery. `ocx start` never takes that mutex, so no deadlock.
F2 The synchronous npm transaction blocks the child's event loop, so the overrun watchdog runs in the PARENT driver:
   at notAfter+bound (or start+bound) with the child still alive, the parent emits result exit 12 error "overrun" and
   exits without killing the child; the child's marker stays preflight|mutating with a live pid, so updateInFlight
   stays true until the child finishes (supersedes E3's "child records overrun").

## Review r3 resolutions (2026-11-02)
G1 Admission refuses when plan.updateInFlight is true (exit 10 "update-in-flight"); the child, after acquiring the mutex,
   re-reads the marker and proceeds only if it is positively free (finalized or absent); otherwise refused, marker untouched.
G2 Legacy `ocx update` (both lanes, interactive and package-only workers) also takes the sync/update mutex as "update" for
   its full mutation lifetime and publishes the marker; held by sync → refuse before any mutation with a clear message.
G3 Fail-closed fence by time bound: publish the mutating marker with fenceUntil = startedAt + 900000 before launching an
   installer. A dead worker, timeout, killed group, or unconfirmed exit retains the fence; live or uninspectable recorded
   installers remain active independently. A normally exited installer with its POSIX process group confirmed gone or
   Windows Job Object confirmed empty clears the fence on finalization. A POSIX descendant that escapes the group can
   outlive a normally exiting installer and mutate after the fence clears; this residual is accepted. Windows uses the
   Job Object supervisor. A timed-out escaped POSIX descendant can also outlive the 15-minute bound.

## Review r8 resolution
The sync launcher atomically publishes the spawned child PID in its lease. Reclamation requires both holder and delegate to be dead; a new Bun child verifies its own PID before mutation. An older Desktop CLI cannot verify it, so launcher SIGKILL between spawn and delegate publication leaves a residual window in which that child can outlive the stale lease.

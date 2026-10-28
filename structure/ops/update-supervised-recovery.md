# Update Supervised Recovery

How `ocx update` and the dashboard update worker hand a managed proxy back to its service manager
when the post-update service refresh does not (#7043). The lease rules and the refresh itself are owned by
[Background Service And Sidecars](service-and-sidecars.md); this page owns only what happens after
that refresh fails or leaves a non-viable manager.

## Manager first

For matching service homes, both `ocx update` lanes, the npm launcher in `bin/ocx.mjs` and the Bun updater in
`src/update/index.ts`, ask the manager to restart the job it already holds before any detached
start, through the plain synchronous ESM in `src/update/supervised-recovery.mjs`: launchd with
`launchctl kickstart -k gui/<uid>/com.opencodex.proxy`, the systemd user manager with
`systemctl --user restart opencodex-proxy`. The call runs unleased, like the refresh, because the
manager's child cannot join the update lease (#5760). Other platforms have no such manager here
and go straight to the fallback below.

A restart counts as recovery only when the serving runtime record answers on the captured port and
its PID is the manager's main PID (`launchctl print` `pid =`, systemd `MainPID`) or that PID's
direct child: the job execs the Node launcher, which runs the Bun proxy as its child. Anything else
is a failure with a stated reason, never an exception.
A record that still names the pre-restart process is ignored, so an old proxy answering during
shutdown cannot pass as the restarted one.

A restart whose client times out is `unsettled`: the manager's queued job can still complete, so
the lanes keep polling until the recovery deadline and, if supervision is still unproven, start no
competing proxy, print that the manager is still restarting, and exit non-zero. Failed-update
recovery in `src/update/index.ts` re-plans ownership after the unleased refresh and restarts the
manager's job only when that plan still names the service.

## The unsupervised fallback

When the manager cannot prove supervision, the lanes fall back to the existing detached direct
start so the user is not left without a proxy. That outcome is never reported as full recovery:
the updater prints an UNSUPERVISED warning that names the port and `ocx service repair`, and the
update exits non-zero. Failed-update recovery of a managed install in `src/update/index.ts` asks
the manager the same way before its direct fallback; that path already exits non-zero.
An ownership veto at the direct start (Desktop or another owner claimed the runtime meanwhile) is
the correct outcome and is not reported as unsupervised.
Home-authority refusal is a separate `refused` outcome: both launchers print static service-status
guidance, start no proxy, and fail the successful-update fallback with a non-zero exit. The Bun
fallback preserves that outcome rather than treating it as an ownership veto. Direct recovery
callers also preserve these outcomes when a service disappears: `true` and ordinary `vetoed`
complete foreground recovery successfully; `false` and `refused` fail. A managed fallback that
actually starts remains UNSUPERVISED and fails. The Node foreground caller explicitly fails a
home check after shim or tray work rather than falling through to success.
Direct recovery checks homes after lease acquisition and again after ownership inspection; service repair checks
homes and service permission in its caller after the last awaited ownership or recovery plan.

## Service home authority

`src/update/mutation-guard.mjs` supplies the synchronous `authorizeMutation(kind)` attached
to each update home policy. Its guarded primitive adapters first recursively copy every argument
into inert data: arrays by index, and own enumerable object properties read once into fresh
null-prototype records, discarding inherited properties (including Node's special env prototype).
Accessors and Proxy traps run during this copy. Cycles and functions in data are rejected.
The adapter then invokes the same latched synchronous gate
and dispatches the primitive with only those copies, without an await or preparation in between.
Node, Bun and the dashboard worker use this boundary for runtime, service, tray, shim, package
mutations and terminal success publication. `guardedRun` accepts only a trusted primitive adapter
that consumes its materialized argument list; orchestration closures are not operations.
`guardedExecFile` alone permits its documented final completion callback, which the native API
invokes on a later event. Synchronous updater/report callbacks run before their guarded leaves.
`src/update/guarded-runtime-ops.ts` owns Bun runtime state, PID, TCP and service-stop adapters;
`src/update/guarded-tray-ops.ts` owns the dynamically loaded Windows tray adapters.
The worker prepares its latest stored job snapshot, directory and serialized payload before
the success-write adapter in `src/update/job.ts`; publishing `succeeded` without an authorizer
refuses even when reached through an ordinary job-store helper.
The adapter carries the same synchronous gate through the atomic writer's
`validateBeforeRename` hook, after temp preparation and before every native rename attempt,
including Windows retries. Runtime PID termination similarly authorizes each actual signal:
the POSIX grace wait cannot lend its earlier SIGTERM authority to a later SIGKILL.
Port reclaim passes its sticky gate into the termination ladder after identity preparation
and into TCP reclamation. Both Bun updater entrypoints use the update-owned
`src/update/guarded-port-reclaim.ts` adapter, which requires a synchronous gate and refuses
an omitted or invalid gate before shared reclaim I/O. Ordinary non-update reclaim callers
retain the shared helper's defaults. `tests/update/update-reclaim-authorizer.test.ts` covers
omission, invalid gates, denial and the stable available-port result.
Each prepared native TCP row is authorized immediately before
SetTcpEntry, after FFI loading, netstat inspection and pointer preparation. Availability
success also requires the gate to remain open. PID/runtime records and registry pointers
check after path preparation; WinSW, scheduler, scoped wrapper and tray stops carry their
gate through command preparation to dispatch. Optional leaf hooks preserve ordinary callers.
Each call obtains a fresh home observation; a refusal or throwing observation closes the
attempt permanently, including package replacement and success after a transient re-match.
Service calls additionally require `serviceAllowed`. Confirmed disappearance skips service
control while retaining authorized foreground cleanup. `package-publish` uses the package
policy and grants no runtime authority to a restricted update.

The two cleanup kinds complete only an operation already attempted: `own-child` retires the
exact still-live pinned-start ChildProcess, and `own-tray` restores only the own tray recorded
running before this update stopped it. They remain available after home refusal, never install
or refresh a tray, and never discover another runtime or service target. Transaction staging
and bounded rollback remain package-local; the Node transaction rechecks the original policy
after staging through its synchronous replacement callback before touching the live tree.

The production tray handoff checks after its module import and immediately before stopping.
Shim completion and tray installation are distinct boundaries, as are a blocking PID kill and
the next wrapper stop. Cold updates and workers without restart recheck after their final
control command before publishing success. The manager helper returns `vetoed` for an ordinary
ownership change under still-authorized homes; that skips recovery successfully. `refused`
is a home failure and an actually started unsupervised fallback remains a failure.
`src/update/job-pinned-start.ts` performs pinned-start I/O and checks after log setup, just
before spawning. Its caller passes the same latched authorizer.
`src/update/job-windows-restart.ts` receives that same authorizer at all worker call
sites. It rechecks service permission after backend observation, before each backend
stop and after the blocking stop or its catch path before wrapper termination. Path
setup precedes a final service check at the scoped scheduler-wrapper killer.

The Node launcher, Bun updater and dashboard worker use the same transition policy in
`src/update/service-home-policy.mjs`. Their direct recovery helpers reacquire the ownership
lease themselves and recheck both home authority and runtime ownership before spawning, including
on failed-update recovery. Matching-home service refresh runs unleased; home/owner evidence is
checked again immediately before manager recovery. A distinct refusal never permits direct fallback.
If direct recovery cannot reacquire the ownership lease, both CLI lanes return failure with static
manual repair/start guidance, without inspecting owners or starting another proxy.
An initially unknown service home selects a package-only transaction: no proxy/tray stop, service
refresh, shim repair or direct start. Success prints the static refusal and manual restart guidance;
the dashboard records success with `restarted: false`. Package replacement still requires stable
durable ownership, no Desktop veto and a dead package runtime. Home evidence is rechecked before
replacement; changed authority refuses the transaction. Initial uncertainty never grants recovery
permission later, even if installing the package repairs its probe. Unresolved pending teardown
receipts, including quarantined unreadable receipts, also block package-only replacement.
Full proxy stop in both CLI lanes requires current service permission when the attempt captured
a service; a disappearing registration refuses with manual status guidance before sending stop.
Service refresh rechecks home after ownership inspection, including Bun's awaited read, before
returning an ownership veto. Home refusal remains failure; an authorized ownership veto is success.
The final CLI fallback veto and worker entry/reacquisition veto apply the same refusal precedence.
The npm transaction in `src/update/transactional-install.mjs` checks its synchronous
`mayReplacePackage` callback after staging and verification, before any live rename. The Node
launcher supplies fresh baseline-home, durable-owner, supervision and dead-liveness checks for
both synchronous and asynchronous installers. Refusal discards only this attempt's exited stage,
returns the untouched `authorize` failure phase and retains the old usable launcher. Rollback
after a swap begins remains bounded transaction cleanup. The dashboard's npm path delegates to
this guarded launcher; the Bun raw installer path is synchronous and has no awaited swap boundary.
The worker passes its restriction as `--update-package-only`; package-only-capable launchers preserve it
in both Node and Bun update paths even when their own probe matches. A package-only Bun worker
uses that guarded launcher instead of its ordinary raw package-manager command. Delegated launchers
also receive `--update-worker-home` plus `--update-worker-result`: the flag pins the worker's verified
initial home authority — all four kinds, unknown included — as the child's baseline in place of a
fresh inspection, so a service registered or removed between the worker's check and the child's run
cannot mint authority the worker never held, and a malformed or duplicated baseline fails closed
rather than falling back to inspection. A stable unknown baseline still permits the package-only
replacement. Successful package-only transactions report exit 75 instead of ordinary success. The
worker handles this restricted-success result before any tray refresh or restart, even when its own
probe still matches. Unmarked package-manager exit 75 is a failure. The raw package-manager lane
cannot carry baseline argv, so the worker rechecks home authority at the replacement boundary itself,
after the own-foreground tray handoff and before the command runs; on refusal the only side effect
is restoring that stopped tray, and on a post-replacement refusal the same restore is the only tray
action — the check runs before any shim, tray install or service refresh, never after.
Both CLI lanes restore that stopped tray only through a verified, still-present package launcher;
a tray that was not running receives no cleanup command, and refusal never installs or refreshes it.
The dashboard also carries its original home baseline into `finishGuiUpdateRestart` and the actual
restart policy through `RestartIo`, retaining it across lease acquisition and asynchronous health
checks. A registration appearing after initial absence, or a changed foreign subject, cannot become
new recovery authority. Standalone restart calls without a delegated baseline inspect their own.

The dashboard worker checks the unchanged v1 `src/update/service-home-protocol.json` plus the v2
`src/update/service-home-package-only-protocol.json`, then the delegated launcher's exact private
`__update-package-only-probe` response. The version bump fails closed in both directions: an old
worker refuses a v2 launcher whose flag it would ignore, and a v2 worker refuses a v1 launcher that
cannot enforce a pinned baseline. This separate capability probe performs no Bun resolution
or home inspection. Missing declarations, failed calls and malformed responses refuse delegation.
Keeping the original home-probe declaration and response at v1 lets already-running v1 updaters
inspect and recover after installing the new package. `src/update/job-update-home.ts` owns the
capability gate. Markers claim compatibility of trusted installed files, not tamper attestation.

The new Node launcher intercepts this exact private command before Desktop handoff, boot restore
and ordinary install-capable Bun resolution. It resolves Bun and its compatibility floor from the
actual probe target's package with installation disabled, then uses
`--no-env-file` with `src/update/service-home-probe-entry.ts`, which imports the authoritative
inspector rather than the CLI root/status collector. No full status fallback exists. Probes have
an eight-second timeout and 4 KiB output ceiling; errors, unsupported versions and malformed JSON
are unknown. Explicit home snapshots preserve the SQLite-home resolver and user/auth environment;
only internal launcher, service, restart-child, sibling and delegation tokens are removed.
Missing Bun in this probe returns unknown rather than exiting its caller; ordinary launcher
resolution keeps its installation and terminal failure behavior. Nested probe deadlines can refuse
a valid installation during slow cold starts; the bounds are not a readiness guarantee.
Successful updates recover a foreground runtime only when this update attempted its stop. A cold
CLI update without prior runtime state stays stopped and prints the existing manual-start guidance.

An already-running old Node parent keeps its old implementation after package replacement; these
checks cannot retrofit it. Automatic delegation requires the guarded launcher already present.
Existing stop authorization remains unchanged: stable foreign foreground recovery applies only
when that runtime's own stop/update is permitted and succeeds, not to every cross-home combination.

## The dashboard update worker

`src/update/service-home-authority.ts` distinguishes matching service homes, a known foreign
registration, unknown evidence and confirmed absence. It combines service-state resolution with
the unattended native ownership inspector and the lifecycle SQLite-home comparison; physical
directory aliases remain equivalent. A changing state read is unknown. The inspector's `owned`
result alone does not establish a registration, because it also includes confirmed absence.

The dashboard worker permits service repair, manager restart and global Windows service stops
only for a matching home. Stable foreign registration and confirmed absence retain the captured
foreground runtime's existing PID/port and lease checks for direct recovery, without touching
the other registration or reporting that foreground runtime as UNSUPERVISED. Unknown evidence
refuses automatic restart. A matching home that becomes foreign or unknown after the unleased
refresh refuses both manager recovery and direct fallback. A foreign record must remain the same
observed subject for foreground recovery. Refusals persist static manual-status guidance in the
terminal error, including authority changes after installation, never recorded paths or probe output.
Package-only command displays retain the Node launcher shape with a `<path>` placeholder before
persistence; the executable and argument array retain the actual launcher path, including spaces.

Home authority is checked before initial reclaim, after releasing the repair lease, before manager
recovery, after direct-fallback lease reacquisition and at pinned-start preparation/send boundaries.
Pinned-start preparation and both ghost-listener waits share reclaim's latched authority gate.
Preparation rechecks before wrapper cleanup, each PID kill, PID/runtime-state removal and TCP-row
deletion; the waits recheck before each TCP-row deletion. A denial immediately returns the existing
restart refusal, including after a transient re-match; void-returning preparation overrides remain valid.
The manager helper checks independently after lease release, immediately before contacting the
manager, and returns distinct `refused` for foreign or unknown homes; callers cannot treat this as
an ordinary failed restart. `src/update/job-windows-restart.ts` owns scoped Windows
wrapper cleanup under the same latched service guard. Pinned direct recovery receives global service-stop authority only for a matching
managed home; foreground recovery does not acquire that authority.
The preparation callback tests the current `serviceAllowed` after preparation's fresh mutation
gate: a matching registration disappearing still allows foreground PID/port cleanup, while
skipping the global wrapper stop selected before that read.

For a matching managed home, the dashboard restart worker in `src/update/job.ts` follows the same order through
`src/update/job-supervised-restart.ts`, which sits beside it because `job.ts` is at the repository
size cap, and `src/update/job-update-tray.ts` owns the production own-foreground tray handoff for
the same reason. The helper publishes its pre-stop plan to the worker before stopping; if post-stop
status and immediate native restore both fail, the worker retains the original running state and
retries only `tray start` through its verified launcher. A failed handoff never permits package
replacement, and a failed cleanup retains the handoff error. When a service-managed install's refresh fails, is not viable, or never serves, the
worker asks the manager to restart its job before it re-acquires the lease for a direct start,
using the same helpers and the same manager-PID-against-serving-PID proof. A proven supervised
restart skips the direct start. An unsettled restart starts no competing proxy and fails the job.
The manager step releases the update lease itself once a manager is present, because the worker
reaches it without a release when it skipped the repair after a port-reclaim timeout.
Otherwise the pinned direct start runs as before, and when that proxy comes up healthy the job
still ends `failed` with `restarted: false`, an error naming UNSUPERVISED, and the warning in its
log. Installs without a service are unchanged: the direct start is their normal recovery.
Every exit after a failed manager attempt carries that outcome, including a live holder the worker
refused to replace and a listener already serving the target version, because neither proves the
manager owns the proxy.
The job store withholds multi-line text, so the worker joins the shared warnings into one line.

An armed test process (`OCX_TEST_HOME_GUARD=1`) never reaches the live manager: the default runner
refuses, matching `assertLiveServiceManagerAllowed` in the service layer.

## Coverage

`tests/update/update-mutation-boundaries.test.ts` executes production CLI and worker bodies
with injected module/process/store I/O for the import, shim, tray, PID-kill and manager-veto
boundaries, including stable controls. The runtime cases in
`tests/update/update-mutation-guard.test.ts` check the refusal latch, confirmed absence and
restricted publication. Runtime mutation guards are the security boundary for update effects
and fresh authorization.

The scanner and inventory cases are auxiliary best-effort regression lint over known patterns,
explicitly not a security boundary or a completeness proof. JavaScript acquisition forms and
transitive effects outside those patterns can escape this lint. A green scan does not establish
that all effects are guarded. `tests/helpers/update-mutation-scanner.ts` shares known patterns
with `tests/helpers/update-capability-policy.ts`; `tests/helpers/update-import-policy.ts` records
dependency/binding snapshots, and `tests/helpers/update-primitive-allowlist.ts` records exact
probe and cleanup exceptions. These snapshots confer no runtime authority.
The helper inventory scans update modules and the launcher's direct source imports using known
function/call/count patterns; detected unclassified sites fail the regression check. The launcher
resolver-body snapshot and `tests/update/update-capability-policy.test.ts` are likewise auxiliary.
These lint cases parse through TypeScript 7's sync client, which cannot start under Bun on POSIX
(`tests/helpers/update-lint-parser.ts`); there they are skipped, while every runtime guard case runs.
`tests/update/update-mutation-scanner.test.ts` rejects raw named-options, spread and member-read
mutants, native import aliases, Bun shell imports/references and tagged-template execution.
It also rejects direct worker/process and file-write primitives outside exact reviewed
private-artifact and read-probe exceptions. `tests/update/update-effect-authority.test.ts`
executes signal, TCP, service/tray and state-removal leaves with injected OS I/O.
`tests/update/update-guarded-ops.test.ts` exercises
getter, accessor, Proxy and function-bearing arguments at the runtime copy/gate boundary.
`tests/update/update-windows-wrapper-authority.test.ts` executes
the complete wrapper helper and worker restart bodies with injected external I/O for
stable, absent, unknown and foreign homes, including throwing backend and stop calls.

`tests/update/update-supervised-recovery.test.ts` pins the manager commands, the label and unit
against `src/service/state.ts`, the manager-PID-against-serving-PID verdict, the test guard, and
the Bun lane's ordering. `tests/update/update-desktop-owner.test.ts` drives the launcher lane: a
proven manager restart skips the detached start, and the fallback returns `unsupervised` for a
non-zero exit.
`tests/update/update-job-supervised-restart.test.ts` drives the dashboard worker: the proof
against stale and foreign records, a supervised restart skipping the direct start, an unsettled
restart failing the job, and a healthy direct fallback failing it as UNSUPERVISED.
`tests/update/update-service-home.test.ts` covers real two-home records, stable foreign foreground
recovery, unknown evidence, aliases, SQLite homes, state changes, post-release refusal, pinned-start
service-stop authority and matching-home recovery. Manager, probe and process side effects are injected.
`tests/update/update-service-home-policy.test.ts` covers schema/capability validation and transition
semantics; `tests/update/update-home-launcher.test.ts` and `tests/update/update-home-recovery.test.ts`
exercise the actual Node/Bun helper bodies with injected lease, manager, owner and spawn boundaries.
`tests/update/update-recovery-authority.test.ts` executes the production pinned-preparation body,
both ghost-wait call paths and CLI lease refusals with injected OS I/O, including home changes
at preparation mutation boundaries, mid-wait changes and latched transient denials.
The launcher suite also runs the complete Node update function in an isolated Node child with
replacement/control I/O intercepted; `tests/update/update-bun-ownership-lease.test.ts` runs the actual
Bun updater child. Both enforce the delegated baseline before replacement, retain stable-unknown
package-only success, and reject malformed baselines. The Bun child also rejects a changed
post-replacement home before shim/tray/service commands. `tests/update/update-home-worker.test.ts`
executes tray handoff and command injection on every platform, covering both a previously running
and a stopped tray so refusal can restore only the former, without install or refresh.
The worker suite changes absent/foreign authority under the restart lease, after the worker's last
check, and reaches the real recovery policy with no service repair or direct start permitted.
The Node child and executable Bun refusal body also cover stopped/unverified tray cleanup.
`tests/update/update-tray-handoff.test.ts` also drives the default Windows worker path in isolated
children with native tray I/O mocked: running, idle, absent, missing initial evidence, and post-stop
status plus native-restore failures, including a launcher cleanup failure. No handoff override is used.

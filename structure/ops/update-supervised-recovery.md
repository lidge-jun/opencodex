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

## Service home authority

The Node launcher, Bun updater and dashboard worker use the same transition policy in
`src/update/service-home-policy.mjs`. Their direct recovery helpers reacquire the ownership
lease themselves and recheck both home authority and runtime ownership before spawning, including
on failed-update recovery. Matching-home service refresh runs unleased; home/owner evidence is
checked again immediately before manager recovery. A distinct refusal never permits direct fallback.
An initially unknown service home selects a package-only transaction: no proxy/tray stop, service
refresh, shim repair or direct start. Success prints the static refusal and manual restart guidance;
the dashboard records success with `restarted: false`. Package replacement still requires stable
durable ownership, no Desktop veto and a dead package runtime. Home evidence is rechecked before
replacement; changed authority refuses the transaction. Initial uncertainty never grants recovery
permission later, even if installing the package repairs its probe. Unresolved pending teardown
receipts, including quarantined unreadable receipts, also block package-only replacement.
The worker passes its restriction as `--update-package-only`; package-only-capable launchers preserve it
in both Node and Bun update paths even when their own probe matches. A package-only Bun worker
uses that guarded launcher instead of its ordinary raw package-manager command. Delegated launchers
also receive `--update-worker-result`: successful package-only transactions report exit 75 instead
of ordinary success. The worker handles this restricted-success result before any tray refresh or
restart, even when its own probe still matches. Unmarked package-manager exit 75 is a failure.

The dashboard worker checks the unchanged v1 `src/update/service-home-protocol.json` plus
`src/update/service-home-package-only-protocol.json`, then the delegated launcher's exact private
`__update-package-only-probe` response. This separate capability probe performs no Bun resolution
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
observed subject for foreground recovery. Refusals persist static manual-status guidance, never
recorded paths or probe output.

Home authority is checked before initial reclaim, after releasing the repair lease, before manager
recovery, after direct-fallback lease reacquisition and at pinned-start preparation/send boundaries.
The manager helper checks independently after lease release, immediately before contacting the
manager, and returns distinct `refused` for foreign or unknown homes; callers cannot treat this as
an ordinary failed restart. `src/update/job-windows-restart.ts` owns the unchanged scoped Windows
wrapper cleanup. Pinned direct recovery receives global service-stop authority only for a matching
managed home; foreground recovery does not acquire that authority.

For a matching managed home, the dashboard restart worker in `src/update/job.ts` follows the same order through
`src/update/job-supervised-restart.ts`, which sits beside it because `job.ts` is at the repository
size cap. When a service-managed install's refresh fails, is not viable, or never serves, the
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

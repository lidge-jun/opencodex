# Update Supervised Recovery

How `ocx update` and the dashboard update worker hand a managed proxy back to its service manager
when the post-update service refresh does not (#7043). The lease rules and the refresh itself are owned by
[Background Service And Sidecars](service-and-sidecars.md); this page owns only what happens after
that refresh fails or leaves a non-viable manager.

## Manager first

Both `ocx update` lanes, the npm launcher in `bin/ocx.mjs` and the Bun updater in
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

## The dashboard update worker

The dashboard restart worker in `src/update/job.ts` follows the same order through
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

# ADR 0001: GUI self-update runs through a worker job

## Status

Accepted

## Context

The dashboard needs buttons for `ocx sync` and opencodex self-update. `ocx sync` is safe to run in
the proxy process because it refreshes Codex config/catalog state. `ocx update` is different: npm
installs may replace the package files currently serving the GUI, and the existing CLI update path
can print to inherited stdio and exit the process.

## Decision

GUI self-update is not executed directly in the request handler. The dashboard calls management
API endpoints that create an update job in `OPENCODEX_HOME/update-job.json`. The proxy starts a
detached hidden CLI worker, and the worker performs the install command and optional restart.

For npm installs, the worker runs the Node launcher path (`node bin/ocx.mjs update --tag <tag>`) so
the existing npm self-update guard is reused. For Bun global installs, it runs the existing Bun
global update command. The outer GUI installer command also runs through the shared process-tree
runner; a failed npm or Bun update is recoverable only when that runner confirms the installer tree
has exited. Source checkouts remain manual-only and show `git pull && bun install && bun run build:gui`.

Before an npm updater stops the proxy, it resolves the configured npm cache and checks that every
entry is owned by the current Unix user. A foreign-owned entry (commonly left by an older `sudo npm`
invocation) aborts the update with an actionable error while the existing proxy and service remain
running. The scan fails closed when the cache root is absent, an entry cannot be inspected, or its
50,000-entry / 10-second traversal budget is exhausted. Only the configured cache-root symlink is
canonicalized; nested cache symlinks are rejected fail-closed so a foreign-owned target cannot be
hidden behind one. The blocking filesystem walk runs in a child process so the parent can enforce
the deadline even when a filesystem call itself stalls.
Failure logs omit both cache and entry paths; users can locate the cache explicitly with
`npm config get cache`. Platforms without Unix uid ownership skip this gate.

The GUI worker retries its identity-checked pre-update liveness capture before deciding a service
was inactive. If health remains unavailable, a matching runtime-port record plus an identity-checked
live PID still preserves the pre-update activity evidence. If the installer exits nonzero, the worker
probes again immediately before recovery and leaves any old or concurrently replaced process alone
when health or PID identity proves it is OpenCodex. When npm already stopped the proxy and retired
the old package, the worker validates each candidate's trusted ownership, name, version, path
containment, and complete launcher runtime with a side-effect-free `--version` probe. On UID-capable
platforms, the scope and complete package tree must also reject foreign owners, group/world-writable
entries, and symlinks that leave the candidate tree before any code executes. Trusted npm-generated
links whose immediate and final targets remain inside the candidate tree are allowed. The tree walk
is bounded by entry count and elapsed time. Candidate inspection and restart are bounded to at most
two candidates, preferring the current package and then the newest retired copies, and it tries those runnable
candidates in order until one restores health. The recovery-tree walk runs in its own short-lived
worker, and the GUI worker force-kills that child at the wall-clock deadline even if one filesystem
call blocks. A recovery launcher is always started directly: it
may restore availability, but its potentially temporary path is never persisted into launchd,
systemd, Task Scheduler, or the update job log; the log stores only a path-free candidate label.
If a candidate starts but does not become healthy, the worker retains the detached child handle,
then requires both the same process generation and a fresh OpenCodex identity before stopping that
PID and trying the next candidate. An exited child or missing generation proof fails closed so PID
reuse can never terminate a concurrent replacement proxy.
Service and direct restart paths also stop when the pidfile has changed to a different identity-checked
proxy, and every such identity decision re-reads the process command line instead of trusting a
PID-only cache across the update boundary. The update job remains failed either way because restoring
availability is not the same as installing the new version.

The npm launcher and the Bun/source CLI installer paths run in an isolated process tree. On timeout,
the updater terminates and awaits the known POSIX process group or a Windows `taskkill /T /F` tree;
piped CLI output is drained and bounded before it is replayed. A POSIX process group is not an OS
containment boundary because a lifecycle child can leave it with `setsid` or `setpgid`. Therefore a
timeout, interruption, or nonzero POSIX root exit is always reported as unconfirmed even when the
known group was successfully stopped, and automatic recovery stays disabled. Once a POSIX root has
exited, the updater also refuses to signal its leaderless group by a reusable numeric PGID. While the
root is live, cleanup treats zombie-only groups as stopped and revalidates group membership and the
original leader immediately before each signal; uninspectable or replacement-led groups are refused.
Windows has no retained job-object handle after a normally failed installer root exits, so that case
likewise remains explicitly unconfirmed. The outer worker timeout remains longer than the nested deadline, and
recovery is skipped whenever either layer cannot prove installer-tree shutdown.

After an update requests a restart, the worker now waits for an identity-checked `/healthz` to
return and remain healthy for a short stability window before marking the job successful. This
keeps `update-job.json` honest on Windows cases where npm leaves the bundled Bun runtime in a bad
state and the restarted proxy dies a few seconds later.

For npm installs specifically, `node ocx.mjs update` already stops the proxy and reinstalls /
starts the managed service (or falls back to a direct start). When a background service was
installed, the worker therefore confirms that self-update restart first — but only skips the
redundant second `service install` when /healthz shows update-correlated evidence (a new PID
vs the pre-update capture, and/or the job's target version). A bare healthy identity is not
enough: a surviving pre-update process would otherwise look like success. Direct (non-service)
npm installs skip the probe-first path entirely, because the launcher only prints `ocx start`
and never brings the proxy back on its own — waiting would always burn the full health timeout
before the worker's explicit restart. A second install would call `stopWindows()` on the healthy
listener and often fail elevation from the non-interactive worker, leaving the captured port
(default 10100) dead until a manual restart. Bun global installs still always take the explicit
restart path because `bun add -g` does not restart the proxy.

## Consequences

- The GUI request handler stays responsive and does not overwrite its own running module graph.
- Update status survives a proxy restart because it is stored in the opencodex config directory.
- Restart handling can branch between service-managed installs and direct detached proxy starts.
- npm cache ownership failures are detected before service or proxy shutdown.
- Automatic recovery starts only when installer shutdown is confirmed; ambiguous POSIX failures and
  escaped descendants remain fail-closed with manual remediation.
- A failed install best-effort restores a previously-active proxy without claiming update success.
- A completed install can still finish with `status: "failed"` when the replacement proxy never
  becomes healthy or flaps during the stability window; the job log then points the user at
  `ocx start` and the Bun `--allow-scripts` reinstall path.
- The dashboard must poll both the job endpoint and `/healthz` while reconnecting.

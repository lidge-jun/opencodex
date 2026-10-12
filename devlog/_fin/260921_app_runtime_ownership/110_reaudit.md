# External re-audit of the lane branches

Two independent reviews read the pushed lane branches at fixed SHAs and reported on the same day
the lanes were opened. Both agree the direction is right and both refuse to call it shippable. The
distinction they draw is the one worth keeping: **"better than before" and "safe in the failure
path" are not the same verdict.**

What they credit as genuinely fixed: the Windows packaging shell, the checksum path, packaging
before publication, `.exe` process identity, the window being created before the runtime starts,
the removal of the direct `child.kill()`, the StatusNotifier probe, and the replacement of the
platform dialogs. Those are not re-listed as defects.

## P0 — the installed gate can destroy a real installation

`desktop/scripts/installed-gate.ts`. The preflight detects an existing service, an existing
state file in the default home, or a running app, and refuses to verify. But refusal only sets a
flag; the `finally` block then runs its cleanup unconditionally, killing processes matching the
app name and attempting a service and artifact uninstall — **including on Windows, where it can
reach the MSI removal path without the test ever having installed anything.**

So the very situation that makes the gate refuse is the situation in which it acts. A `return`
inside `try` does not help: `finally` still runs. The preflight has to complete outside the
block that owns destructive cleanup, or the cleanup has to be limited to the exact pids, service
registrations and install results this run recorded for itself.

Completion condition: **a run that refuses because it found an existing app, service or state
makes zero mutating calls, cleanup included.**

## The update path still does not drain first

The pinned updater's Windows install implementation ends in `process::exit(0)`. The lane calls
`download_and_install()` and only then asks the exit coordinator to restart, so on Windows that
second call is not reached. Removing the direct kill was real progress; it did not put the Windows
in-app update on the coordinated path.

The order has to be: download and verify the signature, re-confirm who owns the current runtime,
drain and confirm the child actually exited, **then** install. A failed drain must refuse the
install rather than proceed.

## A failed drain is still recorded as drained

The exit state machine logs a drain failure and then calls the same completion path, so both a
successful and a failed drain end in the exiting or restarting branch. For a user pressing Quit
that is a defensible trade — better to leave a runtime than to refuse to close. **For a coordinated
restart it is not the same judgement.** A failed stop followed by a restart means the new app
re-attaches to the old runtime while the user believes they are on the new version.

`DrainFailed` and `OwnershipUnknown` need to be states the restart path refuses, separately from
what the quit path tolerates.

## Ownership is computed outside the lock it is written under

The writer resolves ownership **before** taking the lock, then takes the lock, reads the current
record, and preserves the ownership it read earlier. A revocation that lands in between is
overwritten by the stale value. The revision check does not prevent this: the read is fresh and the
value being written is not.

Two more in the same file: the state file is written in place rather than written and renamed, so
an interrupted write leaves half a document; and the lock is reclaimed on mtime alone, with no
holder identity, so a slow writer can delete a lock another process now owns.

A third, and it is a different question from the CAS: **the record API takes an owner and an install
id, which cannot express "is the generation the user consented to still the current one".** An
internal retry that succeeds against a newer record has silently applied the consent to a different
subject.

## Not stopping is not the same as safe to replace

When ownership is unknown the update path skips stopping the runtime and skips refreshing the
service — but still proceeds to replace the package. If the live process is running out of the
files being replaced, that is a file lock on Windows and a mixed on-disk version elsewhere.

Three decisions have to be separated: may the package be replaced, may the runtime be stopped, may
the service be restored. Unknown should block the first, not only the second and third.

## The old CLI on the user's machine is not retrofitted

The shipped 2.60.0 launcher calls the old `stop` before replacing the package whenever a service
or runtime record exists, and it knows nothing about an ownership field. So a user who takes
ownership in the app and then runs `ocx update` from the npm install on their `PATH` gets the
old teardown first. The protection added here is the new CLI's protection; it cannot reach backward.

Taking permanent ownership therefore has to check the managing CLI's compatibility first, and
either upgrade it with consent or withhold the takeover and say why.

## Smaller, each concrete

- The resolve verb uses the default probe budget, one attempt at 750ms, and reports a timeout as
  `not-found`. The start-ownership path uses 1500ms three times for exactly this reason. Alive,
  absent-proven and unknown need to be three answers, and unknown must not authorise a new runtime.
- The resolve verb passes through the CLI root's automatic shim restore, so a read-only lookup made
  to populate a consent screen can cause a repair side effect first.
- `if (await deps.handleStop())` still reads a now-object return as a boolean, so a failed stop
  prints the downtime warning.
- The dashboard's stop client maps every fetch exception to accepted. Accepted, rejected and unknown
  are different, and unknown needs a follow-up read rather than an assumption.
- A consent dialog can outlive its subject: the target can change or the surface unmount while it is
  open, and the request is then sent against the captured closure.
- The dialog guard skips template literals wholesale, so `${window.confirm("...")}` inside one is
  a real call it does not see.
- Attaching to a different proxy does not reset the ownership flag, so a retry that lands on a
  foreign runtime can still send an owner-only stop to it.
- Tray availability is recorded from the host probe before `tray::install` runs, and an install
  failure only logs. Host present, icon registered and currently reachable are three different
  facts.
- The startup deadline does not wrap the registration that runs before the resolver, and the
  existing-proxy budget is counted from process start, so registration can consume it.
- The Windows app origin is still not in the navigation allowlist.
- The local management client needs redirects refused and instance identity confirmed before the
  token is sent, not only the system proxy disabled.
- Publication still precedes checksum, signature and manifest validation, because that validation
  lives in the attach step that depends on publish. Packaging-before-publish closed a narrower gap
  than the one that remains.
- The gate driver and the ownership record disagree on schema, install the wrong package spec, and
  re-hardcode the macOS executable name that was removed once already. Its second-launch check
  observes single-instance behaviour rather than a real relaunch, and the deb update is only
  verified through cancellation, never through a successful install.

## The three sentences both reports converge on

**An unknown result is not turned into an absence or a success. The subject the user approved is
confirmed to be the subject being changed. An update begins only after the correct runtime is
confirmed stopped.**


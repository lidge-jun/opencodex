# Desktop recovery evidence

`src/cli/ensure-desktop-cold-start.ts` preserves a verified native Desktop recovery while its
proxy child is absent, independently of durable service ownership. The native producer lives
in `desktop/src-tauri/src/recovery.rs` and `desktop/src-tauri/src/recovery_presence.rs`;
`desktop/src-tauri/src/recovery_activity.rs` tracks its actual startup and supervision activity.
The consumer is `src/service/desktop-recovery.ts`; `src/service/desktop-recovery-process.ts`
owns the executable and OS process/connection observations. This is an early startup guard,
not a new service owner, account credential or authority to stop another process.

## Native lifetime and intent

The shell attempts to register its read-only IPv4 loopback listener after constructing the bootstrap
window and before its first startup run. Its instance identifier is random for this process.
The resolved configuration home comes only from the bundled CLI's normal resolve answer.
After successful `recovery::register`, the producer reports `unknown` before resolution, never absence.
Registration failure installs no `Recovery` and grants no recovery authority. The listener survives
child exit and restart backoff. After home resolution, recovery credit requires a current startup
run, confirmed ownership of the attached runtime, or an actual supervisor recovery reservation.
Generic `wanted` intent alone is insufficient: a failed ordinary launch waiting for the person's
retry and an attached guest without a recovery reservation do not claim to be recovering.
The existing watchdog can later schedule recovery for a guest; attachment itself is not a schedule.
Activity follows the startup generation that `desktop/src-tauri/src/startup.rs` assigns, and the
reservations `desktop/src-tauri/src/supervisor.rs` takes survive the handoff from backoff into
the next run. Scheduling acquires its reservation under the supervisor lock before publishing
`pending`, so a competing completion cannot expose a reservation-free scheduled retry. Failed
recovery and deferred owned-child exits retain credit until their follow-up decision; a held or
cancelled retry releases it when no other work remains. A stale completion cannot clear a newer
run's activity. Each response also reads the
current exit coordinator: Stop, Quit and update drain revoke recovery immediately, without waiting
for a file update or heartbeat.

The producer writes no discovery file. The consumer discovers the independently identified
process's actual IPv4 loopback listening sockets through the OS; files cannot nominate a port,
exhaust the probe budget or hide a genuine listener. The listener keeps the same listening socket
after an accept error and waits 50 ms before retrying while active. Idle accept remains blocking;
the delay applies only after an error. The listener accepts two fresh nonce
challenges per connection, keeps the accepted socket
open through inspection, bounds request/response size, uses a three-second connection deadline,
and admits at most four simultaneous readers. It has no HTTP handler, credentials, mutations or
idle polling timer.

## Independent installation and process evidence

The consumer derives a native sibling only from an actually executing compiled `ocx`, its
canonical path and the known platform bundle layout. On POSIX the executable files and install
directory must be owned by the caller or root and cannot be group/other writable. Linux also
compares the running CLI's kernel image with its file. macOS requires the matching bundle
identifier, a valid complete bundle seal and dynamic checks requiring the selected CLI/native
executable's exact CDHash. The kernel's `proc_pidpath` selects native candidates; `ps` supplies
only same-user PIDs and birth times, because its `comm` field can be argv[0]. Both architecture
slices of a universal binary are supported. A failed kernel path read skips a PID only when a
separate signal-zero observation positively reports `ESRCH`. A live process, denied access or any
other observation failure remains unavailable evidence; a later FFI call does not recover the
path call's errno. PIDs must be positive signed 32-bit integers before either native observation.
The fixed libproc handle is closed after each scan.
Windows path and file-signature checks cannot establish the live mapped image's identity, so
an independently selected running sibling remains unknown and cannot earn recovery credit.
An npm/source CLI can additionally use the canonical Debian installation under `/usr/bin` only
when both executables and every parent are root owned and protected from non-root writes.
No argv, environment variable, login record, locator or self-reported executable selects an anchor.

Process discovery then requires this exact anchored executable, the current user and a process
birth identity. The accepted connection's owner is checked before protocol traffic. Two complete
process observations bracket fresh challenge responses. Linux
checks the accepted connection's exact IPv4 tuple, established state and inode held in the native
process's descriptor table. macOS uses the target process's established connection descriptor.
A listening port alone is insufficient. At most four native processes are inspected, with up to
eight native-owned listeners per process. All inspections share an eight-second deadline; each
listener gets at most 750 ms, including its OS commands.
The same accepted socket, native process incarnation, instance and canonical home must survive
both observations. Replaced images, reused PIDs, changed sockets, stale instances and ambiguous
OS reads do not earn recovery credit.

No locator files are read or written. Without an independently identified native process, an unrelated
renamed process cannot suppress ordinary CLI startup. With an identified process, missing or
inconclusive live evidence is unknown and `ensure` refuses. A platform that cannot bind a live
mapped image marks its verdict `unsupported` only when every path and file observation succeeded
and the selected files were unchanged across the check: it is a structural limitation rather than conflicting
evidence, so it earns no recovery credit and still refuses an unclaimed start, but it cannot veto
the bounded wait a durable claim and a running app already authorize. A claim never outranks
genuinely conflicting observations. A verified different configuration
home is irrelevant; a matching active recovery waits for the existing readiness probe, and a
matching stopped intent refuses with Start Proxy guidance. Ownership is read after this async
inspection; a new or unreadable durable claim is not bypassed by an earlier recovery snapshot.

## Installation scope

Desktop-created shims use its bundled CLI. The ordinary macOS/Linux package launcher can also
hand off to that CLI through the Desktop terminal integration. A legacy npm-created Codex shim
pins its own Bun/source entrypoint and bypasses that launcher. Root-owned Debian discovery covers
that combination. A direct Bun/source CLI on macOS or Windows has no installation anchor here,
even for an official signed Desktop; arbitrary unsigned per-user Linux copies have the same
limitation. Names and files do not create an anchor. An independently observed Windows sibling
remains unverified: it earns no recovery credit even when its on-disk signatures are valid, still
refuses an unclaimed automatic cold start, and no longer vetoes the bounded wait a durable claim and
running app already authorize.
Explicit `ocx start` and the existing consented service installation flow remain user-controlled.

`tests/service/service-desktop-recovery.test.ts` covers protocol, OS evidence races and a real Linux
compiled CLI/native producer pair, including a protocol-speaking unrelated installation.
`tests/cli/cli-ensure-desktop-cold-start.test.ts` covers the resulting wait/refuse/CLI decisions.
`tests/clients/desktop-startup-surface.test.ts` binds producer registration and home selection to
the native startup entrypoint. Native protocol and activity-transition tests also run in the Rust
modules' test suites.

# Managed service logging

`src/cli/index.ts` activates `src/service/logging.ts` before CLI preflight only
for `start` with `OCX_SERVICE` set. The console sinks prefix every physical line
with UTC ISO-8601 time, including multiline diagnostics. Foreground output and
other CLI commands retain their existing format, even with an inherited marker.
Existing redaction stays in the producers; this adds no request-body capture or
diagnostic fields. Windows service-wrapper messages retain their wrapper format.

## Retention

Startup and once-per-minute checks rotate above 20 MiB. The previous archive
moves to `service.log.2`; the newest 20 MiB of the active file are copied into
`service.log.1` with a fixed 64 KiB buffer. The active inode is then truncated in
place, preserving the service manager's existing append descriptors. Both
archives stay bounded even when a legacy active log is already very large.
Archive paths join the config cleanup manifest.

Rotation accepts only regular, singly linked active and archive leaves. The
active descriptor must match the inspected leaf's device and inode; POSIX opens
also use no-follow and nonblocking flags. A new archive is created exclusively,
not opened with truncation. Descriptor/leaf identities are checked while copying
and again before truncating the active inode, after flushing the new archive.
Unsafe leaves, observed replacements, and copy or flush failures skip truncation.
Parent directory aliases remain supported: rotation resolves only the parent,
uses its canonical path for exclusive archive creation, and rechecks the original
and canonical directory identities and both leaf paths against the descriptors.
It never resolves the leaf itself to bypass symlink rejection.
These checks are not an atomic
namespace lock: concurrent directory or hardlink changes can race a final check.

The timer is unreferenced and filesystem failures are swallowed. The active log
may exceed the threshold between checks. Copy-truncate can lose concurrent
writes, and the retained tail can begin partway through a line. There is no
per-write filesystem check and no timer when service logging is inactive.

`tests/service/service-log.test.ts` covers service-only timestamps, multiline
formatting, startup and periodic checks, bounded generations, failure handling,
continued writes through an append descriptor opened before rotation, unsafe
leaves, controlled identity replacements, exclusive archive creation, parent
aliases, and partial-copy/flush failures.

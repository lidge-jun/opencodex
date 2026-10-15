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

The timer is unreferenced and filesystem failures are swallowed. The active log
may exceed the threshold between checks. Copy-truncate can lose concurrent
writes, and the retained tail can begin partway through a line. There is no
per-write filesystem check and no timer when service logging is inactive.

`tests/service/service-log.test.ts` covers service-only timestamps, multiline
formatting, startup and periodic checks, bounded generations, failure handling,
and continued writes through an append descriptor opened before rotation.

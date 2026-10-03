# Local Codex messaging foundation

`src/messaging/` contains a command-owned, currently unregistered foundation for
local Codex discovery and native queue interoperability. There is no CLI command,
management API, startup hook, enabled setting, listener, persistent store or skill
installation in this foundation. Ordinary source entries do not import it.

> Decision record: [ADR-6478](decisions/ADR-6478-local-messaging-foundation.md)

## Local read-only transport

`src/messaging/socket.ts` constructs the existing app-server control socket
address from an explicit absolute Codex home. It exposes Bun's Unix WebSocket
spelling and native Codex's Unix transport spelling. It does not resolve a home,
start a daemon or accept a network URL. Linux/macOS are the transport scope;
Windows and unsupported or unaddressable paths fail explicitly. A conservative
103-byte UTF-8 socket-path budget is enforced for both Bun and native addresses.

`src/messaging/rpc.ts` initializes one connection and sends initialized before
metadata requests. Its request surface contains only loaded-session pagination
and metadata-only thread reads. It cannot create/resume a session, start/steer a
turn, grant permission or submit a message. A thread read returns only ID, name
and status, excluding history, preview and working directory.

Responses must match the requested ID and bounded metadata shape. RPC errors are
sanitized. There are at most four pending requests and frames are capped at 1 MiB.
Invalid frames, oversized frames, invalid metadata, connection loss,
cancellation and RPC timeout close the connection and settle pending requests.
An explicit caller close clears pending timers and removes socket/abort handlers.

## Exact and complete discovery

`src/messaging/discovery.ts` lists loaded IDs only; it does not inspect stored
rollouts or resume a stored session. At most 20 pages of 50 IDs are read. Repeated
cursors/IDs and exhausted pagination fail as incomplete. Metadata is read with
at most four concurrent calls, with every batch settled before returning or
throwing. Failed metadata or a session unloading during lookup cannot disappear
silently from a supposedly complete directory.

Exact-name resolution requires a complete directory and a unique exact match.
Exact UUID resolution requires membership in that directory. The standalone
resolver consumes the complete-discovery result; callers must not pass a partial
directory. Names never become guessed UUID routes. Snapshot membership is not a
guarantee that a session stays loaded after discovery.

## Owned lifecycle and subprocesses

`src/messaging/budget.ts` supplies one maximum 30-second operation deadline and
parent cancellation. Callers create and dispose that budget around all their
work, including connection, discovery and native helpers. Individual RPCs are
also capped at 10 seconds. Modules allocate no resources at import time.

`src/messaging/process.ts` invokes an explicit argv without a shell, retry or
logging. Each child has at most a 20-second stage budget within the operation
deadline and 64 KiB per output stream. Only bounded stdout is returned; stderr
is discarded. Failure before spawn is distinguishable from incomplete execution.
Cancellation, timeout or overflow terminates and joins only that helper. On Unix
it creates an owned process group, so ordinary launcher descendants retaining
inherited pipes are terminated too; it never signals the caller's group. Forced
termination follows after one second, so cleanup may outlast the operation
deadline by this bounded grace period. No recipient/daemon/proxy is stopped.

Submission receipts, sender envelopes and the public command do not yet exist.
The child runner's successful exit alone must not be interpreted as recipient
processing. The native queue test exercises acknowledgement against an isolated
fixture, not end-to-end delivery to an actual agent.

## Verification boundaries

- `tests/codex-integration/messaging-local-discovery.test.ts` exercises complete
  loaded-only lookup, exact matching, incomplete/malformed responses and bounded
  metadata concurrency.
- `tests/codex-integration/messaging-local-lifecycle.test.ts` exercises no import
  allocations, no incoming literal imports, cancellation/close, frame/output
  limits and subprocess teardown. The parser inventory is not an exhaustive
  dynamic dependency graph or proof about arbitrary computed imports.
- `tests/codex-integration/messaging-local-native-queue.test.ts` uses an explicitly
  supplied Codex 0.160.0 binary and isolated Unix fixture. Without the explicit
  opt-in it skips, which is not passing interoperability evidence.
- `tests/helpers/messaging-local.ts` rejects unexpected/lifecycle RPCs and joins
  fixture work before removing the scratch home. Its uniquely owned short Unix
  root carries the repository stale-root marker, avoiding overlong sockets under
  nested test-runner homes. It needs no user daemon or API.

Native schema/help and the successful Linux fixture run bind the present evidence
to Codex 0.160.0, not an invented minimum version or macOS compatibility claim.
Remote authentication, enrollment, Claude, root relay, isolation and idle notices
are absent. Implementation beyond the foundation remains scoped by
`devlog/_plan/261003_codex_local_messaging/` and is not architecture acceptance.

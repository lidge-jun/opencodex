# Local Codex messaging foundation

`src/messaging/` contains command-owned local Codex discovery and queued peer
submission. `src/cli/message-command.ts` activates it only for `ocx message`.
There is no management API, startup hook, enabled setting, listener, persistent
store or skill installation. Ordinary proxy startup does not activate messaging.

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
deadline by this bounded grace period. At forced cleanup, pending output readers
are cancelled without awaiting EOF or their cancellation hooks. A detached
descendant can keep running outside the owned group, but cannot keep the command
waiting on inherited pipes; its new group is never signalled. No recipient,
daemon or proxy is stopped.

## Command-local CLI

> Decision record: [ADR-6479](decisions/ADR-6479-local-messaging-command.md)

`src/cli/dispatch.ts` dynamically imports the command runner for the message verb.
`src/cli/message-args.ts` rejects malformed, duplicate and remote/Claude options
before any command resource or runtime selection. `src/cli/codex-shim-autorestore.ts`
skips repair for the whole namespace. Registry, capability and help declarations
describe sessions/send; no management route is claimed.

`src/cli/message-runtime.ts` reuses effective Codex-home resolution and existing
runtime selection without persistence or synchronous version probes. It selects
once, with no post-failure runtime fallback. It uses the shared platform-safe
invocation builder. Unsupported platforms are rejected before a helper runs.

`src/messaging/native.ts` creates one temporary credential-free helper home and
sets shim probe/bypass flags for all native invocations. It invokes version and
queue help, requiring the contract-tested 0.160.0 version and tested queue/Unix
flags. It removes only its owned temporary root on completion. Native queue
addresses the selected existing control socket explicitly, so the helper cannot
fall back to starting a daemon in that temporary home. No install or repair occurs.

One maximum 30-second budget covers stdin, home selection, discovery, preflight,
revalidation and submission. `src/messaging/input.ts` incrementally reads at most
16 KiB of UTF-8 stdin, rejecting invalid bytes, empty text and NUL. The final
envelope is bounded at 32 KiB. SIGINT/SIGTERM cancel only command-owned work.

## Envelope and receipt semantics

`src/messaging/envelope.ts` assembles the caller-generated UUID, kind, response
correlation and reply guidance. A response requires a request UUID; notifications and responses
do not request acknowledgements. Routing never comes from the body or a name.
Sender context comes from a valid loaded CODEX_THREAD_ID and current metadata,
not a user-supplied announcement or authenticated authority. A missing sender
remains unknown with no invented reply command; an invalid/unloaded claimed
sender fails before submission. No delegation or permission-management surface
is added. The envelope identifies peer content as neither approval nor escalation.

`src/messaging/send.ts` resolves complete loaded membership and rechecks the exact
destination ID after native preflight. An unload blocks sending without resume.
It invokes native queue once, with the wrapper envelope as message text:

- `not_sent`: validation/discovery/preflight/revalidation fails, or the submission
  helper is provably not started. There is no automatic retry.
- `queued`: native queue exits successfully, acknowledging submission, not
  recipient processing or steering.
- `unknown`: after submission-helper spawn, a nonzero, incomplete, cancelled,
  timed-out or lost result cannot establish whether submission occurred. Do not
  replay or probe by sending another message.

Receipts contain bounded metadata and application message correlation, never
the body or helper output. Native clientUserMessageId is separate native queue
correlation, not an OpenCodex processing receipt. Native queue's required message
argv is visible to processes permitted to inspect the helper; this is not a
body-confidentiality barrier against the same user. No request-body logging is added.

## Verification boundaries

- `tests/codex-integration/messaging-local-discovery.test.ts` exercises complete
  loaded-only lookup, exact matching, incomplete/malformed responses and bounded
  metadata concurrency.
- `tests/codex-integration/messaging-local-lifecycle.test.ts` exercises no import
  allocations, command-local literal imports, cancellation/close, frame/output
  limits and subprocess teardown. The parser inventory is not an exhaustive
  dynamic dependency graph or proof about arbitrary computed imports.
- `tests/codex-integration/messaging-local-native-queue.test.ts` uses an explicitly
  supplied Codex 0.160.0 binary and isolated Unix fixture. Without the explicit
  opt-in it skips, which is not passing interoperability evidence.
- `tests/codex-integration/messaging-local-send.test.ts` exercises unsupported
  capability, stale target, isolated helper environments and no-replay receipts.
- `tests/codex-integration/messaging-local-envelope.test.ts` covers metadata-only
  routes, unknown sender, bounded input, kind/correlation and no ack loops.
- `tests/codex-integration/messaging-local-cli.test.ts` exercises the actual CLI
  against isolated native stubs, pure syntax rejection and non-persisting selection.
- `tests/helpers/messaging-local.ts` rejects unexpected/lifecycle RPCs and joins
  fixture work before removing the scratch home. Its uniquely owned short Unix
  root carries the repository stale-root marker, avoiding overlong sockets under
  nested test-runner homes. It needs no user daemon or API.

Native schema/help and the successful Linux fixture run bind the present evidence
to Codex 0.160.0, not an invented minimum version or macOS compatibility claim.
Remote authentication, enrollment, Claude, isolation and idle notices
are absent. This local-only implementation is a contribution candidate, not
architecture acceptance, independent review or permission to open a PR.

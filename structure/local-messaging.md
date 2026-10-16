# Local Codex messaging foundation

`src/messaging/` contains command-owned local Codex discovery and queued peer
submission. `src/cli/message-command.ts` activates it only for `ocx message`.
There is no management API, startup hook, enabled setting, listener, persistent
store or skill installation. Ordinary proxy startup does not activate messaging.

> Decision record: [ADR-6478](decisions/ADR-6478-local-messaging-foundation.md)

## Local transport and trust

`src/messaging/socket.ts` constructs the existing app-server control socket
address from an explicit absolute Codex home. It does not resolve a home, start
a daemon or accept a network URL. Linux/macOS are the transport scope; Windows
and unsupported or unaddressable paths fail explicitly. A conservative 103-byte
UTF-8 socket-path budget applies to both the supplied and resolved address.

Before connecting, the socket's real path must identify a socket owned by the
current uid. Every directory from its real parent through root must be owned by
that uid or root and must not be group/other writable, except root-owned sticky
directories. A symlinked home or socket is accepted only when the resolved path
passes these checks. Filesystem failures return sanitized `untrusted_socket`
errors without resolved path details. The filesystem interface is injectable.
Only the validated real address is connected; no helper or reconnect is used.

`src/messaging/rpc.ts` initializes one connection with experimental API capability
and sends initialized before metadata requests. Its explicit request whitelist
contains initialize, loaded-session pagination, metadata-only thread reads and
one text-only `thread/queue/add`. It cannot create/resume a session, start/steer a
turn or grant permission. A thread read returns only ID, name and status,
excluding history, preview and working directory.

Responses must match the requested ID and bounded shape. RPC errors are sanitized.
There are at most four pending requests and frames are capped at 1 MiB. Invalid
frames, oversized frames, invalid metadata, connection loss, cancellation and RPC
timeout close the connection and settle pending requests. An explicit caller
close clears pending timers and removes socket/abort handlers.

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

## Owned lifecycle

`src/messaging/budget.ts` supplies one maximum 30-second operation deadline and
parent cancellation. Callers create and dispose that budget around input, home
selection, connection, discovery, revalidation and submission. Individual RPCs
are also capped at 10 seconds. Modules allocate no resources at import time.
Messaging launches no subprocess. SIGINT/SIGTERM cancel only command-owned work;
no recipient, daemon or proxy is stopped.

## Command-local CLI

> Decision record: [ADR-6479](decisions/ADR-6479-local-messaging-command.md)

`src/cli/dispatch.ts` dynamically imports the command runner for the message verb.
`src/cli/message-args.ts` rejects malformed, duplicate and remote/Claude options
before any command resource or home selection. `src/cli/codex-shim-autorestore.ts`
skips repair for the whole namespace. Registry, capability and help declarations
describe sessions/send; no management route is claimed.

`src/cli/message-runtime.ts` reuses effective Codex-home resolution without
persistence. Messaging needs no selected CLI binary or version pin. The existing
Codex daemon must support experimental `thread/queue/add`; there is no installation,
repair, daemon start or runtime fallback when it rejects the method.

`src/messaging/input.ts` incrementally reads at most 16 KiB of UTF-8 stdin,
rejecting invalid bytes, empty text and NUL. The final envelope is bounded at
32 KiB. Message text travels only in the existing Unix RPC connection, never in
spawned process arguments. No request-body logging is added.

## Envelope and receipt semantics

`src/messaging/envelope.ts` assembles the caller-generated UUID, kind, response
correlation and reply guidance. A response requires a request UUID; notifications
and responses do not request acknowledgements. Routing never comes from the body
or a name. Sender context comes from a valid loaded CODEX_THREAD_ID and current
metadata, not a user-supplied announcement or authenticated authority. A missing
sender remains unknown with no invented reply command; an invalid/unloaded claimed
sender fails before submission. No delegation or permission-management surface
is added. The envelope identifies peer content as neither approval nor escalation.
Peer claims remain text input, not native approval responses or configuration
overrides. Guidance is not an authorization mechanism: receiving-agent permission
enforcement belongs to its harness, and model compliance is not proven here.

`src/messaging/send.ts` resolves complete loaded membership, rechecks the exact
destination ID and submits on the same connection. An unload observed by that
check blocks sending without resume. Revalidation and queueing are not atomic;
a destination can unload afterwards and the daemon may reject the request.

The one queue request carries `threadId`, a single text input and the receipt's
message UUID as `clientUserMessageId`. The submission ID and text input shape
must be valid and the returned `clientUserMessageId` must match that UUID.

- `not_sent` (exit 1): validation/discovery/revalidation fails, the queue frame is
  not written, or a well-formed matching JSON-RPC error rejects it. Unsupported
  method, unknown queue variant or experimental-capability errors become
  `unsupported_queue`; other server errors become `queue_rejected`.
- `queued` (exit 0): a valid correlated response acknowledges submission, not
  recipient processing or steering.
- `unknown` (exit 3): after the frame is written, timeout, connection loss,
  cancellation, malformed or mismatched replies cannot establish submission.
  Never replay, reconnect, resume or probe by sending another message.

Receipts contain bounded metadata and application message correlation, never
body text or raw daemon output. `clientUserMessageId` now shares the envelope's
UUID; the daemon's submission ID remains separate. Neither is a processing receipt.

## Verification boundaries

- `tests/codex-integration/messaging-local-discovery.test.ts` exercises complete
  loaded-only lookup, exact matching, incomplete/malformed responses and bounded
  metadata concurrency.
- `tests/codex-integration/messaging-local-lifecycle.test.ts` exercises no import
  allocations, command-local literal imports, cancellation/close and frame limits.
  The parser inventory is not an exhaustive dynamic dependency graph or proof
  about arbitrary computed imports.
- `tests/codex-integration/messaging-local-send.test.ts` exercises correlated
  text-only queueing, zero spawned helpers, stale targets, sanitized rejection
  mappings and pre/post-write failures without replay or reconnect.
- `tests/codex-integration/messaging-local-socket.test.ts` exercises real private
  and symlinked homes, writable-parent and non-socket rejection, plus injected
  ownership, ancestor modes and root-owned sticky-directory fixtures.
- `tests/codex-integration/messaging-local-envelope.test.ts` covers metadata-only
  routes, unknown sender, bounded input, kind/correlation, no ack loops and
  preservation of peer permission claims as text rather than header authority.
- `tests/codex-integration/messaging-local-cli.test.ts` exercises the actual CLI
  against an offline fake daemon with helper spawns forbidden, all exit statuses,
  pure syntax rejection and effective home selection.
- `tests/helpers/messaging-local.ts` rejects unexpected/lifecycle RPCs and joins
  fixture work before removing the scratch home. Its uniquely owned short Unix
  root carries the repository stale-root marker. It needs no user daemon or API.

Offline fixtures establish request/response contracts, not receiving-model
obedience or a real daemon's atomic loaded-target enforcement. Remote authentication,
enrollment, Claude, isolation and idle notices are absent. Independent review and
architecture acceptance remain separate from this contribution implementation.

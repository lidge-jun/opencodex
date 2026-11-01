# Local Codex messaging foundation

`src/messaging/` contains command-owned local Codex discovery and queued peer
submission. `src/cli/message-command.ts` activates it only for `ocx message`.
The existing sessions/send path has no management API, startup hook, enabled setting, listener,
persistent store or skill installation. Ordinary proxy startup does not activate
messaging. Explicit enrolled peers belong to [remote messaging](remote-messaging.md).
The separate opt-in stored-queue MCP host is described below; it does not replace
the loaded-session transport or change its discovery/admission rules.

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
The loaded-session path launches no subprocess. SIGINT/SIGTERM cancel only command-owned work;
no recipient, daemon or proxy is stopped.

## Command-local CLI

> Decision record: [ADR-6479](decisions/ADR-6479-local-messaging-command.md)

`src/cli/dispatch.ts` dynamically imports the command runner for the message verb.
`src/cli/message-args.ts` rejects malformed, duplicate and remote/Claude options
before any command resource or home selection. `src/cli/codex-shim-autorestore.ts`
skips repair for the whole namespace. Registry, capability and help declarations
describe sessions/send; no management route is claimed. The separate pure remote
parser selects a dynamic remote-command import only for explicit remote operations;
local operations do not read peer state or start an owner.

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
obedience or a real daemon's atomic loaded-target enforcement. Remote authentication
and enrollment have a [separate owner](remote-messaging.md); Claude, isolation and
idle notices are absent. Independent review and
architecture acceptance remain separate from this contribution implementation.

## Opt-in stored-queue MCP host

`src/cli/message-mcp-command.ts` parses `message mcp --codex --codex-home` before
loading the SDK. Both paths are explicit and absolute; no setup, registration,
proxy ensure or fallback into the existing sessions/send command occurs. Windows
is refused. `src/messaging/mcp-queue-server.ts` is activated only by this command,
exposes stdio tools, and allocates no helper at import or initialization time.

`src/messaging/mcp-queue-tools.ts` exposes `codex_threads` and
`codex_queue_message` by default. The first returns one bounded page of stored metadata and
a cursor, excluding preview, history and cwd. It explicitly reports that live
state is unverified. The second validates an exact UUID and at most 16 KiB of
text including a fixed peer-context label; NUL/empty text is refused. Sender
identity, model overrides and permission escalation are not part of this API.
These tools do not share the loaded-only admission contract above.

`src/messaging/mcp-queue-rpc.ts` owns each explicitly selected CLI helper. The
existing `src/codex/exec-boundary.ts` validates actual execution, including
macOS bundle trust. Helpers use only app-server stdio and an explicit existing
Codex home; inherited CODEX_THREAD_ID is removed. After initialize/initialized,
the default methods are thread/list and thread/queue/add.
Explicit reply-read activation additionally admits the three read methods below. No lifecycle or
login RPC is issued. The queue request carries a generated clientUserMessageId;
only a matching correlated receipt becomes queued. Rejection before/at a valid
error is not_sent. Uncertain outcomes after write are unknown without replay.
Queued is storage, not recipient processing. Message bodies and native output
never appear in argv, receipts or diagnostics.

At most four operations run per host. Each has a 20-second budget including
execution validation, a 12-second RPC deadline, incremental strict UTF-8 decode
and a 1 MiB output cap. Cleanup escalates to SIGKILL after 600 ms. SDK cancellation, host disconnect and process signals
cancel owned work. EOF is followed by bounded TERM/KILL escalation and joined
child exit. Cleanup targets invocation-owned groups, never the recipient.
The native CLI may maintain state in its selected home; OpenCodex adds no store.
Local-user MCP access is not per-project/thread isolation.

`tests/codex-integration/messaging-mcp-queue.test.ts` covers offline protocol,
limits, privacy, failure receipts and cancellation. `tests/cli/cli-message-mcp.test.ts`
exercises the actual CLI/MCP handshake, inert initialization, the four-helper
bound and disconnect cleanup. The fixtures use disposable native helpers, not
real accounts. They prove queue contracts rather than app consumption, goal
behavior, model obedience or cross-platform native interoperability.


## Explicit stored reply reads

`src/cli/message-mcp-command.ts` accepts a single optional --allow-reply-read flag.
The existing four path arguments preserve the default two-tool surface. The host
registers codex_read_reply only with this explicit content-read opt-in; the tool
and RPC owner also refuse read calls without it. This broadens disclosure to stored
agent text within the selected local-user home, not per-thread authorization.
Client IDs and cursors are not credentials or delegated permission.

`src/messaging/mcp-reply-tools.ts` searches one descending page of 50 persisted
items for the exact clientMessageId. Omitted or null user client IDs are unrelated
messages; malformed non-null IDs still fail validation. Absence is not_observed with a position-scoped
reachedHistoryEnd flag, never proof of non-delivery. Multiple matches in that page
are ambiguous and expose no text. A match identifies a turn; one ascending page
of its final_answer agent messages is projected with IDs and turn association.
All final texts in the turn are eligible, including text preceding a later input;
the association is always same_turn_not_exclusive. User bodies, reasoning, command
outputs, citations and extra native fields are excluded. A shared 16 KiB UTF-8 text
budget marks truncation per item; item cursors do not recover omitted text bytes.

`src/messaging/mcp-reply-cursor.ts` bounds and canonically decodes caller-owned
positions bound to thread and client IDs. A search cursor continues item search;
a reply cursor identifies a turn/user item and native continuation. Cursors are
forgeable position data, never authority: every reply continuation re-reads that
user item through thread/items/read and checks item ID, turn and client correlation.
Other reads use thread/items/list and thread/turns/list. All methods are explicitly
allowed by the RPC owner; no lifecycle or queue mutation is added by reading.

The latest 50 notLoaded turn summaries provide turnStatus when found, otherwise
unverified. This is a stored observation, not global recipient liveness or goal
completion. A refresh cursor rescans the matched turn so an item finalized later
can be observed. The caller revisits pages and updates/deduplicates stable item IDs;
OpenCodex adds no persistent read state, subscriptions or background timers.

Each complete read shares one 20-second MessageBudget across at most three
sequential invocation-owned helpers, each retaining 12-second RPC and 1 MiB output
bounds. Native read rejection/unsupported methods, malformed data, invalid positions
and cancellation are unavailable, not empty success. No raw native error reaches
MCP output. Legacy stores have no unbounded includeTurns fallback.

`tests/codex-integration/messaging-mcp-replies.test.ts` covers correlation, projection,
position scoping/revalidation, late finalization, missing/ambiguous inputs, page and
UTF-8 limits, inherited budget/cancellation and failure privacy. The actual CLI
opt-in handshake is exercised by `tests/cli/cli-message-mcp.test.ts`; existing inert
activation and default-tool tests remain in force. Offline helpers prove protocol
contracts, not native app processing, goal behavior or cross-client registration.

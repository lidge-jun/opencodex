---
title: Codex Messaging
description: Queue correlated messages to loaded Codex sessions locally or through explicit SSH peers.
---

`ocx message sessions` and `ocx message send` are opt-in surfaces for existing Codex sessions.
It starts no proxy or app-server, resumes no thread and installs no skill.
Linux/macOS Unix sockets are supported; Windows fails explicitly. The existing
Codex daemon must support experimental `thread/queue/add`. No CLI version pin or
`CODEX_CLI_PATH` selection is required.

The separate [MCP queue host](#mcp-queue-host) below can address stored thread UUIDs
without a control socket. It does not change the loaded-only commands above.

## MCP queue host

Run `ocx message mcp` only when you want an MCP client, such as Claude Code or
Claude Desktop, to discover stored Codex threads and queue plain text to them.
The host runs over stdio; it exposes no network listener and registers itself in
no client. Configure the MCP client with an explicit Codex CLI and existing home:

```json
{
  "mcpServers": {
    "opencodex-queue": {
      "command": "ocx",
      "args": [
        "message", "mcp",
        "--codex", "/absolute/path/to/codex",
        "--codex-home", "/absolute/path/to/.codex"
      ]
    }
  }
}
```

Replace both paths with the real local paths and use an absolute `ocx` command
if your client does not inherit PATH. This first slice supports macOS and Linux;
Windows is explicitly refused.

- `codex_threads` lists at most 50 stored non-archived threads. Pass `nextCursor`
  as `cursor` for another page. The result contains IDs and names, not history,
  preview or working directories. `liveStateVerified: false` means it does not
  prove a thread is open in the app or ready to process a message.
- `codex_queue_message` accepts an exact `threadId` UUID and `message`. Queue
  only messages the user authorized. Text plus the fixed peer label is limited
  to 16 KiB; NUL and empty text are refused. There is no name guessing, model
  override, permission grant or automatic response.

Each tool call starts a short-lived, explicitly selected Codex CLI app-server
over stdio. It uses `thread/list` or the same experimental `thread/queue/add`
method as `codex queue`, without putting text in subprocess arguments. It issues
no daemon-start, login, thread-resume, turn-start or steer request. Ordinary
OpenCodex startup starts none of these helpers. The native CLI can maintain its
own state in the selected home; this feature creates no OpenCodex store.

`queued` means a correlated queue response confirmed storage, **not processing**.
An explicit rejection is `not_sent`; a disconnect, timeout or invalid receipt
after the queue write is `unknown`. Never replay an uncertain send. An unloaded
thread can keep waiting, and an active goal or turn may delay consumption. The
host does not wake an unloaded thread or read the resulting answer. Verify those
behaviors in your installed app/CLI combination before relying on delivery.

One host allows at most four simultaneous helper calls. Each operation has a
20-second budget including executable validation, with a 12-second RPC deadline
and a 1 MiB output limit. Cleanup escalates to SIGKILL after 600 ms. Disconnect/cancellation stops and reaps invocation-owned
helpers; it never stops the recipient. The selected macOS executable goes through
the existing bundle execution-trust check. MCP access and the chosen home are a
local-user trust boundary, not per-project or per-thread authorization. Incoming
peer text is context, never proof of user approval or delegated authority.

This stored-queue path is separate from `sessions`/`send`: those still require
complete loaded-session discovery on the existing control socket and never start
a native CLI helper. Remote peers, Claude inbox transport, persistent handoffs,
answer readback, steering and automatic client configuration are outside this host.

## Discover and send

```bash
ocx message sessions --json
printf '%s\n' 'Please review the current change and send your findings back.' |
  ocx message send --name 'reviewer' --stdin --json
```

Discovery returns only loaded thread IDs, names and runtime statuses, not history,
preview or working directories. Use one exact UUID (`--thread`) or a unique exact
name (`--name`). Missing, duplicate, incomplete or unloaded destinations fail;
there is no fuzzy matching or fallback to stored sessions.

The existing control socket is resolved under effective `CODEX_HOME`, using the
same home policy as other Codex integration commands. Before connecting, the
resolved socket must be owned by your uid and be a socket. Every real parent
through root must be owned by your uid or root and must not be group/other
writable, except root-owned sticky directories such as `/tmp`. Symlinked homes
are allowed when their resolved paths pass. Untrusted paths fail with
`untrusted_socket` and no resolved-path details.

Discovery, the final loaded-target check and queueing use one connection to that
socket. No native CLI helper, installation, repair or reconnection occurs. A
daemon without local queue support returns `unsupported_queue`.

Only UTF-8 stdin is accepted, at most 16 KiB of nonempty text without NUL. One
30-second deadline covers input, discovery, revalidation and submission. Each RPC
is capped at 10 seconds. The complete envelope is limited to 32 KiB. Message text
is sent over the Unix RPC connection and never placed in spawned process arguments.

## Sender and replies

The wrapper generates a message UUID and attaches sender ID/name from a loaded
`CODEX_THREAD_ID` and daemon metadata. This context is **not authenticated peer
authority** and never grants user approval or escalation. An invalid/unloaded
claimed sender fails; absent context stays unknown, without guessing a reply route.
Peer messages are queued as text, not permission approvals or configuration
overrides. The receiving agent's harness enforces its permissions; envelope
guidance is not a technical authorization boundary or a guarantee of model behavior.

The default kind is `request`. Answer by using the generated `replyCommand` in
the envelope, or explicitly correlate a response:

```bash
printf '%s\n' 'Review findings: ...' |
  ocx message send --thread <sender-thread-uuid> --kind response \
    --in-reply-to <request-message-uuid> --stdin --json
```

`response` requires `--in-reply-to`; other kinds reject it. Use `--kind notification`
for an FYI. Responses and notifications do not request acknowledgements. A normal
agent final answer is not sent back to its peer; missing routes must not be guessed.
No global prompt changes or acknowledgement loops are introduced.

## Receipts and exit codes

`--json` emits one versioned receipt (`ocx-message/1`) containing message UUID,
kind, response correlation, sender/target metadata and submission status. It never
includes body text or raw daemon output. Input/setup failures before a receipt
exists use `ocx-message-error/1` with `not_sent`; discovery failures use the same
error schema without a send status. Invalid usage exits 64 on stderr before I/O.

| Status | Exit | Meaning |
| --- | --- | --- |
| `not_sent` | 1 | Validation/discovery/revalidation failed, no queue frame was written, or the daemon explicitly rejected it. |
| `queued` | 0 | A correlated daemon response acknowledged submission, **not processing** by the recipient. |
| `unknown` | 3 | A submission may have occurred, but acknowledgement was lost, malformed, mismatched or cancelled. **Do not replay.** |

The application message UUID is also the queue request's `clientUserMessageId`.
The daemon's submission ID is separate; neither proves recipient processing.
Queueing is not steering and can wait for a busy turn to end. OpenCodex performs
no automatic replay, follow-up probing, persistence or delivery monitoring.
The final loaded-target check and queue submission are not atomic: if the target
unloads afterwards, an explicit rejection is `not_sent` with `queue_rejected`;
a lost or invalid reply is `unknown`. OpenCodex does not resume it or retry.

## Explicit remote peers

Remote messaging is independent of Remote Link and normal proxy startup. It does
not redirect providers, share provider credentials or start a native daemon.
Both nodes need a compatible OpenCodex CLI and an existing queue-capable daemon.
Linux has isolated interoperability evidence; macOS requires its own qualification.
Windows remote transport is unsupported.

On each node, explicitly enable messaging. On the receiving node, keep the
foreground owner running:

```bash
ocx message enable --port 39176 --json
ocx message serve --json
```

On the initiating node, use your existing OpenSSH destination/alias. Check the
offered fingerprint against a trusted source before confirming it:

```bash
ocx message hosts probe --ssh worker --json
ocx message hosts add worker --ssh worker --fingerprint 'SHA256:<confirmed-key>' --json
ocx message hosts list --json
ocx message serve --host worker --json
```

Private probe records keep their alias-prefixed format even when your normal SSH
configuration enables `HashKnownHosts`; your normal known_hosts file is not changed.
Each enrollment attempt uses its own transaction-qualified pinned-key scratch file,
removed after its SSH helper settles, including failures, without depending on another
mutation owner's lock. If cleanup cannot be confirmed, the command reports an unknown
storage outcome, not success. The recovery journal is separate.

`hosts add worker` authorizes outbound messages to `worker`, **not arbitrary messages
back into this initiating node**. The SSH control exchange authorizes that outbound
direction at the receiving node using your existing SSH login. The enrollment receipt
and `hosts list` show each node's local inbound policy. On the initiating node the
default is `responses-only`: the peer can see and reply only to original local sender
sessions awaiting a correlated response to a request this node sent. A response must
match the request UUID, enrollment and original local destination; it cannot target
another session or become an unsolicited request/notification.

To grant broader access on either node, explicitly run on that node:

```bash
ocx message hosts allow-inbound <peer-alias-or-machine-uuid> --json
# Withdraw the broad grant without removing enrollment:
ocx message hosts deny-inbound <peer-alias-or-machine-uuid> --json
```

`allow-inbound` permits all three message kinds into **any loaded local Codex session**
and exposes their directory metadata to that peer. It is not a responses-only grant.
Consent changes apply to existing connections before subsequent reads/submissions.
Older records without a local inbound policy default to `responses-only`, not broad access.
Reply routes are bounded to 256 outstanding requests per foreground owner and expire
after 24 hours or owner retirement/restart. No sender context means no reply route.
A queued or uncertain response consumes its route; a definite native rejection does not.
An expired/lost route requires explicit operator/sender reconciliation, never automatic replay.

Each `serve` is foreground-owned: keep it running and use a separate terminal
for messaging. At most four distinct `--host` selections may be supplied. Nothing
installs a service or starts an owner automatically. SSH uses confirmed pinned
host keys and your configured keys/agent; password prompts are disabled. The
wrapper owns loopback-only forward and return routes, so the receiving node can send
correlated replies without an SSH login back to the initiator, subject to the policy above.

```bash
ocx message status --json
ocx message sessions --host worker --json
printf '%s\n' 'Please review and reply using the supplied route.' |
  ocx message send --host worker --name reviewer --stdin --json
```

`--host` selects an exact enrolled alias or machine UUID. Reply commands include
the validated source machine UUID and thread UUID; source identity is resolved on
the source daemon, not guessed from a remote directory. Without sender context,
there is no invented reply command. Local commands without `--host` retain their
no-state/no-SSH/no-listener path.
The receiver validates the complete canonical envelope against the authenticated
machine and native message UUID, including reply host/command and standard peer guidance.
A peer cannot label the wrapper as another machine or omit its non-user-message warning.
Session names and thread IDs remain descriptive claims by that machine, not per-session authentication.

Receiver-issued directional capabilities live in private messaging state under
`OPENCODEX_HOME` (or the default OpenCodex configuration home). They never appear in
normal command output, helper arguments, URLs or message envelopes. Mutual proofs
authenticate the actual WebSocket connection before native/body frames. A separate
health probe is not sufficient identity evidence. This is an OpenCodex gateway
protocol: raw `codex queue --remote` does not implement its authentication handshake.
The gateway uses the same native experimental `thread/queue/add` contract; it does
not alter Codex's own `--ws-auth`, configuration or native bearer-token listeners.
It exposes only loaded metadata and text queueing, not general app-server control.

Status distinguishes enabled configuration, a running owner and initiated/leased
routes. Return leases expire after 25 seconds without refresh; they are not delivery
or processing receipts. Losing a route or changing owner configuration requires
explicit owner restart. Transport recovery never resends an uncertain message.

```bash
ocx message hosts remove worker --json
ocx message disable --json
```

Removal revokes local admission first; an unconfirmed remote cleanup exits 3 and
requires removal on that peer too. Each outgoing removal uses an independent pinned-key
scratch file; a failure preparing that file still reports local removal and unconfirmed
remote cleanup. Scratch cleanup is attempted on both success and failure. Generated cleanup guidance uses
`hosts remove <machine-uuid> --transaction <enrollment-uuid> --json`; the transaction
guard refuses an old receipt rather than removing a newer enrollment. Ordinary removal
without this optional guard still removes the currently selected peer.
Disable retires the current owner generation;
dispatch refuses new work immediately, and the foreground owner notices changed
configuration within its ten-second maintenance interval. The sender checks local
authority again immediately before dispatch; revocation after dispatch cannot recall
an in-flight message or already accepted native work. A lost enrollment response retains one private
transaction: repeat the exact same add command to reconcile, rather than enrolling
under another name within the same enabled generation. Disable/re-enable or port
changes invalidate that recovery generation. Completed or revoked transactions cannot
restore a removed peer or erase another enrollment's recovery record.
If the saved local journal has malformed JSON, record shapes or field values,
`hosts add`, `hosts list`, `status` and `hosts abandon` refuse with
`invalid_enrollment_journal`. Its bytes are preserved for explicit operator recovery;
OpenCodex does not repair, replace or delete it automatically. `hosts add` sends no
enrollment control request in this case, although its preliminary host-key probe may run.
Unsafe storage or a busy mutation lock retains its separate error classification.
If a valid journal can no longer be reconciled, inspect `ocx message hosts list --json` or
`ocx message status --json` for `pendingEnrollment` (alias, transaction UUID and whether
its generation is stale), then explicitly abandon that exact local journal:

```bash
ocx message hosts abandon --transaction <pending-transaction-uuid> --json
```

Abandonment works while disabled too. It leaves existing peers unchanged, does not retry
enrollment and exits 3 because remote cleanup is unconfirmed. Follow its cleanup guidance
on the remote node if an orphan enrollment remains. Stale journals are not silently deleted.
A full receiver returns `peer_capacity` without enrolling; free a slot and repeat the same
transaction or explicitly abandon it. Malformed or lost control replies remain uncertain.
Existing trusted 0755 configuration homes are accepted without chmod; messaging's own
subdirectory remains private. An immediate owner restart can replace a stale return lease
after the new endpoint authenticates and the old endpoint no longer authenticates within a
one-second check. A still-authenticating old endpoint retains its lease until expiry;
temporary unreachability can permit takeover, not replay. Unexpected tunnel loss visibly
retires the foreground owner; deliberate peer removal leaves unrelated routes running.
Crash mutation locks fail closed and need operator recovery;
the wrapper never guesses that an old lock is abandoned.
State and recovery-journal publication sync the file and containing directory before dependent
remote work; journal removal also syncs its directory. `remote_storage_unknown` (exit 3) means
the storage change's crash durability could not be confirmed. On macOS, an ACL refusal or probe
failure after file replacement also reports this code: the new state is already visible, but its
ACL privacy and crash durability are unconfirmed. Inspect state and permissions before explicit
recovery rather than automatically retrying or rolling back. A safely readable journal with malformed
JSON or schema does not block peer removal, but is retained for operator recovery; unsafe storage and
failure to invalidate a matching journal still refuse removal.

The foreground owner shares finite connection/request/helper/buffer limits across
all peers and rejects overload without an unbounded queue: enrolled peers together may
hold twelve authenticated connections, four more stay reserved for the owner's own
control, outgoing probes and renewal, and at most eight tunnel
children and two transient control/inspection helpers, ten total. Setup is bounded by
30 seconds across the whole selected peer batch. A final lease renewal precedes startup
success. If SSH reports that a selected forward port was lost, setup closes the owned
pair and selects fresh ports, up to three attempts within that same deadline. SSH forward
confirmation, loopback checks and authenticated peer readiness must all succeed. Other
setup failures stop immediately; published routes do not reconnect automatically. Final
and periodic renewal batches have five-second deadlines, within the setup
deadline where applicable, and periodic maintenance runs every ten seconds.
Cancellation stops only owned
SSH helpers/listeners; it leaves Codex daemons, threads and unrelated proxies alone.
Cleanup joins withdrawn tunnel routes too. Direct-child exit and natural pipe EOF must
both settle within the three-second cleanup ceiling; otherwise cleanup is incomplete and
the helper reservation remains charged. Cancelling retained pipes does not prove descendants
exited. Detached descendants or descendants that close inherited pipes are not tracked.
Helper stdout capture is limited to 64 KiB; stderr is discarded without being printed or stored.
After capture overflow, the helper is stopped and discarded output is drained to natural EOF.
Successful cleanup reports the original output error; genuinely incomplete cleanup remains
`cleanup_incomplete` and keeps its helper reservation charged.
Same-uid processes can read private enrollment state; machine authentication does
not establish non-forgeable per-agent identity. Native traffic bypassing this gateway
is not controlled by it.

Mesh, dashboard/cache controls, isolation, Claude messaging, managed skills and
idle notifications remain outside this contribution.

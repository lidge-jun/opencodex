---
title: Codex Messaging
description: Queue correlated messages to loaded Codex sessions locally or through explicit SSH peers.
---

`ocx message` is an opt-in surface for existing Codex sessions.
It starts no proxy or app-server, resumes no thread and installs no skill.
Linux/macOS Unix sockets are supported; Windows fails explicitly. The existing
Codex daemon must support experimental `thread/queue/add`. No CLI version pin or
`CODEX_CLI_PATH` selection is required.

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

Each `serve` is foreground-owned: keep it running and use a separate terminal
for messaging. At most four distinct `--host` selections may be supplied. Nothing
installs a service or starts an owner automatically. SSH uses confirmed pinned
host keys and your configured keys/agent; password prompts are disabled. The
wrapper owns loopback-only forward and return routes, so the receiving node can
reply without an SSH login back to the initiator.

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
requires removal on that peer too. Generated cleanup guidance uses
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
If reconciliation is no longer possible, inspect `ocx message hosts list --json` or
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

The foreground owner shares finite connection/request/helper/buffer limits across
all peers and rejects overload without an unbounded queue: at most eight tunnel
children and two transient control/inspection helpers, ten total. Setup is bounded by
30 seconds across the whole selected peer batch. A final lease renewal precedes startup
success; final and periodic renewal batches have five-second deadlines, within the setup
deadline where applicable, and periodic maintenance runs every ten seconds.
Cancellation stops only owned
SSH helpers/listeners; it leaves Codex daemons, threads and unrelated proxies alone.
Cleanup joins withdrawn tunnel routes too. Direct-child exit and natural pipe EOF must
both settle within the three-second cleanup ceiling; otherwise cleanup is incomplete and
the helper reservation remains charged. Cancelling retained pipes does not prove descendants
exited. Detached descendants or descendants that close inherited pipes are not tracked.
Same-uid processes can read private enrollment state; machine authentication does
not establish non-forgeable per-agent identity. Native traffic bypassing this gateway
is not controlled by it.

Mesh, dashboard/cache controls, isolation, Claude messaging, managed skills and
idle notifications remain outside this contribution.

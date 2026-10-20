# Remote Codex messaging

The remote modules in `src/messaging/` implement explicitly enrolled Codex peers. The command
owner is `src/cli/message-remote-command.ts`, dynamically imported only after
`src/cli/message-remote-args.ts` accepts an explicit remote command. Normal proxy
startup, local messaging without a host, module imports and read-only peer listings
activate no listener, SSH process, persistent state or background timer. Explicit
read/list commands allocate only their bounded command deadline and signal handlers.

## Identity, capabilities and storage

`src/messaging/remote-store.ts` owns a separate private JSON subtree under the
selected OpenCodex configuration home. Explicit enable creates a stable machine
UUID, display name, loopback port and local-control capability. Enable does not
start a listener or daemon. Reads preserve absent state. Unknown fields, duplicate
identities/aliases/transactions and oversized state refuse rather than repair.
`src/messaging/remote-files.ts` verifies owned private directories, trusted
ancestors, bounded no-follow single-link files and fatal UTF-8. Root-controlled
OS directory aliases are allowed only with trusted resolved ancestors. An existing trusted
configuration parent may be 0755; only the owned messaging subtree must be 0700, and enable
does not chmod the existing parent.
Mutations acquire an exclusive directory lock and atomically publish private
files, syncing the file before rename and its parent directory before dependent work.
Creation persists new directory entries; journal removal also syncs the parent before reporting success.
A failed publication/removal directory sync reports `remote_storage_unknown`; the operation is not
automatically retried and the visible state is retained for explicit recovery. Crash locks are not automatically reaped by age. Filesystem calls are not
claimed to resist unrestricted same-uid access or privileged path replacement.

`src/messaging/remote-enrollment.ts` uses a private temporary offered known-hosts
file, an explicit confirmed fingerprint and the existing pinned SSH argument
builders in `src/link/ssh-argv.ts`.
Enrollment pins a transaction-and-attempt-qualified scratch file under the mutation
lock, releases the lock before SSH, and removes only that file in `finally` after
helper settlement without reacquiring the shared lock. Cleanup failure is an explicit
unknown storage outcome; it never discards the journal. Concurrent/abandoned attempts
cannot overwrite each other's pins.
The builders force `HashKnownHosts=no` for their private alias-prefixed records, independently
of the user's normal known-hosts policy.
Enrollment changes no Remote Link record, provider credential or client routing. Both nodes must already be enabled. Versioned
private SSH stdio exchanges receiver-issued capabilities independently in each
direction; ordinary CLI receipts omit them. Capability possession authenticates
an enrollment, not an individual same-uid agent session or user approval.
The SSH receiver authorizes the initiating machine's outbound delivery. The initiator
stores `allowInbound: false`: return transport is not consent for arbitrary inbound work.
Missing legacy policy is response-only. Local `hosts allow-inbound` / `deny-inbound`
changes only this node's current grant; peer control cannot widen it. Public listings
and enrollment receipts report local policy. Explicit broad consent admits all kinds
and loaded-session metadata; response-only admission exposes only opened reply targets.

One generation-bound saved enrollment transaction survives a lost remote reply. Repeating the
same add command reconciles the identical transaction and capabilities; a new
alias/identity cannot replace an existing peer silently. Local removal revokes
admission and forgets its matching journal before attempting remote cleanup. Completion
checks exact journal ownership under the state mutation lock; enrollment publication
precedes journal cleanup. Revocation instead invalidates its matching journal before
publishing peer absence; cleanup failure leaves the prior state and reports failure.
Malformed JSON/schema in an otherwise safely readable journal is nonmatching and cannot block
peer revocation: it cannot equal a valid in-flight journal. It remains available for operator
recovery. Unsafe/unreadable storage and failure to invalidate a matching journal still refuse.
An already-completed identical peer can converge without touching a
newer journal, but a missing journal cannot authorize adding a peer. Unconfirmed remote cleanup is reported
explicitly and never restores local authorization. Read commands do not enable,
create an identity, install software, rotate credentials or start the recipient.
Each outgoing revocation uses its own transaction-and-attempt-qualified known-hosts file after
local removal releases the mutation lock; concurrent removals cannot overwrite one another's
pinned keys. Preparation/SSH failure retains the local-removal receipt and explicit remote cleanup
guidance. Scratch removal runs in `finally`, best-effort, without undoing local revocation.

`src/messaging/remote-enrollment-recovery.ts` shares its strict local-journal parser with
enrollment retries. Malformed JSON, outer/nested schemas or invalid field values return
`invalid_enrollment_journal` with authored operator-recovery guidance; original bytes remain
untouched and no enrollment control exchange occurs (the preliminary host-key probe may run).
Safe reads and mutation locking remain outside that interpretation catch, preserving their
storage/busy errors. Recovery projects pending alias, transaction and stale generation only.
`hosts abandon --transaction` removes exactly the inspected journal under
the mutation lock, including while disabled; a different or missing transaction refuses.
It does not remove enrolled peers, retry enrollment or claim remote cleanup. Old completions
cannot publish from an abandoned journal or remove a replacement journal. Stale journals are
not automatically discarded. A correlated receiver capacity refusal carries no capability,
commits no new peer and reaches the initiator as `peer_capacity`, not an uncertain SSH outcome.
Generated cleanup commands include `hosts remove --transaction`; removal checks that exact
transaction under the mutation lock before changing state or contacting the remote node.
An old receipt therefore cannot revoke a replacement enrollment of the same machine.

## Connection-bound authenticated gateway

`src/messaging/remote-auth.ts` authenticates the actual IPv4-loopback WebSocket
using fresh nonces and direction-separated HMACs binding protocol, both machine
UUIDs and enrollment transaction. The client verifies the server proof before
sending its capability-derived proof or native/message frames. Raw capabilities
never enter URLs, upgrade headers, helper argv or normal errors. A previous health
probe or merely owning a port is not data-connection identity evidence.
There is no downgrade, endpoint substitution or automatic reconnect.

This protects against a replacement listener lacking the enrolled capability.
It is not encryption against an active transparent local intermediary; SSH owns
remote transport encryption and host authentication, and unrestricted same-uid
processes can already read private enrollment files. Raw native queue clients do
not implement this gateway handshake. The wrapper uses experimental native
`thread/queue/add`, not a message-bearing queue subprocess.

`src/messaging/remote-bridge.ts` binds only 127.0.0.1. Browser Origins, unsolicited
Authorization headers, unknown paths, binary/oversized frames and malformed proofs
refuse before native attachment. Each connection has a five-second authentication
deadline and maximum 30-second operation lifetime. `src/messaging/remote-rpc-admission.ts`
admits fixed initialization, loaded pagination, metadata-only read and text-only
queue schemas; lifecycle, turns, approvals, config writes and arbitrary pass-through
are absent. Native notifications/history/private fields are not forwarded.
The gateway records loaded IDs on that connection and revalidates the queue target
before native submission. Revalidation and submission remain non-atomic.
`src/messaging/remote-envelope.ts` reconstructs the canonical envelope from the
authenticated peer machine and validates exact text equality, UUID correlation, reply
host/command and standard guidance before native submission. Noncanonical/forged
wrappers refuse; session metadata remains descriptive, not authenticated session authority.
`src/messaging/remote-replies.ts` owns at most 256 reply grants, registered by local
control before request dispatch and bound to peer/enrollment/request/local sender.
Grants expire after 24 hours or owner restart; they are reserved synchronously before
queueing and consumed on queued/unknown, restored on definite native rejection.
An outgoing definite non-submission forgets its grant when control remains available.
No sender context creates no grant. Read filtering and queue admission recheck current
local consent; withdrawal affects already-attached clients. No automatic replay is added.

`src/messaging/rpc.ts` retains its Unix-only default connection factory. Its
explicit attach seam consumes an already-connected trusted transport without
broadening local URL acceptance. Native queue receipts retain exact RPC/message
correlation and text echo. A confirmed native rejection is relayed without raw
error text; an uncertain native write closes the gateway connection, leaving the
caller with unknown rather than a false not-sent error. No uncertain send is replayed.

## Foreground routes and aggregate ownership

> Decision record: [ADR-6480](decisions/ADR-6480-remote-messaging-owner.md)

`src/messaging/remote-owner.ts` owns one explicit foreground listener and at most
four peers. An initiating owner establishes separate owned -L/-R children through
`src/messaging/remote-tunnels.ts`; both reuse the shared pinned argument builders.
Ready is published only after the pair, peer identity, native initialization and
return-route registration succeed. A return-only receiver needs no SSH credential.
Generation-bound return leases expire after 25 seconds and refresh every ten
seconds while the initiating owner is alive. Leased is not a processing receipt
or a guarantee that the target stays connected; every data connection proves identity.
An unexpired generation cannot be displaced while its old return endpoint still authenticates.
A conflicting new lease is probed first; a bounded one-second authentication check of the old
endpoint permits takeover only on authentication failure or timeout, with current-peer and
route-identity rechecks. Local cancellation/capacity failures do not authorize takeover.
Transient old-endpoint unreachability can allow takeover; lease generation is not individual
session authority. Initiated routes remain conflicts.
`src/messaging/remote-ports.ts` refuses public reverse binds, including sshd
GatewayPorts configurations. Port selection alone does not prove readiness.
Linux inspection requires the IPv4 listener table; only an absent IPv6 table is treated as
empty. Permission, read and other inspection failures remain fail-closed.

Authenticated connections alone consume the shared connection budget. A separate
four-socket pre-authentication set retires its oldest unverified socket on overflow,
so silent clients cannot reserve owner/renewal slots or hold all fresh proof admissions.
Proof verification precedes promotion; unverified hello identities earn no privileged slots.
Authenticated enrolled peers together hold at most twelve connections; the remaining four are
kept for this node's own local control, outgoing probes and lease renewal, so peer sockets
cannot starve those owner paths. There is no per-peer share: one enrolled peer can still occupy
all twelve and refuse admission to another peer's probe or lease, and because lease-refresh
failures retire the owner (below), an initiated peer can end the owner. That is the fail-fast
owner contract between explicitly enrolled peers, not a capacity guarantee.
This is bounded admission, not protection against unlimited same-host traffic/CPU flooding.

The owner shares fixed total limits across peers and both route directions:
16 connections, 32 active/pending requests, ten helpers (eight persistent tunnel children
plus two transient control/inspection children) and 2 MiB accounted
retained output/input buffers. Per-connection RPC concurrency is four; frames are
at most 1 MiB, captured helper stdout 64 KiB and persistent state 128 KiB. stderr is discarded
without retention or a cumulative lifetime capture limit. There is no
overload waiting queue. Capacity is reserved before tracked work and released once.
Transport/parser buffers have their separate fixed frame/connection bounds; the
2 MiB counter is not a measurement of the runtime's total heap usage.

Setup shares one 30-second batch deadline across peers and both directions. All initiated
return leases receive a joined final renewal before startup succeeds; that round stays
within the original setup deadline. Final and periodic renewals are bounded to five seconds,
with a ten-second maintenance interval, preserving headroom within the 25-second lease.
`src/messaging/remote-process.ts` propagates
cancellation through owned process groups, sends TERM and (while the leader remains alive)
KILL, and cancels retained
pipes. Idempotent stop joins the same cleanup flight; helpers close in parallel
under a three-second cleanup ceiling. Cancelled helper operations settle after that
cleanup flight even if direct-child exit or natural pipe EOF remains unresolved; such helpers
retain their reservation and report incomplete cleanup, not proven absence. Cancelling a
pipe is not natural EOF. A historical process-group ID is not signalled after its leader exits;
descendants that detach or close inherited pipes are outside the observed child/pipe guarantee.
Stdout capture overflow/exhaustion preserves its first authored error, discards further bytes and
continues reading both pipes to natural EOF. Successful cleanup releases the helper reservation;
genuinely incomplete cleanup retains it and reports `cleanup_incomplete` with the original error
as its sanitized cause, rather than concealing cleanup failure behind the capture error.
Published tunnel
pairs remain owned after route withdrawal, so owner shutdown joins their cleanup and
reports its failures. Existing daemons, proxies and unrelated SSH clients
are never signalled. Owner generation changes and lease-refresh failures retire
the owner; restarting it is explicit and never replays a message.
Unexpected published tunnel exit withdraws its exact route and retires the owner after joined
cleanup. Deliberate peer removal withdraws the route before closing its helpers and does not
retire unrelated routes.

## Remote attribution and evidence

`src/messaging/remote-send.ts` resolves sender context on the source's existing
local daemon and the target on one proven destination connection. The shared
envelope includes a machine UUID in the wrapper-generated reply command, never
routing from a peer body. Missing sender context produces no invented reply route.
Sender identity remains descriptive, not session authentication or delegated authority.
Source admission rechecks enabled generation, machine and exact peer capabilities
after route lookup, before transport attachment and immediately before queue dispatch.
Revocation after dispatch cannot recall a message in flight; queued/unknown semantics
remain unchanged. Loaded discovery also rejects source authority changes during lookup.
Receipts preserve not_sent/queued/unknown and omit body/native output. Queued means
submission, not processing, and may wait for a busy turn to finish.

Offline contracts live in `tests/codex-integration/messaging-remote-contract.test.ts`,
`tests/codex-integration/messaging-remote-store.test.ts`,
`tests/codex-integration/messaging-remote-enrollment.test.ts`,
`tests/codex-integration/messaging-remote-send.test.ts` and
`tests/codex-integration/messaging-remote-lifecycle.test.ts`.
Helper settlement and persistent/transient capacity contracts live in
`tests/codex-integration/messaging-remote-process.test.ts`.
Opt-in `tests/codex-integration/messaging-remote-interop.test.ts` qualifies a
disposable loopback sshd with generated keys, isolated homes and strict native
fixtures. `tests/codex-integration/messaging-remote-native.test.ts` qualifies an
explicit native artifact with a credential-free home and synthetic model provider.
These are distinct receipts, not claims about production hosts or model compliance.
Linux evidence does not attest macOS interoperability; Windows remote transport
is unsupported. Mesh, dashboard, cached discovery, isolation, cross-harness
messaging, managed skills, prompt policy and idle watches remain outside this slice.

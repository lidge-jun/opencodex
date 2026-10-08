# ADR-6478 — decision recorded under "Local Codex messaging foundation"

- Contract owner: [local-messaging.md](../local-messaging.md#local-codex-messaging-foundation)
- Status: original transport choice superseded by the amendment below; contribution remains provisional.

## Decision record

Intent: prepare exact local Codex discovery and caller-owned queued submission
as a separately reviewable first contribution following issue #6478's direction.
The broader local experiment includes persistent stores, remote authentication,
SSH enrollment, Claude, dashboard, isolation and idle semantics; carrying it
wholesale would prevent review of the small native boundary independently.

Alternatives: carry the existing runtime/bridge and disable remote features;
add metadata discovery to proxy startup; or construct a standalone, command-owned
foundation with no startup import. The third option is implemented first, without
registering a public command while transport and fixture contracts are tested.

Choice: existing local Unix control socket, metadata-only loaded-session discovery,
exact unique selection, one operation deadline and bounded disposable resources.
Use the native queue CLI for later submission rather than reimplement its write
protocol. The isolated native fixture establishes the CLI transport/queue shape,
not actual agent processing or supported versions beyond the tested binary.

Consequences: the ordinary proxy path has no messaging work or persistence;
incomplete discovery fails instead of choosing a possibly ambiguous name.
Initial platform scope excludes Windows. CLI integration, receipt/envelope
semantics and their documentation remain subsequent bounded work. Starting the
foundation does not authorize a PR, deployment or the broader architecture.

## Transport amendment

The current contract uses experimental `thread/queue/add` directly on the same
validated Unix connection used for discovery and final revalidation. Text stays
in RPC frames, and daemon identity stays bound to that connection. The receipt
UUID is also `clientUserMessageId`. The historical CLI choice and version pin
above no longer apply: the daemon must support this method. No submission helper,
CLI selection or version probe remains. Filesystem trust checks precede connection.
A confirmed server rejection is `not_sent`; an uncertain post-write result is
`unknown` without retry. This amendment preserves the original record as history.

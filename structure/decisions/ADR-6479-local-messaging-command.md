# ADR-6479 — decision recorded under "Command-local CLI"

- Contract owner: [local-messaging.md](../local-messaging.md#command-local-cli)
- Status: original transport choice superseded by the amendment below; contribution remains provisional.

## Decision record

Intent: complete the independently reviewable local Codex slice requested in
issue #6478, without importing the deployed remote/cross-harness implementation.

Alternatives: queue directly over custom RPC; reuse the live native config for
helper launches; allow any runtime exposing similarly named help flags; or use
the native queue CLI with a quarantined home and an exact tested version.

Choice: command-local discovery and one native queue invocation. Require tested
Codex 0.160.0 plus queue/Unix help checks. Resolve one runtime without persisting
selection, pass the existing daemon's explicit Unix address, and give helpers
no agent credentials or live configuration. Keep stdin/envelopes bounded.

Application UUIDs correlate wrapper requests and responses. They are not native
queue IDs, processing acknowledgements or authenticated peer authority. Preserve
not_sent before invocation, queued on native success and unknown after possible
submission. Never retry or resume a session to deliver a message.

Consequences: only loaded local sessions are addressed; Windows and untested
versions fail explicitly. Other native versions need separately recorded contract
tests before admission. Same-user processes can inspect native message argv.
Remote, dashboard, Claude, idle notices, permission semantics and
managed skill installation remain separate proposals. PR publication requires
the user's go-ahead; independent review remains a separate readiness gate.

## Transport amendment

The current contract uses experimental `thread/queue/add` directly on the same
validated Unix connection used for discovery and final revalidation. Text stays
in RPC frames, and daemon identity stays bound to that connection. The receipt
UUID is also `clientUserMessageId`. The historical CLI choice and version pin
above no longer apply: the daemon must support this method. No submission helper,
CLI selection or version probe remains. Filesystem trust checks precede connection.
A confirmed server rejection is `not_sent`; an uncertain post-write result is
`unknown` without retry. This amendment preserves the original record as history.

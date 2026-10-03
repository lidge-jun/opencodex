# ADR-6479 — decision recorded under "Command-local CLI"

- Contract owner: [local-messaging.md](../local-messaging.md#command-local-cli)
- Status: provisional contribution implementation, not upstream acceptance.

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

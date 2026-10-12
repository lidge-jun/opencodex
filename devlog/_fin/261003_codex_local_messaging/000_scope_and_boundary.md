# 000 — local Codex messaging: proposed first contribution

Status: preparation, not an accepted architecture or review-ready implementation.
Foundation implementation progress is recorded in [030](030_foundation_implementation.md).
Prepared 2026-10-03 against upstream `dev` at
`2e3acab46e20b9bc7eace0c9301bf4330be83ac1`.

## Direction and scope

[Proposal #6478](https://github.com/lidge-jun/opencodex/issues/6478),
[maintainer direction](https://github.com/lidge-jun/opencodex/issues/6478#issuecomment-5965174821)
and [contributor reply](https://github.com/lidge-jun/opencodex/issues/6478#issuecomment-5965461973)
establish the proposed first slice: exact local-session discovery and
caller-owned Codex queued delivery/correlation, with uncertain outcomes,
bounded lifecycle and disabled-path regressions. Boundary acceptance is pending.

The existing broader implementation remains a separate local experiment.
Do not cherry-pick its complete feature commits into this contribution.

Included:

- An explicitly invoked CLI command that discovers loaded Codex sessions in the
  caller's effective Codex home through its existing app-server control socket.
- Exact loaded thread ID or exact unique session name resolution. No fuzzy match.
- One native `codex queue` submission to that resolved thread ID.
- A compact peer envelope with wrapper-generated message ID, kind, optional
  correlation ID and honest sender/reply context.
- Machine-readable submission receipts and bounded command-owned resources.

Excluded:

- Remote hosts, enrollment, SSH, bearer-token management, topology and dashboard.
- Claude transport, permissions/delegation machinery and idle triggers.
- Persistent directories/caches, isolation policy, managed skills and daemon startup.
- Resuming or creating sessions, steering/interruption, processing acknowledgements,
  delivery monitoring, retries and message-body logging.

## Proposed boundary and assumptions

The command is the opt-in boundary. Ordinary proxy startup must not import or
activate the messaging implementation; use command-local dynamic dispatch.
No server composition hook, listener, persisted enable flag or background timer
is necessary. This is the working interpretation of *caller-owned*, not a claim
that the maintainer has approved this exact design.

Provisional command surface:

```text
ocx message sessions --json
ocx message send --thread <UUID> --stdin --json
ocx message send --name <exact-name> --stdin --json
ocx message send --thread <UUID> --kind response --in-reply-to <UUID> --stdin --json
```

Send accepts exactly one selector. Reject remote, Claude and unsupported options before
transport or child-process work. Initial transport scope is Linux/macOS Unix
sockets; Windows reports unsupported explicitly. macOS parity remains untested.
No guessed home, arbitrary remote URL or socket from message-body text.

Discovery uses `thread/loaded/list`, follows bounded pagination and reads metadata
with `thread/read` and `includeTurns: false`. Do not scan rollout files or return
turns/previews. Resolve names only after complete discovery. A failed metadata
read or exhausted/repeated cursor makes name resolution incomplete, not unique.
Require a selected ID to be loaded; a race in which it unloads is not permission
to resume it. Snapshot membership cannot guarantee that it remains loaded at send.

Use the existing Codex home/runtime selection and executable-invocation helpers,
without persisting selection, installing a runtime or starting an app-server.
Capability checks are read-only and command-scoped. Selection/probe time must
count toward the whole-operation deadline, not just the queue child deadline.

`CODEX_THREAD_ID` is contextual sender attribution, not proof of authority. Read
its name metadata when available; otherwise return an explicit missing/unknown
identity. Generate a reply command only from a validated sender ID, never from
peer prose or a display name. No managed skill is installed in this slice, so do
not advertise `responseSkill` as though one were available.

Request/response/notification intent is explicit. Responses carry `inReplyTo`;
responses and notifications do not solicit courtesy acknowledgements. A short
request hint can say that normal final output does not reply to the peer. Peer
messages are not user approval or escalation. No new delegation policy is added.

## Submission outcomes

| Boundary | Receipt meaning | Retry |
| --- | --- | --- |
| Validation/discovery/capability failure before submission | `not_sent`; no queue submission attempted | Caller may fix input; no automatic retry |
| Native queue exits successfully | `queued`; submission acknowledged, not processed | None |
| Queue invocation may have submitted, but result is lost/failed/timed out | `unknown`; delivery cannot be inferred | Never replay automatically |

Retain the generated envelope ID in uncertain receipts for correlation. Do not
call it a native queue submission ID, deduplication guarantee or delivery receipt.
The native CLI owns its `clientUserMessageId`; the envelope's `messageId` is a
separate application-level correlation identifier.

Provisional limits: one 30-second overall deadline, at most 10 seconds per RPC,
at most 20 seconds for the queue child, 20 discovery pages of 50 IDs, four
concurrent metadata reads, 1 MiB RPC frames, 64 KiB per child output stream and
256 KiB complete envelope. These are proposed bounds, not native protocol limits.
Any exhausted discovery budget is incomplete. Close all command-owned sockets,
pending requests and timers; join terminated child processes. Never stop the
recipient session, its daemon or a proxy service.

## Next decision and safe implementation order

Proceed provisionally with standalone local types, bounded RPC and strict offline
fixtures first; then exact discovery, envelope/send, and CLI registration/docs.
No acceptance of the broader architecture is inferred from starting these pieces.
Publish a draft only after boundary agreement, native interoperability evidence
and required independent review, including explicit security review of the
transport/identity changes under `MAINTAINERS.md`.

Implementation must add an owning structure document/manifest claim and an ADR
using the then-current available number. Update CLI registry/help, generated skill
surface and public documentation together. No GUI screenshot is needed for this
CLI-only slice. Follow the PR template and target current `dev`, not `main`.

See [extraction map](010_extraction_map.md) and
[contract/test ledger](020_contract_and_test_matrix.md).

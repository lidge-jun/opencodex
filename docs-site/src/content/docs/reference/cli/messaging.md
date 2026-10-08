---
title: Local Codex Messaging
description: Discover loaded local Codex sessions and submit one correlated queued message.
---

`ocx message` is an opt-in, command-local surface for existing Codex sessions.
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

No remote hosts, bearer management, SSH, Claude messaging,
dashboard, isolation or idle-notification controls are part of this surface.

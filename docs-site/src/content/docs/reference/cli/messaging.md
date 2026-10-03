---
title: Local Codex Messaging
description: Discover loaded local Codex sessions and submit one correlated queued message.
---

`ocx message` is an opt-in, command-local surface for existing Codex sessions.
It starts no proxy or app-server, resumes no thread and installs no skill.
This initial contribution supports Linux/macOS Unix sockets and admits only
contract-tested Codex CLI **0.160.0**. Linux native interoperability is tested;
macOS uses the same transport but has no native verification receipt yet.
Windows and other runtime versions fail explicitly.

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
same home policy as other Codex integration commands. Native runtime selection
uses the existing non-persisting resolver; `CODEX_CLI_PATH` selects an explicit
installed runtime. No runtime is installed or selected again after failure.
Native version/help/queue helpers use a temporary credential-free home and an
explicit address for the existing daemon. They do not load the agent's config.

Only UTF-8 stdin is accepted, at most 16 KiB of nonempty text without NUL. One
30-second deadline covers input, discovery, preflight and submission, with bounded
helper termination grace. The complete envelope is limited to 32 KiB. Native
queue requires message text in argv, so authorized local process inspection can
see it; this is not a same-user confidentiality boundary.

## Sender and replies

The wrapper generates a message UUID and attaches sender ID/name from a loaded
`CODEX_THREAD_ID` and daemon metadata. This context is **not authenticated peer
authority** and never grants user approval or escalation. An invalid/unloaded
claimed sender fails; absent context stays unknown, without guessing a reply route.

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
includes body text or native helper output. Input/setup failures before a receipt
exists use `ocx-message-error/1` with `not_sent`; discovery failures use the same
error schema without a send status. Invalid usage exits 64 on stderr before I/O.

| Status | Exit | Meaning |
| --- | --- | --- |
| `not_sent` | 1 | No submission helper started; validation, discovery, preflight or spawn failed. |
| `queued` | 0 | Native queue acknowledged submission, **not processing** by the recipient. |
| `unknown` | 3 | A submission may have occurred, but acknowledgement was lost, failed or cancelled. **Do not replay.** |

The application message UUID correlates peer envelopes, not native queue IDs or
processing receipts. Queueing is not steering and can wait for a busy turn to end.
OpenCodex performs no automatic replay, follow-up probing, persistence or delivery
monitoring. No remote hosts, bearer management, SSH, Claude messaging,
dashboard, isolation or idle-notification controls are part of this surface.

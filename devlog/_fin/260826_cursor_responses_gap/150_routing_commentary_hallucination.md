# 150 — gap-11: invented Read/Grep/Shell failures in code-mode commentary

## Symptom

Session 01a03cdb-cdfd-75d3-b8d3-cc3b3deb8d27, model
cursor/kimi-k3-1m, 2026-08-26. The model repeatedly stated that native
Read, Grep, or Shell calls were blocked and that it was switching to
exec_command. It later concluded that a Codex harness content guard was
intercepting file contents.

## Evidence and rejected hypotheses

- **H1 — Codex harness content guard. Rejected.** At 07:06:44Z the actual
  exec tool called nested exec_command with head -c 200; the
  CommandExecution event completed exit 0 and the output reached the model.
  At 07:06:56Z a heading extraction command also completed and reached the
  model. There was no substituted or interrupted tool result.
- **H2 — native Read/Grep/Shell calls failed. Rejected.** The session NDJSON
  contains 11 custom_tool_call rows and every one has name=exec.
  Its item_completed inventory contains 11 CommandExecution rows and zero
  native Read/Grep/Shell execution rows.
- **H3 — model-generated routing commentary. Supported.** At 07:06:44.201Z
  the model emitted “Shell path was blocked; switching to exec_command”; the
  real exec tool call followed at 07:06:44.203Z and succeeded. The claimed
  failure therefore preceded any corresponding tool call and could not be a
  report of runtime state.

The static code-mode system note already forbids these tool names and this
commentary shape (tool-definitions.ts), so another prompt-only sentence is
not a useful repair: the model ignored the existing exact instruction.

## Fix

- Add CursorRoutingCommentarySniffer beside the existing gap-10 envelope
  sniffer. It is armed only for external Cursor models when the active catalog
  exposes code-mode exec or a Codex shell bridge.
- Quarantine the bounded first output line. Reject only a failure claim that
  also contains either (a) an explicit redirect to a bridge/execution surface,
  or (b) two distinct unavailable native-tool names. This avoids treating a
  legitimate sentence such as “Shell is unavailable on this OS” as fabricated
  routing history.
- Before any invalid delta reaches the client, rotate to a fresh conversation
  and retry once with a corrective active-turn note. A second rejection fails
  closed instead of looping.

## Verification

- RED: adapter regression expected two attempts but observed one; the invented
  Shell commentary leaked unchanged.
- GREEN: tests/cursor-envelope-echo-retry.test.ts covers fragmented Korean
  fallback commentary, multi-tool failure claims, legitimate prose, adapter
  retry, no leaked commentary, and the existing envelope cases.
- Focused suite: 54 pass / 0 fail across output quarantine, tool definitions,
  repetition breaker, silent redirect, and tool continuation tests.
- Live verification after ocx service repair on the gap-11 branch:
  - Fresh codex exec session with cursor/kimi-k3-1m: first visible action was
    the real command execution (cat /tmp/ocx-routing-live.txt), exit 0; final
    response was LIVE_ROUTING_OK=ROUTING_LIVE_7391; no tool-selection prose.
  - Adversarial raw Responses batch seeded the prior assistant history with the
    false blocked/switching sentence: 10/10 HTTP 200, each returned one real
    exec custom tool call, zero leaked Read/Grep/Shell failure commentary.

## Independent review closure

- Reviewer found that a failure claim split as “Shell was blocked” + newline +
  “Switching to exec_command” could flush after the first line. The sniffer now
  holds an incomplete first-line failure claim for one additional line.
- Reviewer found a context-free request redirection sentence could match without
  naming a native tool. Detection now requires at least one unavailable native
  tool name in addition to the failure claim. Both cases have direct tests.

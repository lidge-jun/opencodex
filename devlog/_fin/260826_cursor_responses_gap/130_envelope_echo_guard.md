# 130 — gap-10: external replay [Tool Result] envelope echo priming

## Symptom

Live probe (dev head 58f5a294e, service :10100, 2026-08-26): multi-round tool-call
replay probe (`/tmp/ocx_qa/replay_probe.py`) against `cursor/kimi-k3-1m`,
7 total runs. 2 runs failed the same way: instead of issuing the next
`run_cmd` call, the model emitted the replay envelope as its OWN text:

```
[Tool Result]
[tool_result]
call_id: run_cmd_0_9c0e7f7a-3e3e3
name: run_cmd
is_error: false
output:
R1=...
```

`cursor/grok-4.6` passed the same probe consistently (no echo observed).

## Root cause

External full-replay flattens tool results into assistant-role
"[Tool Result]\n[tool_result]\ncall_id: ..." text (needed so Cursor does not
wrap them as `<user_query>`, #1992). After a few rounds the transcript
contains N such assistant-role blocks, and a mimicking model treats the
envelope as an expected assistant output format — the same few-shot priming
mechanism as the gap-9 repetition loop, but for the envelope itself.

## Fix (v2 — detection + corrective retry)

v1 (prompt-side guard note) was measured INEFFECTIVE live: 2/7 echo runs
before, 3/7 after — repeating the trigger strings inside the prompt does not
stop few-shot mimicry. Superseded by an observation-boundary fix (sol-high
design review, option A):

- `src/adapters/cursor/envelope-echo.ts`: incremental prefix sniffer
  (`CursorEnvelopeEchoSniffer`) holds the first assistant text deltas (max 40
  sniff bytes, 8 KiB hold cap) until they provably diverge from
  `[Tool Result]` / `[Tool Error]` / `[tool_result]`. A completed marker
  throws `CursorToolResultEchoError` before any client-visible delta escapes.
- `cursor.ts` `runOnce`: sniffer armed only for external wire models whose
  trailing input is a toolResult. On echo: one corrective retry in a fresh
  conversation (`forceFreshConversation` + rekey/remember, same recovery path
  as the invalid_argument fallback) with
  `echoRetryContinuationText` = `CURSOR_ECHO_RETRY_CONTINUATION_TEXT` as the
  active userMessageAction text (rawMessages untouched). A second echo
  propagates as an error instead of looping.
- `protobuf-request.ts`: `buildPreparedCursorRunRequest` uses
  `request.echoRetryContinuationText` over
  `CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT` when set. The corrective text
  deliberately does NOT contain the marker strings.
- v1 static guard note removed.

## Verification

- `tests/cursor-envelope-echo-retry.test.ts`: fragmented-marker detection,
  divergence flush, single corrective retry with rotated conversation id and
  corrective action text, double-echo error (no loop), non-echo continuation
  unaffected, plain user turns never arm the sniffer. 5 pass.
- Focused cursor suite (36 tests across 7 files) green; `bun x tsc --noEmit` clean.
- Live re-probe after service repair: kimi-k3-1m replay probe batch —
  acceptance is zero envelope-leak finals across the batch.

## Non-adapter residual (recorded, not fixed here)

1 of 7 runs failed differently: R1 answered "STATE A17" without issuing the
tool call first (premature final on a fresh conversation with zero replay
history). That is model nondeterminism on instruction-following, not a replay
artifact; no adapter change targets it.

## v3 probe round (post detection+retry, trailing-toolResult arming only)

8 runs: 5 pass, 3 fail — 2 envelope leaks happened on USER-action rounds
(round prompt sent after a completed prior round), which the initial arming
condition (`lastRawIsToolResult`) did not cover; the envelope lives in the
flattened history regardless of the trailing role. Arming widened to any
external turn whose history contains a toolResult; user-action retries append
the corrective note to the active user text instead of replacing it.
One additional fail was a 30s zero-output R1 timeout (fresh conversation,
no replay) — tracked separately with the zero-output watch item (gap-10
candidate list), not an echo.

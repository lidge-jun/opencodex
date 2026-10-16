# 020 — #6984: verify #6986, then bound its post-EOF drain

## 1. Verification of #6986 (lane L1)

#6986 (owner PR, in L1's bundle as `1c1e6c994d`) states "Closes #6984" and patches
`src/claude/intercept/picker-listener.ts`: a closing h1 reply replaces the socket's `destroySoon` with
resume + graceful `end()`, the TCP front sets `allowHalfOpen`, and on backend `end` unpipes and resumes
the client so the abandoned upload keeps draining.

Baseline at `origin/dev` `3e58c2ce3e`, `tests/claude-integration/claude-picker-upload.test.ts -t refusal`
(`OCX_TEST_NO_QUEUE=1 <bun> test --isolate ...`): Bun 1.4.0 8/0; Bun 1.4.3 6/2 (buffered h1 400/503:
`read ECONNRESET`); Bun 1.4.2 (darwin) buffered h1 503 hits the 4 s test deadline.

At #6986 head `ad1540aa43` (scratch checkout): the full upload file passed 22/0 in three runs each on
Bun 1.4.2 and 1.4.3.

## 2. Coordinator decision

First plan: no listener change here (it would conflict with L1). The coordinator then approved a
stacked commit on L1's restacked head `1e4d9dad9a`: keep reply delivery and `Connection: close`, stop a
trickling peer from holding the socket indefinitely, keep `claude-picker-upload` green on Bun 1.4.2 and
1.4.3, and add a deterministic regression test (fake timers or an injected clock, no timeout increases).

## 3. Change — commit `5e943bfe69` ("Refs #6984")

- `PICKER_ABANDONED_INPUT_LINGER_MS = 30_000`. After the backend ends a spliced connection, the front
  still unpipes and discards client input, and once the reply has been flushed to the client socket
  (`finish`) it arms a drop after that budget; the connection's `close` (including listener shutdown,
  which destroys tracked sockets) cancels it.
- Limits: `finish` is local flush, not peer receipt — a peer that also stops reading for the whole
  budget can lose unread reply bytes when the drop fires (verified by the reviewer with an immediately
  fired injected drop and a paused reader: `ECONNRESET`, 0/131,072 body bytes). A reply whose flush
  stalls never reaches `finish`, so the budget is not an absolute connection-lifetime deadline.
- Test seam `scheduleAbandonedInputDrop(drop, ms) => cancel`; production passes none and uses a timer.
- `tests/claude-integration/claude-picker-linger.test.ts`: a half-open TLS client (`allowHalfOpen: true`)
  that never stops uploading gets the 400 with `Connection: close`; the drop is armed exactly once
  with the production budget; the connection is still open after 64 more flushed chunks; firing the
  drop closes it; a client that disconnects cancels the armed drop. No wall-clock thresholds.
  Mutation (arming removed): 0 pass / 2 fail.
- Bun 1.4.0: an instrumented run (`L3-linger-debug.ts`, lane scratch) showed the front socket closing
  about 0.2 ms after the reply, cancelling the drop, so the "still open" assertion does not hold there
  and the new tests were not claimed to pass on 1.4.0. The repository pins `testRunnerBun` 1.4.3.
- `structure/clients/claude-desktop.md` transport section updated (request-side drain still has no
  deadline; the front-side discard is bounded, with the limits above).

## 4. Verification at `5e943bfe69`

`/private/tmp/rt284-lanes/status/L3-gates2.sh` (exit 0; recorded with `cxc receipt test`):
`bun run typecheck` 0; Bun 1.4.2 `claude-picker-upload` + `claude-picker-linger` 24 pass / 0 fail;
Bun 1.4.3 same files 24/0; Bun 1.4.3 deferred/code-mode collab, multi-agent compat, effort policy,
combo-failover e2e 366/0; Bun 1.4.3 test-layout, test-layout tooling (pinned runner), file-size
ratchet, repo hygiene, structure SSOT, skill-ocx 110/0; `bun run structure:check` 0;
`bun run privacy:scan` 0; `layout.json` 1999 lines. The same gate script, run again at the docs commit
that follows, also exited 0. Independent reviewer evidence is from `465207459c`, the head before the
wording-only amend that produced `5e943bfe69`: it re-ran upload + linger 24/0 on Bun 1.4.2 and 1.4.3,
151/0 with `OCX_TEST_NO_QUEUE=1 /Users/jun/.cache/rt284-bun/bun-darwin-aarch64/bun test --isolate
tests/codex-integration/deferred-collab-surface.test.ts tests/codex-integration/code-mode-collab-surface.test.ts
tests/claude-integration/claude-picker-listener.test.ts tests/test-layout.test.ts
tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts` (Bun 1.4.3), plus
typecheck, structure and privacy (exit 0). It then reviewed the `465207459c`→`5e943bfe69` delta as
wording-only and returned PASS without reruns.

`bun run test:changed` (dev merge base, so it covers L2 + L1 + L3; 1861 files): **non-green, 40,452
pass / 20 fail**. Failing cases: `tests/codex-integration/native-grok-toggle.test.ts` (GET reports absent
when no fence exists; a foreign-home install state refuses disable…; a second concurrent PUT gets 409
config_busy…; disable removes only the fence…; disable → enable → disable…; the ownership preflight
itself is reachable…; toggling to the current state changes nothing), `native-codex-toggle.test.ts`
(enable inspects the fixture's service-manager evidence; the status read follows an off-then-on round
trip…), `tests/service/service-ownership-state.test.ts` (claiming with no install state…; exhausted
revision refuses…), `tests/service/service-sqlite-home.test.ts` (four Codex SQLite home binding cases),
`tests/service/service.test.ts` (two service diagnostics staleness cases) and
`tests/cli/cli-access-audio-live.test.ts` (native open and non-readiness events…, three 5 s timeouts).
Isolation, `OCX_TEST_NO_QUEUE=1 <bun 1.4.3> test --isolate <file>` on both `5e943bfe69` and L1 `1e4d9dad9a`:
native-grok 24/0, native-codex 14/0, service-ownership-state 46/0, service-sqlite-home 5/0,
service 211/0, cli-access-audio-live 36/0 — identical on both heads. The combined run overlapped other
lanes' suites on the same machine; isolation passing does not prove the cause, and the combined-run
failures stay recorded for the coordinator's hosted CI.


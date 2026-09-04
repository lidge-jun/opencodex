# 020 — wp3: adapter_eof, diagnosed before it is patched

Consumes 000 Q2. This phase is a DIAGNOSIS phase whose deliverable may legitimately be
"no code change". Writing it as an implementation phase up front would presuppose a defect
the evidence does not yet support.

**Status: closed. The outcome is recorded in `021_wp3_evidence.md` — NOOP, cause
positively identified as a local `ocx service` restart that dropped in-flight streams.**
This document is kept as the investigation contract it was; the corrections below are the
round-1 audit's, folded back per REVIEW-SYNTHESIS-01.

## What is already established (000)

- `adapter_eof` is opencodex's own synthesized terminal, meaning "the adapter generator
  ended without a done/error event". **Three** emitters, not two (015/M1):
  [bridge.ts](../../../src/bridge.ts) streaming path, [bridge.ts](../../../src/bridge.ts)
  buffered path, and [relay.ts](../../../src/server/relay.ts); with a consumer at
  [combo-stream-preflight.ts](../../../src/server/responses/combo-stream-preflight.ts).
- `close_reason = 'adapter_eof'` has **0 rows for all time** in `routing-history.sqlite` —
  not merely 24h (015/H4). That is a warning about the instrument, not a clean bill of
  health: 25,493 rows carry a NULL `close_reason`, so the table may simply never record
  this condition. Absence alone therefore proves nothing, and 021 does not rest on it.
- Every `gpt-6-astra` row in history is a `502 upstream_server_error` from the 20:26
  pre-release probes, none of them an `adapter_eof`.
- The user's live session runs `anthropic / claude-fable-5-1` at ~853k total tokens, with
  a 45,900 ms turn whose first byte arrived at 45,877 ms.

Astra is therefore excluded as a cause. That is a finding, not an assumption.

## The question this phase must answer

Does opencodex DROP a stream it could have kept, or does it faithfully report an upstream
cut? Those have opposite correct responses, and the bridge comment already argues for the
second: synthesizing `response.incomplete` instead of `response.completed` is the whole
point of that code path, because reporting a truncated turn as clean is the failure mode it
exists to prevent.

## Investigation steps (ordered, each with its stop condition)

1. **Confirm the surface.** Determine whether the failing turn ran over SSE or the
   websocket sideband. `prefer_websockets` is true for the 5.6 family and Astra, and
   `experimental_realtime_ws_base_url` in `~/.codex/config.toml` points at the proxy, so
   the ws path is live. Stop when the transport is named with evidence.
2. **Find the drop point.** Candidates, corrected by the audit (015/H3):
   - **The stall watchdog in [bridge.ts](../../../src/bridge.ts)** (`stallTicks >=
     maxStallTicks`, `resolveStallTimeoutSec`). This is the leading local suspect and the
     first draft wrongly omitted it by casting `bridge.ts` as only the reporter. A byte-idle
     timeout is exactly the shape that ends a generator without a terminal, and 000 records
     a 45,877 ms time-to-first-byte on this very session.
   - The empty-completion guard in
     [empty-completion-guard.ts](../../../src/server/responses/empty-completion-guard.ts).
   - SSE record handling in [sse-decoder.ts](../../../src/lib/sse-decoder.ts), whose own
     comment warns that dropping a record turns a success into an adapter_eof.
   - [outbound.ts](../../../src/chat/outbound.ts) is **reclassified**: it translates an
     already-synthesized incomplete for chat-completions clients. A downstream consumer,
     not a drop point, and not on the path for a Responses client at all.
   Stop when a reachable local drop is identified, or all are excluded.
3. **Correlate with context size** — only if step 1-2 leaves the cause open, and only after
   establishing that the history table can record the condition at all (015/H4). If the
   drop appears only at very large contexts, that is an upstream/transport limit, and the
   honest outcome is NOOP with evidence rather than a retry loop that hides truncation.

## Decision rule (written before the evidence, on purpose)

- **Local defect found** (opencodex discards a stream it holds a terminal for, or
  mis-parses a record): fix it, with a regression test that goes red without the fix.
  Verify by mutation.
- **Upstream/transport cut confirmed**: outcome is **NOOP**. Record the evidence in
  `030_outcome.md`. Do NOT add a silent retry or downgrade the incomplete to completed —
  that would trade a visible truncation for an invisible one, which is exactly what the
  bridge comment forbids.
- **Inconclusive**: outcome is **BLOCKED**, naming what evidence was unavailable. Note that
  a blind instrument (H4) pushes toward BLOCKED, not NOOP — NOOP requires a positive
  finding, which is what 021 supplies.

## Scope boundary

IN: read-only diagnosis across the bridge/adapter/transport path, plus a narrowly scoped
fix ONLY if step 2 finds a local defect. OUT: retry-policy redesign, reconnection UX,
any change to how `adapter_eof` is reported to the client, and anything touching the
Astra catalog work in 010.

## Accept criteria

1. The transport of the failing turn is named with evidence.
2. Each of the three candidate drop points is either implicated or excluded, each with a
   `file:line` citation.
3. A terminal outcome is recorded in `021_wp3_evidence.md` — the decade slot `030` belongs
   to the merge phase (015/M2). Either a fix plus a red-without-it test, or NOOP/BLOCKED
   with the evidence that supports it.
4. If a fix lands: `bun run typecheck` exit 0 and the touched suites 0 fail.

### Verifier reality check (PLAN-VERIFIER-REAL-01)

- `sqlite3 ~/.opencodex/routing-history.sqlite` queries — RUN this session; returns the
  rows quoted in 000. The schema's time column is epoch-ms `timestamp`, not `created_at`
  (015/M4). Observes the target (the actual failing traffic). YES.
- `rg -n 'adapter_eof' ~/.opencodex/service.log` — RUN this session; zero matches. This
  command does NOT establish that the emitter logs to that file, so its emptiness is not
  evidence on its own (015/H4). Retained only as a negative check alongside 021's positive
  timeline evidence.
- `bun test` on a responses/bridge suite — deferred: naming a specific file before step 2
  identifies the code path would be inventing a gate. Recorded as unresolved rather than
  claimed.

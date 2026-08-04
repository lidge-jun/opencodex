# 040 — Phase 4: Heartbeat / stall consistency (class 11)

One PABCD cycle. Hardening: upstream keepalive must reset the stall clock;
dead heartbeat code must be resolved one way or the other.

## Scope

IN:
- src/lib/sse-decoder.ts (optional comment/activity notification)
- src/adapters/anthropic.ts + src/adapters/google.ts (wire activity ->
  AdapterEvent heartbeat)
- src/bridge.ts (confirm heartbeat resets the adapter-activity clock; fix
  if it does not)
- src/server/relay.ts (relaySseWithHeartbeat dead code resolution)
- tests: sse-decoder, bridge-lifecycle (stall), anthropic/google stream
  suites

OUT: stall-timeout default tuning (300s stays), native passthrough
synthetic heartbeat wire-change (byte-verbatim contract; see decision
below), Cursor/Kiro (already emit heartbeat events).

## File change map

### 1. src/lib/sse-decoder.ts — MODIFY decodeServerSentEvents

Current (verified, :41): comment lines are dropped inside acceptLine.

Change (additive, backward-compatible — REVISED after A-gate: an
onActivity callback is insufficient because the decoder never yields for
comments, so consumers get no loop turn to observe activity).
DECIDED TYPE CONTRACT (A-gate round 2):
```ts
export type SseRecord =
  | { kind: "event"; event?: string; data: string }
  | { kind: "comment"; comment: string };
```
- Overloads: `decodeServerSentEvents(source, { signal? })` keeps returning
  `AsyncGenerator<ServerSentEvent>` (existing shape, existing callers
  unchanged — chat/outbound's unconditional `record.data` stays sound);
  `decodeServerSentEvents(source, { includeComments: true, signal? })`
  returns `AsyncGenerator<SseRecord>`.
- When includeComments is true, comment lines yield
  `{ kind: "comment", comment }` records and data records yield
  `{ kind: "event", ... }`. Blank keepalive lines without data stay
  non-yielding (no noise). Event dispatch semantics otherwise unchanged.

### 2. src/adapters/anthropic.ts — wire activity

At the decodeServerSentEvents call sites (:717, :740): opt into
includeComments and translate each yielded comment record into
`{ type: "heartbeat" }` so the bridge's adapter-activity clock resets.
This works because comment records now produce real loop turns (A-gate
fix). Rate: one heartbeat per comment record is acceptable (upstream
keepalives are typically 1/15-30s).

### 3. src/adapters/google.ts — wire activity

After phase 1's scanner remains line-based. DECIDED 5-tier line
classification (A-gate fold):
1. valid `data:` frame -> content events (existing WP1 behavior)
2. malformed `data:` JSON -> terminal error (existing WP1, unrelated to
   liveness)
3. `:`-prefixed comment line (non-empty) -> liveness tick; EXCLUDED from
   debugDroppedFrame (keepalives are not dropped frames); heartbeat only
   when the current read batch produced no content event
4. blank line -> counts as liveness (bare-newline keepalives), same
   one-heartbeat-per-batch cap
5. other garbage non-data lines -> liveness + debugDroppedFrame (existing
   WP1). Garbage resetting the stall clock is CORRECT semantics: the stall
   clock measures "are bytes flowing", while truncation judgment belongs
   to the EOF residual/terminal-signal checks — liveness cannot mask
   truncation.
EOF-residual rule (A-gate fold; also resolves the WP1 C-gate Low note):
a residual line at EOF that starts with `:` is consumed as a comment
(liveness, NOT a truncation error); any other non-data residual stays a
truncation error per WP1.

### 4. src/bridge.ts — verify heartbeat handling (:196 region)

AdapterEvent heartbeat must reset the same clock the stall timeout uses.
If the bridge currently only uses heartbeat for downstream keepalive,
extend it to also refresh the upstream-activity timestamp. This is a
verify-first item: read, then patch only if missing.

STALE-CHECK (WP4 P): VERIFIED — no patch needed. The bridge sets
`activity = true; stallTicks = 0;` at the top of every event-loop turn
(bridge.ts:452-453), before the event-type switch, so ANY AdapterEvent
(including `{ type: "heartbeat" }`, which hits the default case) resets
the upstream stall clock. Item 4 is therefore satisfied by items 1-3
producing heartbeat events; B only needs a regression test proving a
comment-only upstream keeps the stall timer from firing.
Anchors refreshed: anthropic has ONE decoder call site (anthropic.ts:740,
import :24); bridge stall machinery at :196-227.

### 5. src/server/relay.ts — relaySseWithHeartbeat (:324)

Correction (A-gate finding): NOT zero-caller — exported via the server
barrel (src/server/index.ts:87) and consumed by passthrough-abort.test.ts:2.
No production call site, but it is a tested public export.
Decision: KEEP the export in this phase (no removal, no wire change);
record the deprecation question as a maintainer note in the D summary.
This phase does not touch it.

## Accept criteria + activation scenarios

1. Anthropic stream sending only `: keepalive` comments for N seconds
   during reasoning -> bridge receives heartbeat events; no
   upstream_stall_timeout fires while comments flow. Activation:
   bridge-lifecycle test with a comment-only generator and a shortened
   stall budget; assert no incomplete is synthesized.
1a. Comment-only INFINITE stream: heartbeats continue indefinitely, no
   stall, no terminal (activation of the exact A-gate failure mode).
1b. Truly silent upstream (no bytes at all) -> stall timeout still fires
   (regression pin).
2. Google comment-only keepalive -> same contract.
3. sse-decoder tests: existing 42 stay green without includeComments; new
   tests prove comment records yield when opted in and never otherwise.
4. `bun run typecheck` green; focused suites green.

## Risks

- Extra heartbeat events are already part of the AdapterEvent contract
  (Cursor/Kiro emit them), so the bridge/downstream tolerate them.
- Removing a dead export is a public-surface no-op (no callers), but the
  A gate must confirm no docs/scripts reference relaySseWithHeartbeat.

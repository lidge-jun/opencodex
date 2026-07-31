# 051 — Phase 5a: Abort-race guard + run-turn queue hard cap

One PABCD cycle. Low-risk, dependency-first half of 050 (see the 050
overview for the DECIDED semantics). No bridge restructure here.

## Scope

IN:
- src/adapters/run-turn-queue.ts (bounded backlog option)
- src/server/responses/core.ts (queue cap wiring + cancelBodyOnAbort in
  the generic adapter fetch path)
- tests: run-turn-queue, a fault-injection abort-race test, cursor/
  runTurn consumer suites

OUT: bridge/chat-outbound pull restructure (052), passthrough relay.

## File change map

### 1. src/adapters/run-turn-queue.ts — MODIFY createAdapterEventQueue

Current (verified): `queued: AdapterEvent[]` unbounded; push hands off to
a waiting reader when present (readers.shift()) else `queued.push(event)`.

Change:
- New options param: `createAdapterEventQueue(opts?: { maxBacklog?:
  number; onBacklogExceeded?: () => void })`. Defaults: maxBacklog 1024,
  no callback = today's behavior.
- Count ONLY the buffered backlog (`queued.length`) — the readers.shift()
  direct-handoff path is a waiting consumer, so it correctly never counts
  (A-gate confirmed semantics).
- When a push would take the backlog past maxBacklog: invoke
  onBacklogExceeded() synchronously, then enqueue a terminal
  `{ type: "error", message: "consumer backlog exceeded — turn aborted" }`
  and close the queue. Later pushes are ignored by the existing closed
  guard.

### 2. src/server/responses/core.ts — MODIFY runTurn wiring (~1304)

Current (verified): `const runTurnAbort = new AbortController()` +
`const queue = createAdapterEventQueue()`.

Change:
- `createAdapterEventQueue({ onBacklogExceeded: () => runTurnAbort.abort() })`.

### 3. src/server/responses/core.ts — MODIFY generic adapter fetch path

Current (verified by A-gate): after the `if (!upstreamResponse.ok)`
recovery loop and BEFORE `parseStream(upstreamResponse)` (~:1633), the
body reader is not yet attached; a client abort landing in this window
produces the Bun unhandledRejection documented at abort.ts:126.

Change:
- Attach `cancelBodyOnAbort(upstreamResponse.body, upstream.signal)`
  immediately after the ok-check passes, and keep it for the TURN'S
  lifetime (unlike the web-search sidecar pattern which detaches after
  synchronous parsing — here the window extends to the first reader
  attach, and with 052's pull-driven loop it lengthens). Double-cancel is
  safe: the helper's internal `.catch(() => {})` absorbs locked/closed
  body rejections (abort.ts:139).

## Accept criteria + activation scenarios

1. Queue cap: a producer pushing past 1024 buffered events with no
   consumer triggers onBacklogExceeded, enqueues the terminal error, and
   the queue closes; a consumer reading afterwards sees buffered events
   then the error then stream end. Activation: scripted queue test.
2. Cap not reached with an active consumer: 2000 events with a reader
   attached -> no abort, ordering preserved (direct-handoff path).
3. runTurn unread-reader integration: core wiring fires runTurnAbort
   (assert abort signal state) when the cap trips.
4. Abort race: abort fired between fetch resolution and the first reader
   attach produces NO unhandledRejection and the body is cancelled.
   Activation: fault-injection test mirroring abort.ts:126's race (stub
   fetch + parseStream that attaches its reader late).
5. Regression: run-turn-queue, cursor suites, responses-state,
   bridge suites green; bun run typecheck green.

## Risks

- A pathological-but-legit fast producer (large thinking bursts) with a
  slow consumer could hit 1024: the cap is a safety valve, not a tuning
  target; 1024 events is ~MBs of SSE, far above any single burst.

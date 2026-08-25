# #820 session-lane bounds design

## Current facts

- `src/server/lifecycle.ts:32-40` owns a 256-turn global admission gate, an
  `AbortController -> ActiveTurnLease` map, and the admitted-lease set.
- `src/server/lifecycle.ts:160-218` admits a lease without logical-session metadata and
  lets that lease bind any number of abort controllers.
- `src/server/lifecycle.ts:205-215` releases controller mappings and the global gate only
  when the lease settles. `src/server/lifecycle.ts:373-386` keeps that ownership through
  stream terminal/cancel cleanup.
- `src/server/index.ts:699-716` admits HTTP turns without passing request identity, so two
  overlapping recalls from the same thread are indistinguishable from independent turns.
- `src/server/request-log-conversation.ts:58-78` documents the available identity order:
  parent thread, true thread/Cursor conversation, then session; it also warns that a
  synthesized/shared session id must not coalesce distinct conversations.
- `devlog/_fin/260801_zero_leak_state_stores/035_plan.md:672-683` explicitly deferred #820
  scheduler/session-lane architecture.
- `src/server/lifecycle.ts` is a core-path module and therefore may not directly or
  transitively import `src/lab/` (`AGENTS.md:21-52`).

## Scope and exclusions

This unit adds fail-fast logical-session lanes to the existing lifecycle admission
boundary and a deterministic 32/64-session recall harness. It does not add a scheduler,
same-session queue, weighted memory permits, account-load routing, relay redesign, or Lab
dependency. Missing/unsafe session identity remains an independent request lane rather
than risking false cross-session serialization.

## Structural decision

### Context

The global gate bounds total active turns, but controller-keyed ownership cannot enforce
the protocol rule that one logical session has at most one active model turn. Retaining raw
session headers as map keys would also make lane metadata proportional to caller-controlled
header length.

### Rejected alternatives

- Key directly by `AbortController`: current behavior; it cannot recognize a second recall
  for the same logical session.
- Queue a second same-session turn: issue #820 specifies zero queued turns by default and a
  full scheduler was explicitly deferred.
- Store raw header/session values: this makes retained lane memory input-sized and exposes
  sensitive identifiers through diagnostics.
- Derive identity inside `lifecycle.ts` from `Request`: this couples the generic lifecycle
  owner to HTTP and does not cover WebSocket frame lanes cleanly.

### Chosen move

Add a fixed-size opaque `SessionLaneId` derived at ingress from the strongest safe request
identity. `tryAdmitTurn(laneId?)` atomically claims the lane before acquiring the existing
global permit and releases it idempotently with the lease. No identity means no shared lane.
The lane registry stores only fixed-size digests and exposes count/high-water/rejection
metrics, so retained metadata is bounded by the already-bounded active-turn population and
fixed bytes per lane.

The HTTP listener derives the lane synchronously before handler work. WebSocket response
frames retain that fixed-size lane from their upgrade request without introducing an
`await` in server startup. The dependency direction remains `server/index -> lifecycle`;
`lifecycle` does not import request parsing or optional subsystems.

### Consequences

- Independent lanes remain parallel up to the existing global cap; overlapping turns on
  one identified lane fail with the existing structured `server_busy` response.
- Lane identifiers are process-local opaque digests; raw session/thread values are neither
  retained nor reported.
- Anonymous requests retain current independent-turn behavior because guessing identity
  would be less protocol-safe than leaving them uncoordinated.
- This is admission, not scheduling: there are no waiters and no queue memory.

## Harness contract

The harness drives 32 sustained and 64 burst independent lane sessions through actual
lifecycle leases and canonical tool-call event/SSE translation. Each session performs a
model tool-call terminal, external tool-result recall, and a second model terminal while
barriers keep all sessions concurrent. It asserts:

- all independent sessions are simultaneously admitted;
- a same-lane overlapping recall is rejected and never queued;
- call/item/output indexes and tool namespace/name/arguments remain session-local;
- all leases and lane bytes return to zero after each wave;
- lane high-water bytes are a fixed linear envelope at 32 and 64 sessions.

The memory oracle uses lifecycle-owned byte accounting as the deterministic bound and also
records Bun RSS/heap/external/array-buffer deltas as observational measurements. Removing
the fixed lane bound must make the deterministic memory assertion fail; RSS alone is not a
valid mutation oracle because allocator retention is nondeterministic.

## Verification and falsification

```bash
bun test tests/session-lane-recall-harness.test.ts
bun x tsc --noEmit
bun test tests/core-lab-boundary.test.ts tests/*lifecycle*.test.ts \
  tests/*translator-budget*.test.ts tests/session-lane-recall-harness.test.ts
```

For every new behavioral test, temporarily revert the production hunk it covers, run the
focused test and record its failing tail, then restore the hunk and rerun green. The memory
test must additionally be mutated to remove/expand the fixed per-lane accounting bound and
must fail on its independent expected envelope.

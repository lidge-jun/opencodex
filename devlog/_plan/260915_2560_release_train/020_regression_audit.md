# wp3 — regression audit of v2.55.0..dev

## Method

Seven `gpt-5.6-sol` subagents at medium reasoning effort, dispatched in parallel, one per slice.
Each reads committed objects (`git show <sha>:<path>`, `git diff <sha>^ <sha>`) rather than the
working tree, because the tree was being rebased concurrently for wp2. None runs tests: the local
suite is forbidden for this unit, so the instrument is source reading and the verdict is stated as
CLEAN / RISK / REGRESSION with file and line.

## Slices

| Slice | Target |
| --- | --- |
| core.ts facade split | `485a525aa9` — export surface, moved guards, duplicated module state, import cycles, the synchronous activation window. |
| server/index.ts facade split | `a63a47363f` — `labActivationRequired` gate, synchronous `startServer`, slot registration order. |
| bridge.ts facade split | `11f1119718` — export surface, SSE assembly, usage accounting, shared watchdog state. |
| reasoning summary fix | `369be813c4` — in-place mutation of stored/replayed items, scope, coverage. |
| test-side changes | `3ea88f3db8`, `89bc67353c` — is the new guard vacuous; is the destructive-home path fully closed. |
| #4683 itself | the gate allowlist and the 24h retention, attacked rather than confirmed. |
| release readiness | version agreement, stale doc references, `scripts/release.ts` and `release.yml` expectations, unowned `src/` areas. |

## Findings

Recorded as they return; a REGRESSION blocks wp4, a RISK is either fixed or accepted with a reason
written here.

- bridge.ts facade split (`11f1119718`): **CLEAN**. Facade re-exports all six symbols; SSE, JSON
  builders and the error formatter are byte-identical; the watchdog state remains a single live
  module binding consumed by `src/bridge/sse.ts`; error, incomplete, EOF, stall and cancellation
  paths unchanged.

- core.ts facade split (`485a525aa9`): **CLEAN**. All prior exports present; 23 runtime helpers and
  two interfaces AST-identical; combo execution differs only by injected dispatcher wiring; replay
  gates intact in `request-prepare.ts`; mutable adapter/retry/continuation state still shared
  through accessors; no reverse cycle, no duplicated module state.
- server/index.ts facade split (`a63a47363f`): **CLEAN**. `startServer` still synchronous, Lab
  still behind `labActivationRequired` and activated before return, slot registration synchronous,
  startup side-effect order and facade exports preserved.
- reasoning summary fix (`369be813c4`): **CLEAN**. Builds a new input array and clones changed
  items before adding `summary`, so cached and replayed objects are not mutated; existing
  summaries and opaque blobs untouched; scope limited to Responses serialization and native
  compact forwarding; regression coverage exists.
- test-side changes (`3ea88f3db8`, `89bc67353c`): **RISK, accepted**. The #4681 fix itself is
  sound — the quota test now pins and deletes only its own temporary home. Two guards have
  false-negative gaps: the lab synchrony scan stops at direct `startServer` callees, so an async
  `installLabAutomationRuntime` would pass, and the destructive-home guard matches only same-line
  `rmSync(getConfigDir())` forms. Neither is a runtime regression and neither is new in this
  range, so they do not block 2.56.0; they are follow-up hardening.
- #4683 (`4e548b693c`): **RISK, fixed**. The original allowlist let kiro, cursor and devin accept
  a delta after a replay miss. Verified in source that all three rebuild the conversation from the
  request they are handed — devin sends `mapOcxMessagesToDevin(parsed)` every turn, cursor's
  `checkpointRef` is read from the store that just expired and otherwise falls back to
  `full-replay`, kiro rebuilds `conversationState.history` from the parsed turns. The allowlist is
  now empty and the four-wire refusal is pinned by test. The 24h retention adds no unbounded path:
  the 1000-entry, 64 MiB resident and 1 GiB spill ceilings still bind, oldest-first.
- release readiness: **RISK, folded into the plan**. `release.yml` refuses to publish while
  `dev` does not outrank the release version, so the `dev-version-bump` pre-move is a required
  step and is now written into `030_release.md`. Separately, `docs-site` architecture pages and
  `structure/runtime.md` still describe the pre-split ownership; that is documentation drift
  across locales, not a runtime regression, and is tracked as follow-up rather than a release
  blocker.

## WebSocket idle timeout — why the TTL does the work

A codex-rs client caches its `WebsocketSession` across turns and chains `previous_response_id`
onto it, clearing that chain only when it finds the socket closed. This proxy sets
`WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0`, so the socket never closes on its own and the client's own
recovery never fires. Closing the socket instead of refusing the turn was considered and rejected:
Bun refuses a websocket `idleTimeout` above 960 seconds (measured, not inferred), so "close after
an hour" is not expressible as a serve option; one value covers every socket kind including the
live sideband relay; and it would not help HTTP clients, a restarted proxy, or an entry evicted
early by the byte caps. The refusal path covers all of those uniformly, so the timeout stays 0 and
the coupling is recorded where the constant lives, with
`tests/responses/ws-endpoint.test.ts` holding the pair together.

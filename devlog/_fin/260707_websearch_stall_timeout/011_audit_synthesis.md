# 011 — A-gate audit synthesis (REVIEW-SYNTHESIS-01)

Reviewer: gpt-5.5 explorer 019f3cb8-9975-7b00-96a8-810edce1fe2c. Verdict: FAIL (2 blockers, 2 warns).

## Per-blocker RCA + decisions

- **B1 (silent spans chain) — ACCEPT.** Batched queries run sequentially inside ONE begin/end
  cell (loop.ts:308-365): silent span up to maxSearches*sidecarTimeoutMs. Placeholder-only search
  turns (empty/repeat/limit, loop.ts:302-313) emit NO events, so consecutive non-streaming
  iterations chain up to (maxSearches+1)*connectTimeoutMs of silence. Plan's max(unit budgets)
  formula undercounted.
- **B2 (tests/docs encode wrong default 230s; conservative formula = 830s, too blunt) — ACCEPT,
  resolved via B1 fix choice.**
- **Decision (reviewer-preferred option, adopted):** emit adapter-level `{ type: "heartbeat" }`
  events at loop seams. Bridge treats ANY yielded adapter event as activity (bridge.ts:371-373
  sets activity=true before the switch; heartbeat arm emits nothing) and this is already
  activation-tested (tests/bridge.test.ts:295,308). Seams: (a) before each runIteration for i>0,
  (b) before each query inside runSearchCall (covers sequential batch + placeholder outcomes).
  With seams, every silent span is bounded by ONE unit budget -> original formula
  max(configured, connect, sidecar)+30 (default 230s) is correct again.
- **W3 (activation grounding) — ACCEPT.** Add a loop-level behavioral test: thread a small
  stallTimeoutSec through runWithWebSearch deps with a never-resolving sidecar fetch; assert the
  SSE ends with response.incomplete reason=upstream_stall_timeout (proves deps->bridge wiring
  fires, ~2-4s wall clock using the bridge's 2s tick).
- **W4 (heartbeat wording) — ACCEPT.** RCA distinguishes bridge-enqueued `response.heartbeat`
  frames (do NOT reset stall; bridge.ts:196 bypasses emit) from adapter-yielded heartbeat events
  (DO reset stall). 000_plan.md corrected.
- **Cross-blocker conflict:** none — B2 dissolves once B1 is fixed by seam heartbeats.
- **INFO 6:** keep WebSearchLoopDeps.stallTimeoutSec OPTIONAL so existing direct call sites
  (tests/web-search.test.ts:165, tests/sidecar-abort.test.ts:54, e2e-style:104) keep compiling.

## Round 2 (same reviewer, delta re-verification)

Verdict: FAIL (1 new blocker) — seam placements confirmed correct for both round-1 chains
(INFO 3), heartbeat variant confirmed `{ type: "heartbeat" }` src/types.ts:192 (INFO 2).

- **B3 (429 rotation chain) — ACCEPT.** `runIteration`'s key-failover while-loop
  (loop.ts:260-268) awaits N bounded fetches with no yield point; N slow 429s could exceed
  connectTimeoutMs. Fix: §2c generator refactor — `runIterationEvents` yields a heartbeat between
  retry fetches; produce() re-yields into the bridge; the eager pre-bridge first iteration drains
  and discards (stall deadline not armed before bridge creation, per W4).
- **W4 — ACCEPT.** Do not claim response.created protects the eager first iteration; it runs
  before bridgeToResponsesSSE exists, so the bridge stall deadline simply is not armed there.
- **W5 — ACCEPT.** Behavioral test uses stallTimeoutSec: 1 (bridge clamps to >=1s, 2s tick).

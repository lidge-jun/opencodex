# 012 — Build/Check record (D evidence)

Terminal outcome: DONE.

### src/web-search/index.ts — stall computation
- **Changes**: `webSearchStallTimeoutSec(configuredSec, connectTimeoutMs, sidecarTimeoutMs)` =
  max(configured ?? 90, ceil(connect/1000), ceil(sidecar/1000)) + 30; `SidecarPlan.stallTimeoutSec`;
  planWebSearch computes it (connect default 200_000 mirrors server threading).
- **Impact**: src/server/responses.ts (consumes plan), tests.
- **Verification**: tests "web-search stall deadline" — 230 (defaults), 630 (configured 600),
  120 (30s budgets); helper cases.

### src/web-search/loop.ts — deps threading + seam heartbeats
- **Changes**: `WebSearchLoopDeps.stallTimeoutSec?` passed into bridge options;
  `runIteration` -> `runIterationEvents` async generator (yields `{type:"heartbeat"}` between 429
  rotation fetches); `runIterationDrained` for the eager pre-bridge first iteration (discards
  heartbeats — stall not armed pre-bridge); produce() consumes manually (re-yields heartbeats,
  captures generator RETURN split) + seam heartbeat before each i>0 iteration; runSearchCall
  yields a seam heartbeat at the top of each per-query pass (sequential batch + placeholder paths).
- **Impact**: bridge stall watchdog now sees activity at every unit boundary; silent spans are
  bounded by ONE unit budget, making the 230s default sound (audit 011 B1/B3).
- **Verification**: behavioral test threads stallTimeoutSec:1 with a hung sidecar ->
  `response.incomplete` reason `upstream_stall_timeout` (proves deps->bridge wiring fires);
  existing 429-rotation and batch tests still green.

### src/server/responses.ts — threading
- **Changes**: `stallTimeoutSec: wsPlan.stallTimeoutSec` added to runWithWebSearch deps (parity
  with normal paths at 442/577 which thread config.stallTimeoutSec).
- **Verification**: tsc + suite.

### structure/04_transports-and-sidecars.md — SoT sync
- **Changes**: replaced stale "150 ticks = 5 minutes" with real semantics (90s default,
  `stallTimeoutSec` config, bridge frames vs adapter heartbeat events) + web-search widened
  deadline + seam heartbeats paragraph.

### Gates (fresh, 2026-07-07)
- `bun test ./tests/` -> **1632 pass, 0 fail**, 7228 expects, 168 files, 26.80s, exit 0.
- `bun x tsc --noEmit` -> exit 0.

### Audit trail
- A-gate reviewer: gpt-5.5 (agent 019f3cb8...), 3 rounds FAIL/FAIL/PASS — see 011_audit_synthesis.md.
- codex-rs semantics: gpt-5.5 explorer report — see 001_codexrs_timeout_report.md. Codex retries
  `upstream_stall_timeout` as a retryable Stream error ("Reconnecting... n/max"), which previously
  re-ran the whole search loop and could re-kill — the widened deadline removes the false trigger.

### LOOP-PESSIMIST / residual notes
- NOT improved: sidecar wall-clock latency itself (searches still up to 200s each, sequential).
  Follow-up candidates recorded in 000_plan.md (parallel batch queries; streaming iterations).
- 429-rotation silent chain was already bounded by the iteration-wide AbortSignal.timeout on the
  plain-fetch path; the §2c seam matters for adapters with own fetchResponse timeout handling
  (belt-and-suspenders, cheap).
- Evidence that would falsify the fix: a real turn still dying with upstream_stall_timeout at
  <230s, or codex-side termination with heartbeats flowing (would contradict 001 report).

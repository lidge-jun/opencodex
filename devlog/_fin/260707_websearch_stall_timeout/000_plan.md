# 000 — Web-search sidecar stall-timeout RCA + unit plan

## Loop-spec header (C3, single work-phase)

- **Loop archetype**: spec-satisfaction repair (verifier = bun test + tsc + doc sync).
- **Trigger**: user report — web-search sidecar turns "structurally take too long" and get killed
  by a time limit mid-turn.
- **Goal**: a legitimately slow-but-bounded web-search turn (searches up to `timeoutMs`, model
  iterations up to `connectTimeoutMs`) never trips the bridge stall deadline; genuine hangs still
  get cut off finitely.
- **Non-goals**: streaming refactor of loop iterations, heartbeat mechanics changes in bridge.ts,
  sidecar model/reasoning default changes, batch-query parallelization (recorded as follow-up),
  codex-rs changes (read-only reference).
- **Verifier**: `bun test ./tests/` exit 0, `bun x tsc --noEmit` exit 0, new planWebSearch unit
  tests assert the computed stall deadline.
- **Stop condition**: acceptance criteria in goal met, or LOOP-REPAIR-01 escalation.
- **Memory artifact**: this unit (`devlog/_plan/260707_websearch_stall_timeout/`).
- **Expected terminal outcome**: DONE in one PABCD cycle.
- **Escalation condition**: fix requires changing user-visible config semantics beyond threading
  existing options -> NEEDS_HUMAN.
- **HOTL resource bounds**: local tools only (rg/bun/tsc/apply_patch); write scope = files below +
  this unit + .codexclaw state; wall clock ~40min; no external network.

## RCA (evidence)

The user-visible kill is opencodex's OWN bridge stall deadline, not codex-rs:

- `src/bridge.ts:171` — `const stallSec = Math.max(1, options?.stallTimeoutSec ?? 90)`; when no
  REAL adapter event arrives for `stallSec`, bridge emits `response.incomplete`
  (`incomplete_details.reason = "upstream_stall_timeout"`) and closes (`src/bridge.ts:176-196`).
  Bridge-enqueued `response.heartbeat` FRAMES do NOT reset `stallTicks` (bridge.ts:196 bypasses
  `emit()`); adapter-YIELDED `{ type: "heartbeat" }` events DO (bridge.ts:371-373 sets
  `activity = true` for every adapter event) — that is the seam-heartbeat lever (010 §2b).
- `src/web-search/loop.ts:426-435` — the web-search path calls `bridgeToResponsesSSE` WITHOUT
  `stallTimeoutSec`, so it always runs at the 90s default. Even a user-configured
  `config.stallTimeoutSec` never reaches this path.
- `src/server/responses.ts:474-484` — `runWithWebSearch` deps carry `connectTimeoutMs`
  (`config.connectTimeoutMs ?? 200_000`) but not `config.stallTimeoutSec`; the normal routed and
  passthrough paths DO thread it (`responses.ts:442`, `responses.ts:577`).
- Silent-but-bounded work inside the loop exceeds 90s by design:
  - one sidecar search: `DEFAULT_TIMEOUT_MS = 200_000` (`src/web-search/index.ts`), awaited
    with no events between `web_search_call_begin` and `web_search_call_end`
    (`src/web-search/loop.ts` runSearchCall);
  - one NON-streaming model iteration: bounded by `connectTimeoutMs` (200s default), zero adapter
    events until the full response parses (`runIteration`);
  - multi-query batches run queries SEQUENTIALLY (runSearchCall for-loop), stacking latencies.
- codex-rs side is NOT the killer: `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`
  (`/Users/jun/Developer/codex/120_codex-cli/codex-rs/model-provider-info/src/lib.rs:26`), and the
  idle timer is re-armed by ANY SSE event incl. parser-ignored `response.heartbeat` (2s cadence
  from bridge). gpt-5.5 explorer verification report: `001_codexrs_timeout_report.md`.
- Stale doc: `structure/04_transports-and-sidecars.md` claims "150 ticks = 5 minutes" stall
  deadline; code says 90s default, configurable.

## Fix shape

Compute an effective stall deadline for the web-search path that covers its own bounded units:

```
effectiveStallSec = max(config.stallTimeoutSec ?? 90,
                        ceil(connectTimeoutMs / 1000),
                        ceil(sidecar timeoutMs / 1000)) + 30 (margin)
```

Valid ONLY together with seam heartbeats (010 §2b) so every silent span is bounded by ONE unit
budget (audit 011 B1: batched queries + placeholder iterations otherwise chain silence).
Default config -> max(90, 200, 200) + 30 = 230s. Finite, so genuine hangs still terminate
(each awaited unit carries its own AbortSignal.timeout; silence beyond the max unit budget +
margin is a real hang). Codex-side 300s idle timer keeps being re-armed by 2s heartbeats, so a
larger opencodex stall deadline is safe.

Computation lives in `planWebSearch` (pure, already unit-tested) and returns via
`SidecarPlan.stallTimeoutSec`; responses.ts and loop.ts just thread it. Diff-level plan:
`010_phase1_stall_fix.md`.

## Follow-ups recorded (out of scope)

- Parallelize multi-query batches in `runSearchCall` (budget + failedQueries accounting makes it
  non-trivial; separate unit if wanted).
- Consider streaming loop iterations to surface deltas as activity.
